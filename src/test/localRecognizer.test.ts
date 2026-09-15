/**
 * S57-a (brief §3-4, design-plan §19.102 / D131) — `localRecognizer` and
 * `withFallback` against faked microphone/audio-graph/fetch/clock deps, the
 * same shape `voiceRecognizer.test.ts` exercises for `browserRecognizer`
 * but for whisper.cpp's batch (record-then-transcribe) session instead of a
 * streaming one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localRecognizer,
  whisperServiceUrl,
  withFallback,
  type LocalRecognizerDeps,
} from "@/lib/voice/localRecognizer";
import type { Recognizer, RecognizerEvents } from "@/lib/voice/recognizer";

describe("LREC: whisperServiceUrl (S57-a brief §4)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("WSU-1: unset is null", () => {
    vi.stubEnv("VITE_WHISPER_URL", undefined);
    expect(whisperServiceUrl()).toBeNull();
  });

  it("WSU-2: whitespace-only is null, the same as unset", () => {
    vi.stubEnv("VITE_WHISPER_URL", "   ");
    expect(whisperServiceUrl()).toBeNull();
  });

  it("WSU-3: an ordinary value is trimmed and returned as-is", () => {
    vi.stubEnv("VITE_WHISPER_URL", "  /whisper  ");
    expect(whisperServiceUrl()).toBe("/whisper");
  });

  it("WSU-4: a trailing slash is stripped, so localRecognizer never builds a double slash", () => {
    // Review finding: `localRecognizer`'s `transcribe()` posts to
    // `` `${baseUrl}/inference` ``. Before this fix, `/whisper/` (a
    // plausible `.env.local` typo -- the README's own example has none)
    // survived untouched, producing `/whisper//inference` -- a path the dev
    // proxy's rewrite (only strips the `/whisper` prefix) does not collapse
    // and whisper.cpp's server 404s on.
    vi.stubEnv("VITE_WHISPER_URL", "/whisper/");
    expect(whisperServiceUrl()).toBe("/whisper");
  });

  it("WSU-5: several trailing slashes are all stripped", () => {
    vi.stubEnv("VITE_WHISPER_URL", "http://127.0.0.1:8090///");
    expect(whisperServiceUrl()).toBe("http://127.0.0.1:8090");
  });
});

// ---- fakes ----

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeNode {
  connected: FakeNode[] = [];
  disconnected = false;
  connect(dest: FakeNode): void {
    this.connected.push(dest);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGainNode extends FakeNode {
  gain = { value: 1 };
}

type FakeAudioProcessingEvent = { inputBuffer: { getChannelData(ch: number): Float32Array } };

class FakeProcessorNode extends FakeNode {
  onaudioprocess: ((event: FakeAudioProcessingEvent) => void) | null = null;
}

class FakeAudioContext {
  closed = false;
  destination = new FakeNode();
  lastProcessor: FakeProcessorNode | null = null;
  constructor(public sampleRate = 16000) {}
  createMediaStreamSource(_stream: unknown): FakeNode {
    return new FakeNode();
  }
  createScriptProcessor(): FakeProcessorNode {
    const node = new FakeProcessorNode();
    this.lastProcessor = node;
    return node;
  }
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  close(): void {
    this.closed = true;
  }
}

// ---- fakes for the review-finding coverage: the browser refusing a 16kHz
// AudioContext (brief §3 point 3) and a total audio-graph setup failure ----

class FakeAudioBuffer {
  channel: Float32Array;
  constructor(length: number) {
    this.channel = new Float32Array(length);
  }
  getChannelData(_ch: number): Float32Array {
    return this.channel;
  }
}

class FakeOfflineAudioContext {
  destination = new FakeNode();
  rendered: FakeAudioBuffer | null = null;
  lastSourceBuffer: FakeAudioBuffer | null = null;
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {}
  createBuffer(_nc: number, length: number, _sr: number): FakeAudioBuffer {
    return new FakeAudioBuffer(length);
  }
  createBufferSource(): {
    buffer: FakeAudioBuffer | null;
    connect: (d: unknown) => void;
    start: () => void;
  } {
    // The fake returns a plain object whose own methods must read BOTH the
    // object (its buffer) and this fake context, so an alias is the honest way.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ctx = this;
    return {
      buffer: null,
      connect(_dest: unknown) {
        ctx.lastSourceBuffer = this.buffer;
      },
      start() {
        // no-op: `startRendering` below produces the "rendered" buffer
        // directly, standing in for the browser's own resampler.
      },
    };
  }
  startRendering(): Promise<FakeAudioBuffer> {
    // A trivial "resample": same sample count as the target length, so the
    // test only has to assert the WAV that reaches `fetch` is at the
    // TARGET rate/shape, not reproduce the platform's own resampling math.
    this.rendered = new FakeAudioBuffer(this.length);
    return Promise.resolve(this.rendered);
  }
}

interface Harness {
  deps: Partial<LocalRecognizerDeps>;
  events: { [K in keyof RecognizerEvents]: ReturnType<typeof vi.fn> };
  stream: FakeMediaStream;
  audioContext: FakeAudioContext;
  clock: { t: number };
  getUserMedia: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  createAudioContext: ReturnType<typeof vi.fn>;
  createOfflineAudioContext: ReturnType<typeof vi.fn>;
}

function makeHarness(opts?: {
  getUserMediaImpl?: () => Promise<FakeMediaStream>;
  createAudioContextImpl?: (options?: { sampleRate?: number }) => FakeAudioContext;
}): Harness {
  const stream = new FakeMediaStream();
  const audioContext = new FakeAudioContext();
  const clock = { t: 0 };
  const getUserMedia =
    opts?.getUserMediaImpl !== undefined
      ? vi.fn(opts.getUserMediaImpl)
      : vi.fn(() => Promise.resolve(stream));
  const fetchMock = vi.fn();
  const createAudioContext =
    opts?.createAudioContextImpl !== undefined
      ? vi.fn(opts.createAudioContextImpl)
      : vi.fn(() => audioContext);
  const createOfflineAudioContext = vi.fn(
    (nc: number, length: number, sr: number) => new FakeOfflineAudioContext(nc, length, sr),
  );

  const deps: Partial<LocalRecognizerDeps> = {
    getUserMedia: getUserMedia as unknown as LocalRecognizerDeps["getUserMedia"],
    createAudioContext: createAudioContext as unknown as LocalRecognizerDeps["createAudioContext"],
    createOfflineAudioContext:
      createOfflineAudioContext as unknown as LocalRecognizerDeps["createOfflineAudioContext"],
    fetch: fetchMock as unknown as typeof fetch,
    now: () => clock.t,
  };

  const events = {
    onInterim: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  };

  return {
    deps,
    events,
    stream,
    audioContext,
    clock,
    getUserMedia,
    fetchMock,
    createAudioContext,
    createOfflineAudioContext,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function okJsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const ABOVE_FLOOR = new Float32Array(16).fill(0.5);
const SILENT = new Float32Array(16).fill(0);

async function startAndRecord(h: Harness): Promise<FakeProcessorNode> {
  const recognizer = localRecognizer("http://127.0.0.1:8090", h.deps);
  const handle = recognizer(h.events as unknown as RecognizerEvents);
  await flush();
  const processor = h.audioContext.lastProcessor;
  if (!processor) throw new Error("test setup: no processor created");
  return Object.assign(processor, { __handle: handle }) as FakeProcessorNode & {
    __handle: ReturnType<Recognizer>;
  };
}

describe("LREC: localRecognizer (S57-a brief §3)", () => {
  it("LREC-1: happy path -- frames build a WAV, posted, text comes back as final", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: " put ana on cell one " }));
    const processor = await startAndRecord(h);

    expect(h.events.onInterim).toHaveBeenCalledWith("Listening…");

    // Two frames above the floor start speech, then silence for >= 1500ms.
    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 100;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1700;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8090/inference");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("response_format")).toBe("json");
    expect(form.get("temperature")).toBe("0");
    expect(form.get("language")).toBe("en");
    const file = form.get("file") as File;
    expect(file.name).toBe("clip.wav");

    expect(h.events.onInterim).toHaveBeenCalledWith("Transcribing…");
    expect(h.events.onFinal).toHaveBeenCalledWith("put ana on cell one");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
    expect(h.events.onError).not.toHaveBeenCalled();
  });

  it("LREC-2: silence after speech ends the clip on its own", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "yes" }));
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 50;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1551; // 1501ms of silence after the last above-floor frame
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.events.onFinal).toHaveBeenCalledWith("yes");
  });

  it("LREC-3: the twelve-second cap ends the clip even mid-speech", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "still talking" }));
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 50;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 12000; // still above the floor, but the cap is absolute
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });

    await flush();
    expect(h.events.onFinal).toHaveBeenCalledWith("still talking");
  });

  it("LREC-4: stop() mid-clip finalises and transcribes what was captured", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "stopped early" }));
    const processor = await startAndRecord(h);
    const handle = (processor as unknown as { __handle: ReturnType<Recognizer> }).__handle;

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 50;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });

    handle.stop();
    await flush();

    expect(h.events.onInterim).toHaveBeenCalledWith("Transcribing…");
    expect(h.events.onFinal).toHaveBeenCalledWith("stopped early");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
  });

  it("LREC-5: not-allowed -- getUserMedia rejects with NotAllowedError", async () => {
    const h = makeHarness({
      getUserMediaImpl: () =>
        Promise.reject(Object.assign(new Error("nope"), { name: "NotAllowedError" })),
    });
    const recognizer = localRecognizer("http://127.0.0.1:8090", h.deps);
    recognizer(h.events as unknown as RecognizerEvents);
    await flush();

    expect(h.events.onError).toHaveBeenCalledWith("not-allowed");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("LREC-6: no speech by the end -- no-speech, no network call", async () => {
    const h = makeHarness();
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    h.clock.t = 12000;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.events.onError).toHaveBeenCalledWith("no-speech");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("LREC-7: the service down -- a network failure becomes onError(other)", async () => {
    const h = makeHarness();
    h.fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 50;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1600;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.events.onError).toHaveBeenCalledWith("other", "local recogniser not answering");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
  });

  it("LREC-7b: a non-2xx response is also onError(other)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    } as unknown as Response);
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 50;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1600;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.events.onError).toHaveBeenCalledWith("other", "local recogniser not answering");
  });

  it("LREC-8: a late fetch response after a second stop() is not double-reported", async () => {
    const h = makeHarness();
    let resolveFetch!: (r: Response) => void;
    h.fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const processor = await startAndRecord(h);
    const handle = (processor as unknown as { __handle: ReturnType<Recognizer> }).__handle;

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 50;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });

    handle.stop(); // finalises: ended, fetch in flight
    await flush();
    expect(h.events.onInterim).toHaveBeenCalledWith("Transcribing…");

    handle.stop(); // a second press while "Transcribing..." shows -- a no-op
    expect(h.audioContext.closed).toBe(true);

    resolveFetch(okJsonResponse({ text: "late" }));
    await flush();

    expect(h.events.onFinal).toHaveBeenCalledTimes(1);
    expect(h.events.onFinal).toHaveBeenCalledWith("late");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
  });

  it("LREC-9: tracks are released and the context is closed on every path", async () => {
    // no-speech path
    const h1 = makeHarness();
    const p1 = await startAndRecord(h1);
    h1.clock.t = 12000;
    p1.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    await flush();
    expect(h1.stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h1.audioContext.closed).toBe(true);

    // happy path
    const h2 = makeHarness();
    h2.fetchMock.mockResolvedValue(okJsonResponse({ text: "ok" }));
    const p2 = await startAndRecord(h2);
    h2.clock.t = 0;
    p2.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h2.clock.t = 50;
    p2.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h2.clock.t = 1600;
    p2.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    await flush();
    expect(h2.stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h2.audioContext.closed).toBe(true);
  });

  it("LREC-10: the browser refuses a 16kHz AudioContext -- falls back to the default rate and resamples", async () => {
    // Review finding: `new AudioContext({ sampleRate: 16000 })` throws
    // `NotSupportedError` on some Safari/Firefox devices (brief §3 point 3).
    const fallbackContext = new FakeAudioContext(48000);
    const h = makeHarness({
      createAudioContextImpl: (options) => {
        if (options?.sampleRate === 16000) {
          throw Object.assign(new Error("not supported"), { name: "NotSupportedError" });
        }
        return fallbackContext;
      },
    });
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "resampled" }));

    const recognizer = localRecognizer("http://127.0.0.1:8090", h.deps);
    recognizer(h.events as unknown as RecognizerEvents);
    await flush();
    const processor = fallbackContext.lastProcessor;
    if (!processor) throw new Error("test setup: no processor on the fallback context");

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 50;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1600;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    await flush();

    // The OfflineAudioContext is opened at the TARGET rate, not the
    // fallback context's native 48kHz -- it is the render target.
    expect(h.createOfflineAudioContext).toHaveBeenCalledTimes(1);
    const [, , offlineSampleRate] = h.createOfflineAudioContext.mock.calls[0];
    expect(offlineSampleRate).toBe(16000);
    expect(h.events.onFinal).toHaveBeenCalledWith("resampled");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
    expect(h.events.onError).not.toHaveBeenCalled();
    expect(fallbackContext.closed).toBe(true);
  });

  it("LREC-11: both the 16kHz and default-rate AudioContext opens fail -- a clean error, not an unhandled rejection", async () => {
    const err = Object.assign(new Error("no audio hardware"), { name: "NotSupportedError" });
    const h = makeHarness({
      createAudioContextImpl: () => {
        throw err;
      },
    });
    const recognizer = localRecognizer("http://127.0.0.1:8090", h.deps);
    recognizer(h.events as unknown as RecognizerEvents);
    await flush();

    expect(h.events.onError).toHaveBeenCalledWith("other", String(err));
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
    expect(h.stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("LREC-12: stop() while getUserMedia is still pending is honoured once it resolves", async () => {
    let resolveGetUserMedia!: (s: FakeMediaStream) => void;
    const h = makeHarness({
      getUserMediaImpl: () =>
        new Promise((resolve) => {
          resolveGetUserMedia = resolve;
        }),
    });
    const recognizer = localRecognizer("http://127.0.0.1:8090", h.deps);
    const handle = recognizer(h.events as unknown as RecognizerEvents);

    handle.stop(); // brief §3 point 1: the permission prompt can be slow
    expect(h.events.onEnd).not.toHaveBeenCalled();

    resolveGetUserMedia(h.stream);
    await flush();

    // No frames were ever captured, so the pending stop() finalises
    // straight to "no speech", same as an immediate stop() would.
    expect(h.events.onError).toHaveBeenCalledWith("no-speech");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
    expect(h.stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.audioContext.closed).toBe(true);
  });

  it("LREC-13: getUserMedia rejects NotFoundError (no mic) -- onError(other), never a loop", async () => {
    const h = makeHarness({
      getUserMediaImpl: () =>
        Promise.reject(Object.assign(new Error("no mic"), { name: "NotFoundError" })),
    });
    const recognizer = localRecognizer("http://127.0.0.1:8090", h.deps);
    recognizer(h.events as unknown as RecognizerEvents);
    await flush();

    expect(h.events.onError).toHaveBeenCalledWith(
      "other",
      expect.stringContaining("NotFoundError"),
    );
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("LREC-14: a frame with NaN samples does not crash and is never counted as speech", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "after nan" }));
    const processor = await startAndRecord(h);

    const NAN_FRAME = new Float32Array(16).fill(NaN);
    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => NAN_FRAME } });
    h.clock.t = 50;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => NAN_FRAME } });
    // NaN frames never register as speech (rmsOf(NaN) compares false
    // against the floor either way) -- real speech below still starts it.
    h.clock.t = 100;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 150;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1700;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    await flush();

    expect(h.events.onFinal).toHaveBeenCalledWith("after nan");
    expect(h.events.onError).not.toHaveBeenCalled();
    // The NaN frame is still merged into the clip -- encodeWav16k must not
    // throw or produce an empty body for it (wav.test.ts pins the encoder
    // side of a NaN sample directly).
    const [, init] = h.fetchMock.mock.calls[0];
    const form = init.body as FormData;
    const file = form.get("file") as File;
    expect(file.size).toBeGreaterThan(44);
  });
});

describe("LREC: withFallback (S57-a brief §4, design-plan D131 §3)", () => {
  function fakeBrowserRecognizer(): { recognizer: Recognizer; started: RecognizerEvents[] } {
    const started: RecognizerEvents[] = [];
    const recognizer: Recognizer = (events: RecognizerEvents) => {
      started.push(events);
      return { stop: vi.fn() };
    };
    return { recognizer, started };
  }

  it("WF-1: local onError(other) before any final text falls back, and the bar sees one session", async () => {
    let localEvents!: RecognizerEvents;
    const local: Recognizer = (events) => {
      localEvents = events;
      return { stop: vi.fn() };
    };
    const { recognizer: browser, started } = fakeBrowserRecognizer();

    const wrapped = withFallback(local, browser);
    const barEvents = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    wrapped(barEvents as unknown as RecognizerEvents);

    localEvents.onError("other", "local recogniser not answering");
    localEvents.onEnd();

    // The local failure is swallowed -- CommandBar never sees onError/onEnd
    // for it (forwarding either would bump its own generation counter and
    // strand the browser leg's callbacks, brief §4).
    expect(barEvents.onError).not.toHaveBeenCalled();
    expect(barEvents.onEnd).not.toHaveBeenCalled();
    expect(started).toHaveLength(1);

    // The browser leg's own callbacks reach the bar directly.
    started[0].onInterim("hello");
    started[0].onFinal("hello");
    started[0].onEnd();
    expect(barEvents.onInterim).toHaveBeenCalledWith("hello");
    expect(barEvents.onFinal).toHaveBeenCalledWith("hello");
    expect(barEvents.onEnd).toHaveBeenCalledTimes(1);
  });

  it("WF-2: no browser recogniser -- the local error stands, forwarded as-is", () => {
    let localEvents!: RecognizerEvents;
    const local: Recognizer = (events) => {
      localEvents = events;
      return { stop: vi.fn() };
    };

    const wrapped = withFallback(local, null);
    const barEvents = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    wrapped(barEvents as unknown as RecognizerEvents);

    localEvents.onError("other", "local recogniser not answering");
    localEvents.onEnd();

    expect(barEvents.onError).toHaveBeenCalledWith("other", "local recogniser not answering");
    expect(barEvents.onEnd).toHaveBeenCalledTimes(1);
  });

  it("WF-3: not-allowed and no-speech are forwarded as-is, never trigger a fallback", () => {
    let localEvents!: RecognizerEvents;
    const local: Recognizer = (events) => {
      localEvents = events;
      return { stop: vi.fn() };
    };
    const { recognizer: browser, started } = fakeBrowserRecognizer();
    const wrapped = withFallback(local, browser);
    const barEvents = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    wrapped(barEvents as unknown as RecognizerEvents);

    localEvents.onError("no-speech");
    localEvents.onEnd();

    expect(barEvents.onError).toHaveBeenCalledWith("no-speech", undefined);
    expect(barEvents.onEnd).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(0);
  });

  it("WF-4: an onError(other) that follows a final result is forwarded, not a fallback", () => {
    let localEvents!: RecognizerEvents;
    const local: Recognizer = (events) => {
      localEvents = events;
      return { stop: vi.fn() };
    };
    const { recognizer: browser, started } = fakeBrowserRecognizer();
    const wrapped = withFallback(local, browser);
    const barEvents = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    wrapped(barEvents as unknown as RecognizerEvents);

    localEvents.onFinal("done");
    localEvents.onError("other", "late failure");
    localEvents.onEnd();

    expect(barEvents.onFinal).toHaveBeenCalledWith("done");
    expect(barEvents.onError).toHaveBeenCalledWith("other", "late failure");
    expect(started).toHaveLength(0);
  });

  it("WF-5: stop() reaches whichever leg is currently active", () => {
    let localEvents!: RecognizerEvents;
    const localStop = vi.fn();
    const local: Recognizer = (events) => {
      localEvents = events;
      return { stop: localStop };
    };
    const browserStop = vi.fn();
    const browser: Recognizer = () => ({ stop: browserStop });
    const wrapped = withFallback(local, browser);
    const handle = wrapped({
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    } as unknown as RecognizerEvents);

    handle.stop();
    expect(localStop).toHaveBeenCalledTimes(1);
    expect(browserStop).not.toHaveBeenCalled();

    localEvents.onError("other", "local recogniser not answering");
    localEvents.onEnd();

    handle.stop();
    expect(browserStop).toHaveBeenCalledTimes(1);
  });

  it("WF-6: the browser fallback leg erroring is forwarded once, not a second fallback -- not a loop", () => {
    let localEvents!: RecognizerEvents;
    const local: Recognizer = (events) => {
      localEvents = events;
      return { stop: vi.fn() };
    };
    const { recognizer: browser, started } = fakeBrowserRecognizer();
    const wrapped = withFallback(local, browser);
    const barEvents = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    wrapped(barEvents as unknown as RecognizerEvents);

    localEvents.onError("other", "local recogniser not answering");
    localEvents.onEnd();
    expect(started).toHaveLength(1);

    // The browser leg's own onError/onEnd go straight to the outer events
    // (`withFallback`'s browser-leg wiring passes `events.onError`/
    // `events.onEnd` by reference, not through the interceptor that
    // triggered THIS fallback) -- so a browser-side failure cannot itself
    // trigger a second fallback, and only one browser session is ever
    // started for this one call.
    started[0].onError("no-speech");
    started[0].onEnd();

    expect(barEvents.onError).toHaveBeenCalledTimes(1);
    // Called through the direct reference `events.onError`, so (unlike
    // `withFallback`'s own two-argument forwarding on the local leg, WF-3)
    // this call carries only the one argument the browser leg passed.
    expect(barEvents.onError).toHaveBeenCalledWith("no-speech");
    expect(barEvents.onEnd).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1); // still just the one browser session
  });
});
