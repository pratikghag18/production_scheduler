/**
 * S46-a (brief docs/agent-briefs/s46-a-microphone-brief.md §2.1) — a thin
 * wrapper over the browser's Web Speech API so `CommandBar` and its tests
 * share one shape, and so the bar never touches the global constructor (or
 * its vendor prefix) directly. `browserRecognizer()` is `null` when the
 * window has neither `SpeechRecognition` nor `webkitSpeechRecognition`;
 * calling the `Recognizer` it returns starts one recognition session per
 * call, ended by `onEnd` (any reason) or the returned handle's `stop()`.
 *
 * The Web Speech API's own types are not in this project's `lib` (brief:
 * "do not add a dependency or a global `lib` entry"), so the shape used here
 * is typed minimally, by hand, below -- just enough of it to read results
 * and errors and to start/stop a session.
 */

/**
 * S71-f (R-453, R-434, brief docs/agent-briefs/s71-f-clip-capture-brief.md
 * §1.A) -- exactly the bytes and the numbers a recogniser sent to its
 * service for one clip, so the bar can keep and score every clip Whisper
 * ever saw instead of trusting a feeling about what got cut off. Only
 * `localRecognizer.ts` fires this today (the browser's Web Speech API
 * streams; it never "posts a clip" at all).
 */
export interface ClipInfo {
  /** Exactly the bytes posted -- the WAV `transcribe()` built, unmodified. */
  wav: ArrayBuffer;
  /** Duration, in ms, of the bytes actually posted (the window, when one was
   *  sent instead of the whole clip -- see `endedBy: "cap-window"`). */
  durationMs: number;
  /** Duration, in ms, of the WHOLE recording before any windowing. */
  recordedMs: number;
  /** Which rule ended the clip: the stop button, 1500ms of silence after
   *  speech, the twelve-second cap reached mid-speech, or the cap reached
   *  with no speech ever started but a quiet sound worth sending (the
   *  windowed send). */
  endedBy: "stop" | "silence" | "cap" | "cap-window";
  /** Whether speech ever "started" under the onset rules, over the whole
   *  recording. */
  speechStarted: boolean;
  /** Max frame RMS over the whole recording. */
  peakRms: number;
  /** Mean frame RMS over the whole recording. */
  meanRms: number;
  /** Count of frames whose RMS was above the floor, over the whole
   *  recording. */
  framesAboveFloor: number;
  /** The prompt sent with the clip, or `null` when none was. */
  hint: string | null;
}

export interface RecognizerEvents {
  /** What has been heard so far; may be revised by a later call. A PARTIAL
   *  TRANSCRIPT ONLY -- never a status word. See `onStatus` (S71-j) for the
   *  recogniser's own progress. */
  onInterim(text: string): void;
  /** The sentence is final; listening ends after this (an `onEnd` follows). */
  onFinal(text: string): void;
  onError(kind: "not-allowed" | "no-speech" | "other", detail?: string): void;
  /** The recogniser stopped, for any reason (a final result, an error, or a
   *  caller's `stop()`). */
  onEnd(): void;
  /** S71-f: fired once per clip actually posted to the recogniser's own
   *  service, right before the request goes out. Optional so every existing
   *  caller and test needs no change. */
  onClip?(info: ClipInfo): void;
  /** S71-j (R-454, docs/agent-briefs/s71-j-progress-words-out-of-the-input-
   *  brief.md): the recogniser's own PROGRESS, never a transcript --
   *  "listening" while the microphone is open waiting for speech to start,
   *  "transcribing" once a clip has been posted to the service and an
   *  answer is awaited. This is what `localRecognizer.ts` used to send as a
   *  literal status word through `onInterim` ("Listening…"/"Transcribing…");
   *  it no longer does. Optional so every existing caller and test needs no
   *  change; only `localRecognizer.ts` fires it today (the browser leg
   *  streams results directly and has no separate "posted, awaiting" phase
   *  of its own to report). */
  onStatus?(phase: "listening" | "transcribing"): void;
}

export interface RecognizerHandle {
  stop(): void;
}

export type Recognizer = (events: RecognizerEvents) => RecognizerHandle;

// ---- the Web Speech API's own shape, typed just enough to use it ----

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  // F-214 (S71-l, R-454): fired by the engine itself once it is actually
  // listening -- the browser leg's own moment to report `onStatus`
  // ("listening"), same as `localRecognizer.ts` reports it from inside its
  // own `startRecording`, so neither engine leaves the bar to guess the
  // phase on its own (`CommandBar.tsx`'s `startListening` no longer sets it
  // synchronously at all).
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** `null` when `window` has no `SpeechRecognition`/`webkitSpeechRecognition`
 *  (no browser recogniser to wrap) -- the bar renders no microphone button
 *  in that case (brief §2.2). */
export function browserRecognizer(): Recognizer | null {
  if (typeof window === "undefined") return null;
  const Ctor = speechRecognitionCtor();
  if (Ctor === null) return null;

  return function recognize(events: RecognizerEvents): RecognizerHandle {
    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = document.documentElement.lang || navigator.language;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      // Review finding 4: each `SpeechRecognitionResult` entry is its own
      // recognised segment ("put ana", "on cell one") -- concatenating their
      // transcripts directly runs them together ("put anaon cell one").
      // Trim each segment (the API pads some with a leading/trailing space
      // of its own) and join what is left with a single space.
      const segments: string[] = [];
      let final = false;
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const segment = (result[0]?.transcript ?? "").trim();
        if (segment !== "") segments.push(segment);
        if (result.isFinal) final = true;
      }
      const text = segments.join(" ");
      if (final) {
        events.onFinal(text);
      } else {
        events.onInterim(text);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        events.onError("not-allowed");
      } else if (event.error === "no-speech") {
        events.onError("no-speech");
      } else {
        events.onError("other", event.error);
      }
    };

    recognition.onend = () => {
      events.onEnd();
    };

    // F-214: the engine's own report that it is actually listening -- fired
    // once the microphone is open and speech detection is live, never a
    // guess made ahead of that by the caller.
    recognition.onstart = () => {
      events.onStatus?.("listening");
    };

    try {
      recognition.start();
    } catch (err) {
      events.onError("other", String(err));
    }

    return {
      stop(): void {
        try {
          if (typeof recognition.abort === "function") {
            recognition.abort();
          } else {
            recognition.stop();
          }
        } catch {
          // Never throws (brief §2.1).
        }
      },
    };
  };
}
