/**
 * S62-b — `src/features/board/store/commandConversation.ts`'s own tests.
 *
 * The store is what F-163 moved the bar's conversation INTO ("A click outside
 * the bar closes it and loses the whole conversation, so moving a slider
 * empties it") and what R-427 hangs the conversation HISTORY on ("The sentence
 * clearing is not going to help unless we have conversation history ... It
 * will be a good sanity check to see what options were provided and what was
 * chosen"). Both of those are facts about state that outlives a component, so
 * they are pinned here, without React: `commandBar.test.tsx` owns what the bar
 * DOES with the store, this file owns what the store IS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_MAX_TURNS,
  createConversationStore,
  finishTrace,
  historyStorageKey,
  storeRef,
  type HistoryTurn,
} from "@/features/board/store/commandConversation";
import type { TraceEntry } from "@/lib/voice/trace";

function entry(over: Partial<TraceEntry> = {}): TraceEntry {
  return {
    at: new Date().toISOString(),
    heard: "assign Sam Patel to Housing A on Cell 3 from 8 to 12",
    by: "typed",
    model: { skipped: "no reader" },
    read: "assign Sam Patel to Housing A on Cell 3 from 08:00 to 12:00",
    asked: "Which person?",
    answered: "Sam Patel",
    ran: [],
    outcome: null,
    ...over,
  };
}

function turn(over: Partial<HistoryTurn> = {}): HistoryTurn {
  return {
    at: new Date().toISOString(),
    heard: "a sentence",
    by: "typed",
    read: "a command",
    asked: "a question",
    offered: [],
    answered: null,
    ran: [],
    outcome: null,
    ...over,
  };
}

const KEY = historyStorageKey("user-1", "plant_a");

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe("commandConversation: the store the bar's conversation lives in (F-163)", () => {
  it("CS-1: a fresh store is a bar that has never been spoken to", () => {
    const store = createConversationStore();
    const s = store.getState();
    expect(s.text).toBe("");
    expect(s.status).toBeNull();
    expect(s.held).toBeNull();
    expect(s.lot).toBeNull();
    expect(s.pendingRerun).toBeNull();
    expect(s.trace).toBeNull();
    expect(s.sentence).toBeNull();
    expect(s.history).toEqual([]);
  });

  it("CS-2: storeRef reads and writes through to the store, so the bar's `ref.current` idiom is the store's state", () => {
    const store = createConversationStore();
    const heldRef = storeRef(store, "held");
    expect(heldRef.current).toBeNull();
    const command = { intent: "assign" } as unknown as NonNullable<
      ReturnType<typeof store.getState>["held"]
    >;
    heldRef.current = command;
    expect(store.getState().held).toBe(command);
    expect(heldRef.current).toBe(command);
  });

  it("CS-3: reset clears the current turn but KEEPS the history and the key, and retires the in-flight generations", () => {
    const store = createConversationStore();
    store.getState().useHistoryKey(KEY);
    store.getState().appendTurn(turn({ heard: "an earlier sentence" }));
    store.getState().set({ text: "half a sentence", trace: entry() });
    const seqBefore = store.getState().lotRunSeq;

    store.getState().reset();

    expect(store.getState().text).toBe("");
    expect(store.getState().trace).toBeNull();
    expect(store.getState().history).toHaveLength(1);
    expect(store.getState().historyKey).toBe(KEY);
    // A lot still in flight must still be discarded when it settles.
    expect(store.getState().lotRunSeq).toBe(seqBefore + 1);
  });
});

describe("commandConversation: the conversation history (R-427)", () => {
  it("CH-3: the thread is persisted per user+plant and restored, and an entry older than 24 hours is dropped on load", () => {
    const old = turn({
      at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      heard: "yesterday's sentence",
    });
    const fresh = turn({
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      heard: "an hour ago",
    });
    window.localStorage.setItem(KEY, JSON.stringify([old, fresh]));

    const store = createConversationStore();
    store.getState().useHistoryKey(KEY);

    expect(store.getState().history.map((t) => t.heard)).toEqual(["an hour ago"]);
    // Pruned in STORAGE too, not only on screen.
    expect(
      (JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as HistoryTurn[]).map((t) => t.heard),
    ).toEqual(["an hour ago"]);

    // A DIFFERENT person, or the same person on a different plant, is a
    // different thread -- never a continuation of this one.
    const other = createConversationStore();
    other.getState().useHistoryKey(historyStorageKey("user-2", "plant_a"));
    expect(other.getState().history).toEqual([]);
    const otherPlant = createConversationStore();
    otherPlant.getState().useHistoryKey(historyStorageKey("user-1", "plant_b"));
    expect(otherPlant.getState().history).toEqual([]);
  });

  it("CH-4: the thread is capped, keeping the newest", () => {
    const store = createConversationStore();
    store.getState().useHistoryKey(KEY);
    for (let i = 0; i < HISTORY_MAX_TURNS + 5; i++) {
      store.getState().appendTurn(turn({ heard: `sentence ${i}` }));
    }
    const kept = store.getState().history;
    expect(kept).toHaveLength(HISTORY_MAX_TURNS);
    expect(kept[0].heard).toBe("sentence 5");
    expect(kept[kept.length - 1].heard).toBe(`sentence ${HISTORY_MAX_TURNS + 4}`);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toHaveLength(HISTORY_MAX_TURNS);
  });

  it("CH-3b: finishTrace files the SAME entry it posts, with the buttons that were on offer", () => {
    const store = createConversationStore();
    store.getState().useHistoryKey(KEY);
    store.getState().set({
      offered: ["Sam Patel", "Sam Ortiz"],
      trace: entry({ ran: ["Sam Patel → Housing A"], outcome: "written" }),
    });

    finishTrace(store);

    expect(store.getState().trace).toBeNull();
    const [filed] = store.getState().history;
    expect(filed.heard).toBe("assign Sam Patel to Housing A on Cell 3 from 8 to 12");
    expect(filed.offered).toEqual(["Sam Patel", "Sam Ortiz"]);
    expect(filed.answered).toBe("Sam Patel");
    expect(filed.ran).toEqual(["Sam Patel → Housing A"]);
    expect(filed.outcome).toBe("written");
  });

  it("CH-3c: clearHistory empties the thread and the key it was kept under", () => {
    const store = createConversationStore();
    store.getState().useHistoryKey(KEY);
    store.getState().appendTurn(turn());
    expect(window.localStorage.getItem(KEY)).not.toBeNull();

    store.getState().clearHistory();

    expect(store.getState().history).toEqual([]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("CH-3d: with no key (no person or no board yet) the thread still works and nothing is written to storage", () => {
    const store = createConversationStore();
    store.getState().appendTurn(turn({ heard: "before the board knew who" }));
    expect(store.getState().history).toHaveLength(1);
    expect(window.localStorage.length).toBe(0);
  });

  // S62-b reviewer fix (B): storage is UNTRUSTED INPUT. This used to keep any
  // object with a string `at`, so one turn missing its `offered` array came
  // back, the bar read `turn.offered.length` while rendering the thread, and
  // the board was a white screen -- permanently, because the bad value is
  // reloaded on every mount.
  it("CH-3e: a stored turn that does not typecheck is dropped, not repaired", () => {
    window.localStorage.setItem(KEY, '[{"at":"' + new Date().toISOString() + '","heard":"hello"}]');
    const store = createConversationStore();
    store.getState().useHistoryKey(KEY);
    expect(store.getState().history).toEqual([]);

    // One good turn beside three bad ones: the good one survives alone.
    const good = turn({ heard: "a real turn" });
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        good,
        { ...good, offered: undefined },
        { ...good, ran: [1, 2] },
        { ...good, by: "shouted" },
        { ...good, asked: 7 },
        "not an object",
        null,
      ]),
    );
    const second = createConversationStore();
    second.getState().useHistoryKey(KEY);
    expect(second.getState().history.map((t) => t.heard)).toEqual(["a real turn"]);

    // And a key whose value is not JSON at all is simply an empty thread.
    window.localStorage.setItem(KEY, "{not json");
    const third = createConversationStore();
    third.getState().useHistoryKey(KEY);
    expect(third.getState().history).toEqual([]);
  });

  // S62-b reviewer fix (F): the key is per PERSON and per BOARD ROOT. A change
  // to either is a different board, and nothing about the sentence in progress
  // -- its status, its held command, its lot -- may survive pointing at cells
  // that are no longer on screen.
  it("CS-4: changing the key flushes the open entry into the OLD thread and resets the current turn", () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    const store = createConversationStore();
    const other = historyStorageKey("user-1", "plant_a.area_1.line_1");
    store.getState().useHistoryKey(KEY);
    store.getState().set({
      trace: entry({ heard: "assign Sam Patel to Cell 1 from 8 to 4" }),
      offered: ["Housing A", "Bracket A"],
      text: "half a sentence",
      status: { kind: "shape", message: "Say it like: …" },
      held: { intent: "assign" } as never,
      lot: { commands: [], index: 0, done: [] },
    });

    store.getState().useHistoryKey(other);

    // The open entry went to the OLD board's thread, and its line to the file.
    const oldThread = JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as HistoryTurn[];
    expect(oldThread.map((t) => t.heard)).toEqual(["assign Sam Patel to Cell 1 from 8 to 4"]);
    expect(oldThread[0].offered).toEqual(["Housing A", "Bracket A"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // And nothing about the old board is left standing.
    const now = store.getState();
    expect(now.historyKey).toBe(other);
    expect(now.history).toEqual([]);
    expect(now.trace).toBeNull();
    expect(now.status).toBeNull();
    expect(now.held).toBeNull();
    expect(now.lot).toBeNull();
    expect(now.text).toBe("");
    expect(now.offered).toEqual([]);
  });
});
