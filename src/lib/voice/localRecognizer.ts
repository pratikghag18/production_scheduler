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
import type { Recognizer, RecognizerEvents, RecognizerHandle } from "./recognizer";

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
/** How many consecutive above-floor frames start a clip's speech. */
const SPEECH_ON_FRAMES = 2;
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

function isNotAllowedError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "NotAllowedError";
}

/**
 * `localRecognizer(baseUrl, deps?)` -- brief §3. `deps` defaults to the
 * window's own microphone, audio context, `fetch` and clock; a test passes
 * fakes for all four.
 */
export function localRecognizer(baseUrl: string, deps?: Partial<LocalRecognizerDeps>): Recognizer {
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
    // Review finding: set from the ACTUAL context, once it opens (see
    // `startRecording`) -- `TARGET_SAMPLE_RATE` unless the platform refused
    // that rate, in which case this is whatever default rate it gave us and
    // `transcribe()` resamples before encoding.
    let recordedSampleRate = TARGET_SAMPLE_RATE;

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

    async function transcribe(): Promise<void> {
      let totalLength = 0;
      for (const frame of frames) totalLength += frame.length;
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const frame of frames) {
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

      const text =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { text?: unknown }).text === "string"
          ? (payload as { text: string }).text.trim()
          : "";
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
     *  seconds, THEN reports Transcribing... [and] posts the clip". */
    function finalize(): void {
      if (ended) return;
      ended = true;
      teardown();
      if (!speechStarted) {
        events.onError("no-speech");
        events.onEnd();
        return;
      }
      events.onInterim("Transcribing…");
      void transcribe();
    }

    function handleFrame(frame: Float32Array): void {
      if (ended) return;
      frames.push(frame);
      const now = d.now();
      const above = rmsOf(frame) > RMS_FLOOR;
      if (above) {
        consecutiveAbove++;
        lastAboveFloorAt = now;
        if (!speechStarted && consecutiveAbove >= SPEECH_ON_FRAMES) speechStarted = true;
      } else {
        consecutiveAbove = 0;
      }

      if (speechStarted && lastAboveFloorAt !== null && now - lastAboveFloorAt >= SILENCE_END_MS) {
        finalize();
        return;
      }
      if (recordingStartedAt !== null && now - recordingStartedAt >= MAX_CLIP_MS) {
        finalize();
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
      if (stopRequested) finalize();
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
        finalize();
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
 */
export function withFallback(local: Recognizer, browser: Recognizer | null): Recognizer {
  return function recognize(events: RecognizerEvents): RecognizerHandle {
    let gotFinal = false;
    let fellBack = false;

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
