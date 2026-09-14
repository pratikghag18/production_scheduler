/**
 * S46-a review finding 4 -- `src/lib/voice/recognizer.ts`'s own mapping of
 * the Web Speech API onto `Recognizer`. `CommandBar`'s tests
 * (`src/test/commandBar.test.tsx`, CB-mic-*) all use a fake `Recognizer`, so
 * they never exercise `browserRecognizer()`'s own `onresult`/`onerror`/
 * `onend` wiring; this file does, against a fake
 * `window.webkitSpeechRecognition` class standing in for jsdom (which has
 * no real one).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserRecognizer, type RecognizerEvents } from "@/lib/voice/recognizer";

interface FakeAlt {
  transcript: string;
}
type FakeResult = FakeAlt[] & { isFinal: boolean };

function fakeResult(transcript: string, isFinal: boolean): FakeResult {
  return Object.assign([{ transcript }], { isFinal });
}

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 1;
  onresult: ((e: { results: FakeResult[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  aborted = false;
  stopped = false;
  static instances: FakeRecognition[] = [];
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start(): void {}
  stop(): void {
    this.stopped = true;
  }
  abort(): void {
    this.aborted = true;
  }
}

/** Installs the fake class and starts one session, returning the fake
 *  instance it created so a test can fire `onresult`/`onerror`/`onend`. */
function startSession(events: Partial<RecognizerEvents> = {}): FakeRecognition {
  FakeRecognition.instances.length = 0;
  (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
    FakeRecognition;
  const recognizer = browserRecognizer();
  expect(recognizer).not.toBeNull();
  recognizer!({
    onInterim: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
    ...events,
  });
  return FakeRecognition.instances[0];
}

afterEach(() => {
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

describe("VREC: browserRecognizer wraps the Web Speech API (S46-a review finding 4)", () => {
  it("VREC-1: two result entries join with a single space", () => {
    const onInterim = vi.fn();
    const instance = startSession({ onInterim });

    instance.onresult?.({
      results: [fakeResult("put ana ", false), fakeResult(" on cell one", false)],
    });

    expect(onInterim).toHaveBeenCalledWith("put ana on cell one");
  });

  it("VREC-2: an isFinal result calls onFinal once, never onInterim", () => {
    const onFinal = vi.fn();
    const onInterim = vi.fn();
    const instance = startSession({ onFinal, onInterim });

    instance.onresult?.({ results: [fakeResult("put ana", true)] });

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("put ana");
    expect(onInterim).not.toHaveBeenCalled();
  });

  it("VREC-3: an error followed by end calls onError then onEnd, once each", () => {
    const onError = vi.fn();
    const onEnd = vi.fn();
    const instance = startSession({ onError, onEnd });

    instance.onerror?.({ error: "no-speech" });
    instance.onend?.();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("no-speech");
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("VREC-4: the handle's stop() prefers abort() over stop()", () => {
    FakeRecognition.instances.length = 0;
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
      FakeRecognition;
    const recognizer = browserRecognizer()!;
    const handle = recognizer({
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    });
    const instance = FakeRecognition.instances[0];

    handle.stop();

    expect(instance.aborted).toBe(true);
    expect(instance.stopped).toBe(false);
  });
});
