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

    // F-198: ONE frame above the floor is now enough to start speech (was
    // two, LREC-19 pins the one-frame minimum on its own); this happy path
    // still sends two, then silence for >= 1500ms, to exercise the WAV/
    // request-shape assertions below over more than a single frame's audio.
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

  it("LREC-15: a non-empty hint is sent as the clip's `prompt` field, read at clip time not construction", async () => {
    // S59-c (brief §2, design-plan §19.104/D133 item 4).
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "put ana on cell one" }));
    let current = "before the clip started";
    const recognizer = localRecognizer("http://127.0.0.1:8090", h.deps, () => current);
    const handle = recognizer(h.events as unknown as RecognizerEvents);
    await flush();
    const processor = h.audioContext.lastProcessor;
    if (!processor) throw new Error("test setup: no processor created");

    // Changed AFTER the session started listening but BEFORE the clip is
    // finalised -- the hint the request carries is whichever the function
    // returns when `transcribe()` actually calls it, not whatever it
    // returned when `localRecognizer(...)` was called.
    current = "cell, line, Cell 1, Housing A, Operator A3";

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 50;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1600;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    await flush();

    const [, init] = h.fetchMock.mock.calls[0];
    const form = init.body as FormData;
    expect(form.get("prompt")).toBe("cell, line, Cell 1, Housing A, Operator A3");
    handle.stop();
  });

  it("LREC-16: no hint function, and an empty-string hint, both leave `prompt` absent from the request", async () => {
    // S59-c (brief §2): "the field is sent when a hint is given and absent
    // when not" -- `form.get` returns `null` for a field never appended.
    const h1 = makeHarness();
    h1.fetchMock.mockResolvedValue(okJsonResponse({ text: "no hint fn" }));
    const p1 = await startAndRecord(h1); // startAndRecord's own recognizer(...) has no third argument
    h1.clock.t = 0;
    p1.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h1.clock.t = 50;
    p1.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h1.clock.t = 1600;
    p1.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    await flush();
    const form1 = (h1.fetchMock.mock.calls[0][1] as { body: FormData }).body;
    expect(form1.get("prompt")).toBeNull();

    const h2 = makeHarness();
    h2.fetchMock.mockResolvedValue(okJsonResponse({ text: "empty hint" }));
    const recognizer2 = localRecognizer("http://127.0.0.1:8090", h2.deps, () => "");
    recognizer2(h2.events as unknown as RecognizerEvents);
    await flush();
    const processor2 = h2.audioContext.lastProcessor;
    if (!processor2) throw new Error("test setup: no processor created");
    h2.clock.t = 0;
    processor2.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h2.clock.t = 50;
    processor2.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h2.clock.t = 1600;
    processor2.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    await flush();
    const form2 = (h2.fetchMock.mock.calls[0][1] as { body: FormData }).body;
    expect(form2.get("prompt")).toBeNull();
  });

  // F-198 (22 Sept, the spoken walk -- data/voice/trace/bar.jsonl,
  // 2026-09-22T19:42-19:45Z): a one-syllable "yes" is one BUFFER_SIZE frame
  // of loudness (0.256s), never two (0.512s) -- SPEECH_ON_FRAMES dropped
  // from 2 to 1. These four pins replace no coverage that existed before
  // (nothing in this file previously exercised a single above-floor frame,
  // or the cap-reached quiet-clip path at all) -- the bug shipped with a
  // green suite because the suite never tried a clip this short.
  //
  // Review finding + maintainer decision (22 Sept): dropping SPEECH_ON_FRAMES
  // to 1 outright reopened a false-start risk (a keyboard click, a door, the
  // mic button's own click transient -- all measured above RMS_FLOOR in a
  // single 256ms frame). The fix keeps SPEECH_ON_FRAMES at its original 2,
  // adds a `SPEECH_ON_LOUD_FRAME_RMS` threshold a single frame can cross
  // alone, and excludes frame index 0 (where a click transient at the mic
  // button press itself would land) from ever starting speech by itself --
  // see `SPEECH_ON_LOUD_FRAME_RMS`'s own doc and LREC-25 through LREC-28.
  // LREC-19's own contract changed with it: the single above-floor frame
  // that starts speech is no longer allowed to be the very first one
  // recorded, so a silent priming frame at index 0 now precedes it below;
  // the "one frame is enough, and it is sent" claim otherwise still holds.

  it("LREC-19: ONE loud frame (not frame 0) starts speech and is sent -- was no-speech under the pre-F-198 SPEECH_ON_FRAMES=2, and frame 0 itself is excluded by the review fix (F-198)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "yes" }));
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } }); // frame 0: never eligible to start speech alone
    h.clock.t = 256;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } }); // frame 1: one loud frame is enough
    h.clock.t = 1757; // 1501ms of silence after that single loud frame
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.events.onFinal).toHaveBeenCalledWith("yes");
    expect(h.events.onError).not.toHaveBeenCalled();
  });

  it("LREC-20: a quiet clip that never crosses the floor, but has a frame within QUIET_SEND_FACTOR of it, is still sent when the twelve-second cap is reached (F-198)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "yes" }));
    const processor = await startAndRecord(h);

    // rms 0.016: under RMS_FLOOR (0.02) so speech never "starts", but at or
    // above RMS_FLOOR * QUIET_SEND_FACTOR (0.02 * 0.75 = 0.015) -- a quiet
    // answer picked up a little too far from the mic, not true silence.
    const QUIET_BUT_PRESENT = new Float32Array(16).fill(0.016);
    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => QUIET_BUT_PRESENT } });
    h.clock.t = 12000; // the cap, still no frame ever crossed RMS_FLOOR
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => QUIET_BUT_PRESENT } });

    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.events.onFinal).toHaveBeenCalledWith("yes");
    expect(h.events.onError).not.toHaveBeenCalled();
  });

  it("LREC-21: a clip below QUIET_SEND_FACTOR of the floor throughout stays no-speech at the cap -- true silence is never sent (F-198)", async () => {
    const h = makeHarness();
    // rms 0.01: under RMS_FLOOR * QUIET_SEND_FACTOR (0.015) as well as the
    // floor itself -- ordinary room noise, not a quiet answer.
    const TOO_QUIET = new Float32Array(16).fill(0.01);
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => TOO_QUIET } });
    h.clock.t = 12000;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => TOO_QUIET } });

    await flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.events.onError).toHaveBeenCalledWith("no-speech");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
  });

  it("LREC-22: a quiet-but-present frame does NOT get sent on a manual stop() before the cap -- the cap-reached rule is scoped to the cap, not to every no-speech ending (F-198)", async () => {
    const h = makeHarness();
    const QUIET_BUT_PRESENT = new Float32Array(16).fill(0.016);
    const processor = await startAndRecord(h);
    const handle = (processor as unknown as { __handle: ReturnType<Recognizer> }).__handle;

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => QUIET_BUT_PRESENT } });
    h.clock.t = 500; // well short of the twelve-second cap
    handle.stop();

    await flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.events.onError).toHaveBeenCalledWith("no-speech");
  });

  it("LREC-23: the twelve-second cap still ends a clip that never crosses the floor at all -- still no-speech, still no network call (F-198 regression guard on LREC-6)", async () => {
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

  // Review finding (F-198, reviewed 22 Sept): tested against the running
  // scheduler-whisper container (127.0.0.1:8090/inference), a FULL 12s clip
  // at a uniform quiet amplitude (rms ~0.010) came back " (clippers
  // buzzing)\n" -- an invented sentence -- every time (2/2 trials), and a 9s
  // clip did too (2/2); the same amplitude at 1.5s/3s/6s came back
  // genuinely empty text every time (2/2 each). The cap-reached quiet-send
  // path must therefore post a bounded WINDOW around the quiet frame(s),
  // never the whole captured clip.
  it("LREC-24: the cap-reached quiet-send path posts only a window around the quiet frame(s), never the full clip (F-198 review finding)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "yes" }));
    const processor = await startAndRecord(h);

    const QUIET_BUT_PRESENT = new Float32Array(16).fill(0.016);
    const SILENT_FRAME = new Float32Array(16).fill(0);

    // The real ~256ms frame cadence across the full twelve-second cap: one
    // quiet-band frame near the very start (a stray noise), then many
    // frames of true silence until the cap -- ~47 frames total, the shape
    // of clip that measurably made the real service hallucinate when the
    // FULL clip was posted.
    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => QUIET_BUT_PRESENT } });
    const totalFrames = 47; // ~12000ms / 256ms
    for (let i = 1; i < totalFrames; i++) {
      h.clock.t = i * 256;
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT_FRAME } });
    }
    h.clock.t = 12000;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT_FRAME } });

    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.events.onFinal).toHaveBeenCalledWith("yes");

    const [, init] = h.fetchMock.mock.calls[0];
    const form = init.body as FormData;
    const file = form.get("file") as File;
    // Each fake frame here is 16 samples; the window this path posts is
    // capped at 12 frames (QUIET_CLIP_MAX_FRAMES) -- a 44-byte WAV header
    // plus at most 12*16 samples * 2 bytes/sample -- nowhere near the ~47
    // frames (752 samples) the full clip would have carried.
    const maxWindowedBytes = 44 + 12 * 16 * 2;
    expect(file.size).toBeLessThanOrEqual(maxWindowedBytes);
    expect(file.size).toBeGreaterThan(44); // still carries some audio, not an empty clip
  });

  // F-198 review fix, maintainer decision (22 Sept): speech starts on ONE
  // frame only when that frame is clearly voice-loud (>= SPEECH_ON_LOUD_FRAME_RMS,
  // 0.08), on TWO consecutive frames at the existing floor otherwise
  // (SPEECH_ON_FRAMES, back to 2), and never on frame index 0 alone -- where
  // the mic button's own click transient lives -- though frame 0 still
  // counts toward the two-consecutive-frame rule. LREC-25 through LREC-28
  // pin this against the reviewer's own measurements and trace.

  it("LREC-25: a single click-sized frame at frame 0 (rms 0.024) never starts speech alone; the clip reaches the quiet-send window at the cap, not the local no-speech skip (F-198 review fix)", async () => {
    const h = makeHarness();
    // 0.024 is above RMS_FLOOR (0.02, so `above` is true and it would count
    // toward the two-consecutive-frame rule on a LATER frame) but below
    // SPEECH_ON_LOUD_FRAME_RMS (0.08); at frame index 0 it cannot start
    // speech under either rule. It IS above RMS_FLOOR * QUIET_SEND_FACTOR
    // (0.015), so hadQuietSound is set -- the cap-reached branch therefore
    // posts this clip through the quiet-send window (LREC-20/24's path)
    // rather than skipping the network with a bare no-speech; mocked to
    // return empty text here so the OBSERVABLE outcome the bar sees is
    // still no-speech, matching CLAUDE.md's rule that Whisper's own empty
    // answer is what reads "Nothing was heard", never a guess made locally.
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "" }));
    const CLICK = new Float32Array(16).fill(0.024);
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => CLICK } }); // frame 0 only
    h.clock.t = 256;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } }); // consecutiveAbove resets; speechStarted still false
    h.clock.t = 12000; // the cap
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    // The click reached the network through the quiet-send window (not the
    // bare local no-speech skip) -- confirming which branch the numbers give.
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.events.onError).toHaveBeenCalledWith("no-speech");
    expect(h.events.onFinal).not.toHaveBeenCalled();
  });

  it("LREC-26: a single loud frame at 0.10 (a normal 'yes', not frame 0) starts speech immediately and is sent (F-198 review fix)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "yes" }));
    const processor = await startAndRecord(h);
    const NORMAL_YES = new Float32Array(16).fill(0.1); // >= SPEECH_ON_LOUD_FRAME_RMS (0.08)

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } }); // frame 0: brief silence before the word
    h.clock.t = 256;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => NORMAL_YES } }); // frame 1: one loud frame starts speech by itself
    h.clock.t = 1757; // 1501ms of silence after that single loud frame
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.events.onFinal).toHaveBeenCalledWith("yes");
    expect(h.events.onError).not.toHaveBeenCalled();
  });

  it("LREC-27: frame 0 alone never starts speech even when very loud (0.30); frame 0 still counts toward the two-consecutive-frame rule when both frames are at 0.03 (F-198 review fix)", async () => {
    // Part A: frame 0 at 0.30 (well above SPEECH_ON_LOUD_FRAME_RMS) alone
    // must NOT start speech -- if it wrongly did, the silence-after-speech
    // branch would finalize this session ~1500ms later; it must still be
    // listening (no onEnd, no network call) at that point.
    const h1 = makeHarness();
    const p1 = await startAndRecord(h1);
    const VERY_LOUD = new Float32Array(16).fill(0.3);
    h1.clock.t = 0;
    p1.onaudioprocess?.({ inputBuffer: { getChannelData: () => VERY_LOUD } }); // frame 0 only
    h1.clock.t = 1600; // well past SILENCE_END_MS (1500ms) since frame 0
    p1.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    await flush();
    expect(h1.events.onEnd).not.toHaveBeenCalled();
    expect(h1.fetchMock).not.toHaveBeenCalled();

    // Part B: frame 0 AND frame 1 both at 0.03 (above RMS_FLOOR, below
    // SPEECH_ON_LOUD_FRAME_RMS) -- frame 0 still counts toward the ordinary
    // two-consecutive-frame rule, so speech starts at frame 1.
    const h2 = makeHarness();
    h2.fetchMock.mockResolvedValue(okJsonResponse({ text: "yes" }));
    const p2 = await startAndRecord(h2);
    const JUST_ABOVE_FLOOR = new Float32Array(16).fill(0.03);
    h2.clock.t = 0;
    p2.onaudioprocess?.({ inputBuffer: { getChannelData: () => JUST_ABOVE_FLOOR } }); // frame 0
    h2.clock.t = 256;
    p2.onaudioprocess?.({ inputBuffer: { getChannelData: () => JUST_ABOVE_FLOOR } }); // frame 1: 2nd consecutive -- starts speech
    h2.clock.t = 1757; // 1501ms of silence after frame 1
    p2.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    await flush();
    expect(h2.fetchMock).toHaveBeenCalledTimes(1);
    expect(h2.events.onFinal).toHaveBeenCalledWith("yes");
  });

  it("LREC-28: the click-then-speech regression from the reviewer's own trace (click at frame 0, real speech 1.79s later) is sent with the real speech included, not cut off before it arrives (F-198 review fix)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "yes" }));
    const processor = await startAndRecord(h);
    const CLICK = new Float32Array(16).fill(0.024); // frame 0: the mic button's own click transient
    const REAL_SPEECH = new Float32Array(16).fill(0.35); // a real spoken word, well above SPEECH_ON_LOUD_FRAME_RMS

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => CLICK } }); // frame 0
    // Frames 1-6 (t=256..1536ms): silence. Under the pre-fix single-frame
    // rule this click used to set speechStarted=true at frame 0 and the
    // 1500ms silence timer, anchored to the click, finalized the clip at
    // t=1536ms -- BEFORE the person's real "yes" at t=1792ms ever arrived
    // (see the reviewer's own simulate.mjs trace). Under this fix, frame 0
    // alone never starts speech, so no premature finalize happens here.
    for (let i = 1; i <= 6; i++) {
      h.clock.t = i * 256;
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });
    }
    h.clock.t = 1792; // the real "yes" -- one loud frame, starts speech immediately (not frame 0)
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => REAL_SPEECH } });
    h.clock.t = 1792 + 1501; // 1501ms of silence after the real word
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.events.onFinal).toHaveBeenCalledWith("yes");
    expect(h.events.onError).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // LREC-29 (F-201): whisper.cpp answers a clip with no real words in it
  // with a bracketed or parenthesised TAG, never an empty string -- see
  // `stripNonSpeechTags`'s own doc in `localRecognizer.ts`. The maintainer's
  // 23 Sept walk hit "[Music]" live, between two sentences; the bar read it
  // as heard speech and the model answered an unassign of everyone, which
  // ran into F-199's own `-840` bug before it stopped. Each case here still
  // drives real ABOVE_FLOOR frames (unlike LREC-6's genuine no-speech,
  // which never reaches the network at all) -- the mic DID hear something,
  // Whisper is the one that answered nothing but a tag.
  // ---------------------------------------------------------------------

  it("LREC-29a: a whisper.cpp '[Music]' tag alone is no-speech, never a heard sentence (F-201)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "[Music]" }));
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 100;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1700;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.events.onFinal).not.toHaveBeenCalled();
    expect(h.events.onError).toHaveBeenCalledWith("no-speech");
    expect(h.events.onEnd).toHaveBeenCalledTimes(1);
  });

  it("LREC-29b: '[BLANK_AUDIO]' alone is the same -- no-speech, onFinal never called (F-201)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: " [BLANK_AUDIO]\n" }));
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 100;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1700;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.events.onFinal).not.toHaveBeenCalled();
    expect(h.events.onError).toHaveBeenCalledWith("no-speech");
  });

  it("LREC-29c: '(clippers buzzing)' alone is the same -- no-speech, onFinal never called (F-201, the F-198 review's own measured hallucination)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: " (clippers buzzing)\n" }));
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 100;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1700;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.events.onFinal).not.toHaveBeenCalled();
    expect(h.events.onError).toHaveBeenCalledWith("no-speech");
  });

  it("LREC-29d: '[Music] clear Cell 3 today' sends the words only, tag dropped (F-201)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: "[Music] clear Cell 3 today" }));
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 100;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1700;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.events.onFinal).toHaveBeenCalledWith("clear Cell 3 today");
    expect(h.events.onError).not.toHaveBeenCalled();
  });

  it("LREC-29e: a plain sentence with no tag at all is unchanged (F-201, no regression)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue(okJsonResponse({ text: " put ana on cell one " }));
    const processor = await startAndRecord(h);

    h.clock.t = 0;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 100;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => ABOVE_FLOOR } });
    h.clock.t = 1700;
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => SILENT } });

    await flush();
    expect(h.events.onFinal).toHaveBeenCalledWith("put ana on cell one");
    expect(h.events.onError).not.toHaveBeenCalled();
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

  // Reviewer finding (S59-e / R-421, item 5): `BoardPage.tsx` tagged every
  // trace entry's `by` field from static configuration
  // (`WHISPER_URL !== null ? "local" : "browser"`), which is wrong exactly
  // when whisper.cpp is configured but down and this function's own
  // fallback silently hands the session to the browser -- the trace would
  // say "local" for text the browser actually produced. `onEngine` is the
  // fix's other half: it tells a caller which leg is REALLY answering,
  // synchronously and in time to matter (see the doc above `withFallback`).
  it('LREC-17: onEngine("local") fires once, before onFinal, when local never falls back', () => {
    let localEvents!: RecognizerEvents;
    const local: Recognizer = (events) => {
      localEvents = events;
      return { stop: vi.fn() };
    };
    const { recognizer: browser } = fakeBrowserRecognizer();
    const engines: ("local" | "browser")[] = [];
    let engineAtFinal: string | null = null;
    const wrapped = withFallback(local, browser, (e) => engines.push(e));
    const barEvents = {
      onInterim: vi.fn(),
      onFinal: vi.fn(() => {
        engineAtFinal = engines[engines.length - 1];
      }),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    wrapped(barEvents as unknown as RecognizerEvents);

    expect(engines).toEqual(["local"]); // announced up front, before any clip finishes
    localEvents.onFinal("put ana on cell one");
    expect(engineAtFinal).toBe("local"); // already "local" by the time onFinal ran
    expect(engines).toEqual(["local"]); // never called again -- no fallback happened
  });

  it('LREC-18: onEngine("browser") fires on an actual fallback, before the browser leg\'s own onFinal', () => {
    let localEvents!: RecognizerEvents;
    const local: Recognizer = (events) => {
      localEvents = events;
      return { stop: vi.fn() };
    };
    const { recognizer: browser, started } = fakeBrowserRecognizer();
    const engines: ("local" | "browser")[] = [];
    let engineAtFinal: string | null = null;
    const wrapped = withFallback(local, browser, (e) => engines.push(e));
    const barEvents = {
      onInterim: vi.fn(),
      onFinal: vi.fn(() => {
        engineAtFinal = engines[engines.length - 1];
      }),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    wrapped(barEvents as unknown as RecognizerEvents);
    expect(engines).toEqual(["local"]);

    // whisper.cpp errors before any final text -- the fallback this function
    // exists for.
    localEvents.onError("other", "local recogniser not answering");
    localEvents.onEnd();
    expect(engines).toEqual(["local", "browser"]); // updated BEFORE the browser leg answers

    started[0].onFinal("put ana on cell one");
    // By the time the bar's own onFinal ran, the ref a caller like
    // BoardPage.tsx keeps already reads "browser" -- the whole point: a
    // trace entry tagged from this value, not from static config, is right.
    expect(engineAtFinal).toBe("browser");
  });
});
