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

export interface RecognizerEvents {
  /** What has been heard so far; may be revised by a later call. */
  onInterim(text: string): void;
  /** The sentence is final; listening ends after this (an `onEnd` follows). */
  onFinal(text: string): void;
  onError(kind: "not-allowed" | "no-speech" | "other", detail?: string): void;
  /** The recogniser stopped, for any reason (a final result, an error, or a
   *  caller's `stop()`). */
  onEnd(): void;
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
