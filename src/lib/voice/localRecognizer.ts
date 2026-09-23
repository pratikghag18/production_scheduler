/**
 * S57-a (brief docs/agent-briefs/s57-a-whisper-brief.md §3-4, design-plan
 * §19.102 / D131) — a second `Recognizer` (the exact shape
 * `src/lib/voice/recognizer.ts` gives `CommandBar`), talking to whisper.cpp's
 * server instead of the browser's Web Speech API. Whisper is batch, not
 * streaming (D131 §2): the session records from the microphone, decides for
 * itself when the clip is over (a floor on loudness, never the service), then
 * posts one WAV and reports the one answer it gets back.
 *
 * `deps` is the same seam `recognizer.ts` has none of, because the Web
 * Speech API has no inputs worth faking beyond the constructor -- this
 * recogniser touches the microphone, an audio graph, the clock and the
 * network, so every one of those is swappable for a test (`localRecognizer
 * .test.ts`) that never opens a real microphone.
 */
import { encodeWav16k, rmsOf } from "./wav";
import type { ClipInfo, Recognizer, RecognizerEvents, RecognizerHandle } from "./recognizer";

// ---- the DOM surface used here, typed just enough to use it (recognizer.ts
// does the same for the Web Speech API: "just enough of it to read results
// and errors and to start/stop a session") ----

interface MediaStreamTrackLike {
  stop(): void;
}

interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[];
}

interface AudioNodeLike {
  connect(destination: AudioNodeLike): void;
  disconnect(): void;
}

interface GainNodeLike extends AudioNodeLike {
  gain: { value: number };
}

interface AudioProcessingEventLike {
  inputBuffer: { getChannelData(channel: number): Float32Array };
}

interface ScriptProcessorNodeLike extends AudioNodeLike {
  onaudioprocess: ((event: AudioProcessingEventLike) => void) | null;
}

interface AudioContextLike {
  readonly destination: AudioNodeLike;
  /** Review finding: needed to detect the default-rate fallback below --
   *  when `createAudioContext({ sampleRate: TARGET_SAMPLE_RATE })` was
   *  refused (see `startRecording`), the context that DID open runs at
   *  whatever rate the platform gave it, read back here so `transcribe()`
   *  knows whether a resample pass is needed. */
  readonly sampleRate: number;
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike;
  createScriptProcessor(
    bufferSize: number,
    numberOfInputChannels: number,
    numberOfOutputChannels: number,
  ): ScriptProcessorNodeLike;
  createGain(): GainNodeLike;
  close(): void | Promise<void>;
}

// ---- the offline resample path (review finding, brief §3 point 3's own
// question: "what if the browser refuses [16 kHz]... is there a fallback
// ... or a clear error? If neither, add the simplest: open at default,
// resample with an OfflineAudioContext"). Safari and Firefox on some
// devices throw `NotSupportedError` from `new AudioContext({ sampleRate })`
// for a rate their hardware does not natively support; the code below this
// used to let that exception escape a promise `.then()` handler with
// nothing downstream to catch it -- an unhandled rejection, no onError, no
// onEnd, the microphone left open and the bar stuck on "Listening...".
// `startRecording` now falls back to the default rate and resamples here. ----

interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

interface AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null;
  connect(destination: unknown): void;
  start(when?: number): void;
}

interface OfflineAudioContextLike {
  readonly destination: unknown;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  startRendering(): Promise<AudioBufferLike>;
}

export interface LocalRecognizerDeps {
  getUserMedia(constraints: {
    audio: { echoCancellation: boolean; noiseSuppression: boolean };
  }): Promise<MediaStreamLike>;
  /** A factory, not a constructor -- brief §3: "an AudioContext factory".
   *  `options.sampleRate` is the direct-16kHz choice below (§3 point 3). */
  createAudioContext(options?: { sampleRate?: number }): AudioContextLike;
  /** Review finding: the default-rate fallback's resample pass. Only called
   *  when the context did not open at `TARGET_SAMPLE_RATE`. */
  createOfflineAudioContext(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): OfflineAudioContextLike;
  fetch: typeof fetch;
  /** The clock. Every silence/cap decision below reads elapsed time through
   *  this, never `Date.now()` directly, so a test drives 1500ms/12000ms of
   *  "time" by advancing a fake clock between synthetic frames instead of
   *  waiting on one. */
  now(): number;
}

function defaultGetUserMedia(constraints: {
  audio: { echoCancellation: boolean; noiseSuppression: boolean };
}): Promise<MediaStreamLike> {
  return navigator.mediaDevices.getUserMedia(constraints);
}

function defaultCreateAudioContext(options?: { sampleRate?: number }): AudioContextLike {
  const w = window as unknown as {
    AudioContext?: new (opts?: { sampleRate?: number }) => AudioContextLike;
    webkitAudioContext?: new (opts?: { sampleRate?: number }) => AudioContextLike;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error("localRecognizer: no AudioContext in this window");
  return new Ctor(options);
}

function defaultCreateOfflineAudioContext(
  numberOfChannels: number,
  length: number,
  sampleRate: number,
): OfflineAudioContextLike {
  const w = window as unknown as {
    OfflineAudioContext?: new (nc: number, len: number, sr: number) => OfflineAudioContextLike;
    webkitOfflineAudioContext?: new (
      nc: number,
      len: number,
      sr: number,
    ) => OfflineAudioContextLike;
  };
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctor) throw new Error("localRecognizer: no OfflineAudioContext in this window");
  return new Ctor(numberOfChannels, length, sampleRate);
}

function defaultDeps(): LocalRecognizerDeps {
  return {
    getUserMedia: defaultGetUserMedia,
    createAudioContext: defaultCreateAudioContext,
    createOfflineAudioContext: defaultCreateOfflineAudioContext,
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
  };
}

/** Renders `samples` (captured at `fromRate`) through an `OfflineAudioContext`
 *  opened at `TARGET_SAMPLE_RATE` -- the Web Audio spec resamples a buffer
 *  source automatically when its buffer's rate differs from the rendering
 *  context's, so this is the "simplest" fallback the brief asks for: no
 *  resampling math of our own, the platform's own resampler does it. An
 *  empty clip renders nothing (no-speech is handled before this is ever
 *  called, but a zero-length input is still answered safely). */
async function resampleTo16k(
  samples: Float32Array,
  fromRate: number,
  createOfflineAudioContext: LocalRecognizerDeps["createOfflineAudioContext"],
): Promise<Float32Array> {
  if (samples.length === 0) return samples;
  const targetLength = Math.max(1, Math.ceil((samples.length * TARGET_SAMPLE_RATE) / fromRate));
  const offline = createOfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
  const buffer = offline.createBuffer(1, samples.length, fromRate);
  buffer.getChannelData(0).set(samples);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// ---- tuning constants (brief §3 point 2) ----

/** RMS above this is "speech" in a frame. */
const RMS_FLOOR = 0.02;
/** How many consecutive above-floor (`RMS_FLOOR`) frames start a clip's
 *  speech when no single frame alone is loud enough (`SPEECH_ON_LOUD_FRAME_RMS`
 *  below) -- the ORIGINAL rule, restored after the review finding below.
 *
 *  F-198 (22 Sept, the spoken walk): a `BUFFER_SIZE` frame is 4096 samples
 *  at `TARGET_SAMPLE_RATE` (16 kHz) -- 0.256s. This was 2, so speech never
 *  "started" until 2 * 0.256s = 0.512s of SUSTAINED above-floor audio had
 *  been seen; a one-syllable "yes" or "no" is shorter than that, so the
 *  clip ran to `MAX_CLIP_MS` and `finalize` raised `no-speech` without ever
 *  posting the audio -- the trace (`data/voice/trace/bar.jsonl`,
 *  2026-09-22T19:42-19:45Z) shows exactly this, five times running.
 *
 *  Dropping this to 1 (a single frame at `RMS_FLOOR` starts speech) fixed
 *  that, but the reviewer found it reintroduces a false start `SPEECH_ON_FRAMES
 *  = 2` had accidentally been guarding against: a keyboard click, a door, or
 *  the mic button's own click transient is a few milliseconds of energy
 *  inside one 256ms frame, and synthesizing several against the real
 *  `rmsOf` measured a keyboard click at RMS 0.0244, the mic button's own
 *  click at 0.0216, and a door thud at 0.0713 -- all above `RMS_FLOOR`
 *  (0.02), so a lone transient at session start used to set `speechStarted`
 *  immediately, anchoring the 1500ms silence-end timer to the CLICK rather
 *  than to real speech; traced against the exact state machine, a click at
 *  frame 0 followed by an ordinary ~1.8s reaction pause before the person
 *  actually spoke finalized the clip (via `SILENCE_END_MS`) BEFORE their
 *  real word ever arrived, silently dropping the answer -- a new shape of
 *  the same F-198 bug.
 *
 *  The fix keeps both rules at once (maintainer decision, 22 Sept): a
 *  single frame starts speech immediately only when it is unambiguously
 *  voice-loud (`SPEECH_ON_LOUD_FRAME_RMS`, well above any measured click or
 *  door but comfortably under real speech's 0.12-0.39 RMS); otherwise this
 *  constant's original two-consecutive-frame rule applies; and frame index
 *  0 -- where the mic button's own transient lives -- is barred from
 *  starting speech alone under EITHER rule (see `handleFrame`), though it
 *  still counts as the first of a two-consecutive-frame pair. */
const SPEECH_ON_FRAMES = 2;
/** Review finding (F-198, maintainer decision 22 Sept): a single frame at or
 *  above this RMS starts speech immediately, without waiting for a second
 *  consecutive frame -- chosen to sit above every synthesized transient
 *  measured against the real `rmsOf` (a keyboard click at 0.0244, the mic
 *  button's own click at 0.0216, a door thud at 0.0713) and well under the
 *  real spoken-word band `jfk.wav` gave (0.12-0.39 RMS), so an ordinary
 *  loud "yes" or "no" still starts speech on its first frame while a click
 *  or a door cannot. Frame index 0 is excluded from this rule entirely (see
 *  `handleFrame`) -- the mic button's own transient lives there, and no
 *  measured margin is safe against a click captured AT the button press
 *  itself, only against one after it. */
const SPEECH_ON_LOUD_FRAME_RMS = 0.08;
/** F-198: when the twelve-second cap (`MAX_CLIP_MS`) is reached and speech
 *  never "started" (every frame stayed at or under `RMS_FLOOR`), the clip
 *  is sent to Whisper anyway if any frame's RMS came within this factor of
 *  the floor -- a quiet answer spoken a little too far from the mic to
 *  cross `RMS_FLOOR` outright, rather than true silence. `RMS_FLOOR *
 *  QUIET_SEND_FACTOR` = 0.015, chosen against the same `jfk.wav` room-tone
 *  measurement: its quiet stretches ran 0.0088-0.0127 RMS per 4096-sample
 *  frame (max observed 0.0127), so 0.015 sits above that ceiling with
 *  margin -- true silence never crosses it -- while still under
 *  `RMS_FLOOR` itself, catching a frame that is audibly louder than the
 *  room but not loud enough to trigger normal speech-start. A clip whose
 *  every frame stays under 0.015 is still `no-speech`; CLAUDE.md's own
 *  rule holds regardless -- an empty transcript from Whisper still reads
 *  "Nothing was heard", the service's own answer, never a guess made here.
 *
 *  Review finding (F-198, reviewed 22 Sept): "an empty transcript" is not
 *  what whisper.cpp actually returns for a long quiet clip. Tested against
 *  the running `scheduler-whisper` container (127.0.0.1:8090/inference,
 *  whisper.cpp's own server): a full `MAX_CLIP_MS` (12s) clip at a uniform
 *  quiet amplitude (rms ~0.010, well under `RMS_FLOOR`) came back
 *  `" (clippers buzzing)\n"` -- an invented, non-empty sentence -- in 2/2
 *  trials, and a 9s clip at the same amplitude did too (2/2). The SAME
 *  amplitude at 1.5s, 3s and 6s came back genuinely empty text (2/2 each).
 *  Literal digital silence (all-zero samples) came back `" [BLANK_AUDIO]\n"`
 *  -- also non-empty. Posting the FULL captured clip (as this code did
 *  before this finding) crosses that 6s-9s knee on every ordinary use of
 *  this path, because `MAX_CLIP_MS` is 12s; `QUIET_CLIP_PAD_FRAMES`/
 *  `QUIET_CLIP_MAX_FRAMES` below trim what is actually posted to a short
 *  window around the frame(s) that set `hadQuietSound`, comfortably under
 *  the observed knee, so this path keeps the chance of catching a
 *  genuinely quiet answer without feeding Whisper the many seconds of
 *  surrounding silence that made it invent text. */
const QUIET_SEND_FACTOR = 0.75;
/** Review finding (F-198): frames of padding kept on each side of the
 *  quiet-sound window `finalize`'s cap-reached branch sends, ~1.024s each
 *  side (see `QUIET_SEND_FACTOR`'s own note for the measurement). */
const QUIET_CLIP_PAD_FRAMES = 4;
/** Review finding (F-198): the most frames (~3.072s) the cap-reached
 *  quiet-send path will ever post, regardless of how far apart the first
 *  and last quiet-band frame were -- comfortably under the 6s-9s
 *  hallucination knee measured against the running container. */
const QUIET_CLIP_MAX_FRAMES = 12;
/** Silence after speech that ends the clip. */
const SILENCE_END_MS = 1500;
/** Absolute cap on a clip's length, spoken or not. */
const MAX_CLIP_MS = 12000;
/** §3 point 3: the context is opened at this rate directly -- jsdom has no
 *  real audio hardware to clamp it, and in a real browser a custom
 *  `sampleRate` on `AudioContext`'s constructor is honoured (unlike an
 *  `OfflineAudioContext`, no separate resample pass is needed once the
 *  context itself already produces 16 kHz frames). */
const TARGET_SAMPLE_RATE = 16000;
/** A `ScriptProcessorNode` buffer size (one of the API's fixed powers of
 *  two) -- picked over an `AudioWorklet` (brief §3 point 2: "pick the
 *  simpler that jsdom can be faked for, and say which"): an `AudioWorklet`
 *  needs a real worker thread and a module URL loaded through
 *  `audioContext.audioWorklet.addModule(...)`, which jsdom cannot run at
 *  all: there is no seam a test could fake it through short of faking the
 *  entire Worklet runtime. A `ScriptProcessorNode` is one more method on the
 *  same `AudioContextLike` fake already used for `createMediaStreamSource`/
 *  `createGain`, and its `onaudioprocess` callback is just a function a test
 *  calls directly with a synthetic `{ inputBuffer }` -- no worker, no
 *  module, no thread boundary to cross. */
const BUFFER_SIZE = 4096;

/** `VITE_WHISPER_URL`, trimmed, or `null` when unset/empty -- "no local
 *  recogniser" -- read the same way `readSentence.ts`'s `voiceServiceUrl()`
 *  reads `VITE_VOICE_URL` (brief §4).
 *
 *  Review finding: a trailing slash (a plausible `.env.local` typo --
 *  `VITE_WHISPER_URL=/whisper/` -- since the README's own example has none)
 *  used to survive into `baseUrl`, and `transcribe()` below builds the
 *  request as `` `${baseUrl}/inference` ``, so the request path came out
 *  `/whisper//inference` -- a double slash the dev proxy's rewrite does not
 *  collapse (it only strips the `/whisper` prefix), which whisper.cpp's
 *  server 404s on. One or more trailing slashes are stripped here, the one
 *  place every caller of `baseUrl` goes through. */
export function whisperServiceUrl(): string | null {
  const raw = import.meta.env.VITE_WHISPER_URL;
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * F-201: whisper.cpp's server hallucinates a non-speech TAG for a clip with
 * no words in it, never an empty string -- F-198's own review measured
 * `" (clippers buzzing)\n"` for a long quiet clip and `" [BLANK_AUDIO]\n"`
 * for literal digital silence (see `QUIET_SEND_FACTOR`'s note above); the
 * maintainer's 23 Sept walk hit a THIRD shape live, `"[Music]"`, between two
 * spoken sentences -- the bar read it as a heard sentence and the model
 * answered "unassign everyone on today", which ran as far as F-199's own
 * `-840` bug before that stopped it. whisper.cpp writes such tags in square
 * brackets or parentheses -- `[Music]`, `[BLANK_AUDIO]`, `(clippers
 * buzzing)`, `[inaudible]`, `(applause)` are the ones seen so far, but the
 * shape (a bracketed or parenthesised run with no real words in it) is the
 * rule, not this list. Every such run is stripped, whitespace is collapsed
 * and trimmed, and what is left is the words only -- a transcript that is
 * ONLY tags comes back `""`, exactly like whisper.cpp's own genuine empty
 * answer, so the caller's existing `text === ""` -> `no-speech` check
 * catches it with no second path to keep in sync. A transcript with real
 * words AND a tag (`"[Music] clear Cell 3 today"`) keeps the words. A
 * sentence with real brackets a person could actually say ("say the number
 * (2) twice") is not a concern this strips for -- nobody speaks a bracket.
 */
export function stripNonSpeechTags(text: string): string {
  return text
    .replace(/\[[^[\]]*\]/g, " ")
    .replace(/\([^()]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNotAllowedError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "NotAllowedError";
}

/**
 * `localRecognizer(baseUrl, deps?, hint?)` -- brief §3, and S59-c (brief
 * §2, design-plan §19.104 / D133 item 4). `deps` defaults to the window's
 * own microphone, audio context, `fetch` and clock; a test passes fakes for
 * all four. `hint`, when given, is called once per clip -- at transcribe
 * time in `transcribe()` below, never at construction -- so a board window
 * change (`BoardPage.tsx`'s own `commandCtx`) is picked up by the NEXT clip
 * without rebuilding the recogniser itself. A non-empty string it returns
 * is sent to whisper.cpp's server as the multipart field `prompt` (verified
 * against the running container, brief's own instruction: `curl -F
 * file=@… -F prompt="…" 127.0.0.1:8090/inference` measurably changes what
 * comes back); an absent `hint`, or one that returns `""`, sends no
 * `prompt` field at all -- whisper.cpp treats a present-but-empty prompt no
 * differently than none, so there is nothing to gain from sending it, and
 * the pin (`LREC-15`/`LREC-16`) checks the field is ABSENT, not empty.
 */
export function localRecognizer(
  baseUrl: string,
  deps?: Partial<LocalRecognizerDeps>,
  hint?: () => string,
): Recognizer {
  const d: LocalRecognizerDeps = { ...defaultDeps(), ...deps };

  return function recognize(events: RecognizerEvents): RecognizerHandle {
    // `ended` is this session's own generation guard (brief §3 point 5: "a
    // generation counter, as the bar has") -- everything below checks it
    // before touching `events` or the audio graph, so a callback that
    // arrives after `stop()` or after the clip's own natural end (a frame
    // still queued on the audio thread, a `fetch` that resolves late) is a
    // no-op, and `stop()` itself is a no-op once it is already true.
    let ended = false;
    let stopRequested = false;

    let stream: MediaStreamLike | null = null;
    let audioContext: AudioContextLike | null = null;
    let sourceNode: AudioNodeLike | null = null;
    let processorNode: ScriptProcessorNodeLike | null = null;

    const frames: Float32Array[] = [];
    let speechStarted = false;
    let consecutiveAbove = 0;
    let lastAboveFloorAt: number | null = null;
    let recordingStartedAt: number | null = null;
    // F-198: set when a frame's RMS reaches QUIET_SEND_FACTOR of the floor,
    // even though it never crossed the floor itself -- `finalize`'s
    // cap-reached branch reads this to decide whether a clip that never
    // "started" speech is a quiet answer (send it) or true silence (don't).
    let hadQuietSound = false;
    // Review finding (F-198): the index (into `frames`) of the first and
    // last frame that set `hadQuietSound` -- `finalize`'s cap-reached branch
    // trims what it posts to a window around these, never the whole clip
    // (see `QUIET_CLIP_PAD_FRAMES`/`QUIET_CLIP_MAX_FRAMES`'s own note).
    let firstQuietFrameIndex: number | null = null;
    let lastQuietFrameIndex: number | null = null;
    // Review finding: set from the ACTUAL context, once it opens (see
    // `startRecording`) -- `TARGET_SAMPLE_RATE` unless the platform refused
    // that rate, in which case this is whatever default rate it gave us and
    // `transcribe()` resamples before encoding.
    let recordedSampleRate = TARGET_SAMPLE_RATE;
    // S71-f (brief §1.A): `ClipInfo`'s own numbers, accumulated over the
    // WHOLE recording (every frame, whatever finally gets posted) -- never
    // reset by windowing, which only trims what `transcribe()` sends, not
    // what happened. NaN frames (LREC-14) are excluded from `peakRms`/
    // `meanRms` the same way they already fail `above` below, but still
    // count toward `frames.length`, the `meanRms` denominator.
    let peakRms = 0;
    let rmsSum = 0;
    let framesAboveFloorCount = 0;

    function teardown(): void {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
      }
      if (processorNode) {
        processorNode.onaudioprocess = null;
        try {
          processorNode.disconnect();
        } catch {
          // already disconnected
        }
        processorNode = null;
      }
      if (sourceNode) {
        try {
          sourceNode.disconnect();
        } catch {
          // already disconnected
        }
        sourceNode = null;
      }
      if (audioContext) {
        try {
          audioContext.close();
        } catch {
          // already closed
        }
        audioContext = null;
      }
    }

    async function transcribe(
      sourceFrames: Float32Array[],
      endedBy: ClipInfo["endedBy"],
    ): Promise<void> {
      let totalLength = 0;
      for (const frame of sourceFrames) totalLength += frame.length;
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const frame of sourceFrames) {
        merged.set(frame, offset);
        offset += frame.length;
      }
      // Review finding, brief §3 point 3: resample only when the context
      // did not open at 16 kHz directly (the ordinary case skips this).
      const forEncoding =
        recordedSampleRate === TARGET_SAMPLE_RATE
          ? merged
          : await resampleTo16k(merged, recordedSampleRate, d.createOfflineAudioContext);
      const wav = encodeWav16k(forEncoding, TARGET_SAMPLE_RATE);

      const form = new FormData();
      form.append("file", new Blob([wav], { type: "audio/wav" }), "clip.wav");
      form.append("response_format", "json");
      form.append("temperature", "0");
      form.append("language", "en");
      // S59-c (brief §2): read NOW, not at construction, so the current
      // board window's names reach this clip even when they changed after
      // the session started listening.
      const hintText = hint?.();
      if (hintText !== undefined && hintText !== "") {
        form.append("prompt", hintText);
      }

      // S71-f (brief §1.A): `sourceFrames` is a total-samples count at
      // `recordedSampleRate` (the actual audio hardware rate this session
      // captured at, whatever it is) -- dividing by that rate, not counting
      // clock ticks, gives the real duration of the audio regardless of how
      // large or small a caller's frames happen to be. `durationMs` is the
      // bytes actually posted (`sourceFrames`, windowed or not);
      // `recordedMs` is always the WHOLE recording (`frames`), per
      // `ClipInfo`'s own doc. Fired once, right before the fetch below, so
      // it fires whether or not that fetch ever succeeds -- "posted" means
      // sent, not answered.
      let recordedSamples = 0;
      for (const frame of frames) recordedSamples += frame.length;
      events.onClip?.({
        wav,
        durationMs: recordedSampleRate > 0 ? (totalLength / recordedSampleRate) * 1000 : 0,
        recordedMs: recordedSampleRate > 0 ? (recordedSamples / recordedSampleRate) * 1000 : 0,
        endedBy,
        speechStarted,
        peakRms,
        meanRms: frames.length > 0 ? rmsSum / frames.length : 0,
        framesAboveFloor: framesAboveFloorCount,
        hint: hintText !== undefined && hintText !== "" ? hintText : null,
      });

      let response: Response;
      try {
        response = await d.fetch(`${baseUrl}/inference`, { method: "POST", body: form });
      } catch {
        events.onError("other", "local recogniser not answering");
        events.onEnd();
        return;
      }
      if (!response.ok) {
        events.onError("other", "local recogniser not answering");
        events.onEnd();
        return;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        events.onError("other", "local recogniser not answering");
        events.onEnd();
        return;
      }

      const rawText =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { text?: unknown }).text === "string"
          ? (payload as { text: string }).text.trim()
          : "";
      // F-201: strip a hallucinated non-speech tag ("[Music]",
      // "[BLANK_AUDIO]", "(clippers buzzing)") before it ever reaches the
      // bar -- see `stripNonSpeechTags`'s own doc above.
      const text = stripNonSpeechTags(rawText);
      if (text === "") {
        events.onError("no-speech");
        events.onEnd();
        return;
      }
      events.onFinal(text);
      events.onEnd();
    }

    /** Ends the recording phase, whatever triggered it (brief §3 point 2:
     *  silence, the twelve-second cap, or `stop()` all reach here) -- design
     *  §19.102 D131's own wording: "ends the clip on a stop click, on a
     *  second and a half of silence after speech was heard, or at twelve
     *  seconds, THEN reports Transcribing... [and] posts the clip".
     *
     *  F-198: `capReached` is true only when the twelve-second cap itself
     *  triggered this call (`handleFrame` below) -- a quiet clip that never
     *  "started" speech is still sent in that one case, when it had some
     *  quiet sound in it (`hadQuietSound`); a manual `stop()` or any other
     *  path with no speech stays `no-speech`, matching LREC-6/LREC-12.
     *
     *  Review finding (F-198): what is posted in that branch is a WINDOW
     *  around `firstQuietFrameIndex`/`lastQuietFrameIndex`, padded by
     *  `QUIET_CLIP_PAD_FRAMES` and capped at `QUIET_CLIP_MAX_FRAMES` frames
     *  total -- never the full clip -- see `QUIET_SEND_FACTOR`'s own note
     *  for why (a full-length quiet clip measurably makes whisper.cpp
     *  invent text).
     *
     *  S71-f (brief §1.A): `reason` is which rule called this -- `"stop"`
     *  (the button, or a `stop()` that arrived while `getUserMedia` was
     *  still pending), `"silence"` (1500ms after speech), or `"cap"` (the
     *  twelve-second cap, whether or not speech had started) -- the caller
     *  always knows which, so this takes it rather than the boolean
     *  `capReached` used to guess from. Behaviour is unchanged: `reason ===
     *  "cap"` is exactly the old `capReached === true`. `ClipInfo.endedBy`
     *  is `reason` itself for a whole-clip send, and the fourth value,
     *  `"cap-window"`, only for the windowed quiet-send branch below --
     *  never a fifth kind of `finalize` call. */
    function finalize(reason: "stop" | "silence" | "cap"): void {
      if (ended) return;
      ended = true;
      teardown();
      if (!speechStarted) {
        if (reason === "cap" && hadQuietSound) {
          events.onInterim("Transcribing…");
          const start = Math.max(0, (firstQuietFrameIndex ?? 0) - QUIET_CLIP_PAD_FRAMES);
          const end = Math.min(
            frames.length,
            start + QUIET_CLIP_MAX_FRAMES,
            (lastQuietFrameIndex ?? 0) + QUIET_CLIP_PAD_FRAMES + 1,
          );
          const windowed = frames.slice(start, Math.max(end, start + 1));
          void transcribe(windowed, "cap-window");
          return;
        }
        events.onError("no-speech");
        events.onEnd();
        return;
      }
      events.onInterim("Transcribing…");
      void transcribe(frames, reason);
    }

    function handleFrame(frame: Float32Array): void {
      if (ended) return;
      frames.push(frame);
      const frameIndex = frames.length - 1;
      const now = d.now();
      const rms = rmsOf(frame);
      const above = rms > RMS_FLOOR;
      // S71-f: over the WHOLE recording, whatever ends up posted -- a NaN
      // frame (LREC-14) never satisfies `> peakRms` and is excluded here the
      // same way it already fails `above`, but still counts toward
      // `frames.length` (the `meanRms` denominator in `transcribe()`).
      if (rms > peakRms) peakRms = rms;
      if (!Number.isNaN(rms)) rmsSum += rms;
      if (above) framesAboveFloorCount++;
      if (rms >= RMS_FLOOR * QUIET_SEND_FACTOR) {
        hadQuietSound = true;
        if (firstQuietFrameIndex === null) firstQuietFrameIndex = frameIndex;
        lastQuietFrameIndex = frameIndex;
      }
      if (above) {
        consecutiveAbove++;
        lastAboveFloorAt = now;
        // Review finding (F-198, maintainer decision 22 Sept): a single
        // frame starts speech immediately when it is unambiguously
        // voice-loud (`SPEECH_ON_LOUD_FRAME_RMS`) -- UNLESS it is frame 0,
        // where the mic button's own click transient lives; frame 0 can
        // still be the first of a two-consecutive-frame pair (the `else`
        // branch below), just never a one-frame trigger by itself.
        if (!speechStarted) {
          if (frameIndex !== 0 && rms >= SPEECH_ON_LOUD_FRAME_RMS) {
            speechStarted = true;
          } else if (consecutiveAbove >= SPEECH_ON_FRAMES) {
            speechStarted = true;
          }
        }
      } else {
        consecutiveAbove = 0;
      }

      if (speechStarted && lastAboveFloorAt !== null && now - lastAboveFloorAt >= SILENCE_END_MS) {
        finalize("silence");
        return;
      }
      if (recordingStartedAt !== null && now - recordingStartedAt >= MAX_CLIP_MS) {
        finalize("cap");
      }
    }

    function startRecording(mediaStream: MediaStreamLike): void {
      stream = mediaStream;
      // Review finding, brief §3 point 3: Safari/Firefox on some devices
      // throw `NotSupportedError` from `new AudioContext({ sampleRate })`
      // for a rate their hardware does not natively offer. This used to
      // propagate out of the `.then()` handler below with nothing to catch
      // it -- an unhandled rejection, no onError/onEnd, the microphone left
      // open and the bar stuck on "Listening...". Falling back to the
      // context's own default rate and resampling in `transcribe()` (via
      // `resampleTo16k`, an OfflineAudioContext) is "the simplest" of the
      // two fixes the brief names; if even the default rate throws, this
      // still throws, and the `.then()` handler's own try/catch below turns
      // that into a clean onError("other")/onEnd() with the mic released.
      try {
        audioContext = d.createAudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      } catch {
        audioContext = d.createAudioContext();
      }
      recordedSampleRate = audioContext.sampleRate;
      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorNode.onaudioprocess = (event) => {
        handleFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      // A silent gain stage, not a direct connect to `destination`: some
      // implementations only pump a ScriptProcessorNode that is part of a
      // live graph reaching the destination, but the point here is to
      // capture the microphone, never to play it back over the speakers.
      const silence = audioContext.createGain();
      silence.gain.value = 0;
      sourceNode.connect(processorNode);
      processorNode.connect(silence);
      silence.connect(audioContext.destination);

      recordingStartedAt = d.now();
      if (stopRequested) finalize("stop");
    }

    events.onInterim("Listening…");

    d.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(
      (mediaStream) => {
        if (ended) {
          for (const track of mediaStream.getTracks()) track.stop();
          return;
        }
        try {
          startRecording(mediaStream);
        } catch (err) {
          // Review finding: both the 16 kHz open and its default-rate
          // fallback (or `createMediaStreamSource`/`createScriptProcessor`
          // themselves) failed -- `stream` is set, so `teardown()` still
          // releases the tracks and closes whatever partially opened.
          if (ended) return;
          ended = true;
          teardown();
          events.onError("other", String(err));
          events.onEnd();
        }
      },
      (err: unknown) => {
        if (ended) return;
        ended = true;
        if (isNotAllowedError(err)) {
          events.onError("not-allowed");
        } else {
          events.onError("other", String(err));
        }
        events.onEnd();
      },
    );

    return {
      stop(): void {
        if (ended) return;
        if (audioContext === null) {
          // Still waiting on getUserMedia -- nothing to finalize yet
          // (brief §3 point 1: the permission prompt can be slow); honoured
          // once it resolves, in `startRecording` above.
          stopRequested = true;
          return;
        }
        finalize("stop");
      },
    };
  };
}

/**
 * S57-a brief §4 / design-plan §19.102 D131 §3 — one silent fallback: when
 * `local`'s session ends with `onError("other", …)` before any final text,
 * a browser session starts in its place, using the SAME `events` the caller
 * gave `withFallback`'s returned `Recognizer`.
 *
 * `local`'s `onError("other", …)`/`onEnd()` pair is swallowed rather than
 * forwarded when a fallback starts: `CommandBar.tsx`'s `onError`/`onEnd`
 * handlers both call its own `endSession()`, which bumps the generation
 * counter `isCurrent()` checks (`CommandBar.tsx`, read-only here) -- forward
 * either one and every later callback through this same `events` (the
 * browser leg's own `onInterim`/`onFinal`/...) would fail that check and be
 * dropped, so the fallback would never reach the input. Swallowing them
 * keeps the bar's session current until whichever leg (browser, or local
 * alone when there is none) actually ends it -- brief §4: "the bar sees one
 * session". `not-allowed` and `no-speech`, and an `onError("other", …)`
 * that follows a final result, are forwarded as-is: only an unanswered
 * service before any text triggers the fallback.
 *
 * S59 reviewer finding (S59-e / R-421): `BoardPage.tsx` used to tag every
 * trace entry's `by` field from `WHISPER_URL !== null ? "local" : "browser"`
 * -- a STATIC fact about configuration, not about what actually produced any
 * given clip's text. The whole point of this function is that the caller
 * cannot tell, from the outside, whether a session fell back -- `events`
 * only ever sees one `onFinal`, exactly as brief §4 intends -- so a
 * configuration-only guess is wrong on precisely the case this function
 * exists for: whisper.cpp down/erroring, the browser's own recognition
 * silently answering instead, the trace file claiming "local" regardless.
 * `onEngine`, when given, is called synchronously -- BEFORE the matching
 * `events.onFinal` -- with which leg is about to answer, once per session:
 * once up front for `local` (the leg every session starts on), and again,
 * only on an actual fallback, for `browser`. A caller that keeps the latest
 * value in a ref (read synchronously inside its own `onFinal`, which fires
 * after this callback in the same tick) has the true answer; see
 * BoardPage.tsx's own doc for the wiring this enables there, and this
 * function's own test (LREC-17/18) for the ordering guarantee.
 */
export function withFallback(
  local: Recognizer,
  browser: Recognizer | null,
  onEngine?: (engine: "local" | "browser") => void,
): Recognizer {
  return function recognize(events: RecognizerEvents): RecognizerHandle {
    let gotFinal = false;
    let fellBack = false;

    onEngine?.("local");
    let currentHandle = local({
      onInterim(text) {
        events.onInterim(text);
      },
      onFinal(text) {
        gotFinal = true;
        events.onFinal(text);
      },
      onError(kind, detail) {
        if (kind === "other" && !gotFinal && browser !== null) {
          fellBack = true;
          onEngine?.("browser");
          currentHandle = browser({
            onInterim: events.onInterim,
            onFinal: events.onFinal,
            onError: events.onError,
            onEnd: events.onEnd,
          });
          return;
        }
        events.onError(kind, detail);
      },
      onEnd() {
        if (fellBack) return; // the browser leg above owns ending this session now
        events.onEnd();
      },
    });

    return {
      stop(): void {
        currentHandle.stop();
      },
    };
  };
}
