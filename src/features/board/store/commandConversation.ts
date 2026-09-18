/**
 * S62-b / F-163 — THE CONVERSATION LIVES OUTSIDE THE BAR.
 *
 * The maintainer, 17 Sept: "The chatbot also vanished when I moved the
 * slider something which you claimed would not happen." R-424 (session 176)
 * stopped `BoardPage` unmounting the bar for a board refetch, but it never
 * touched the OTHER unmount: `CommandLauncher` closes its panel on any
 * mousedown outside it, by design, and closing unmounts `CommandBar` — whose
 * status, held command, pending question, lot, pending rerun and open trace
 * entry were all its own `useState`/`useRef`. Reaching for the toolbar, the
 * day count or the zoom mid-conversation therefore emptied the bar.
 *
 * So the conversation is not the bar's any more. It is this store, created
 * ONCE PER BOARD MOUNT by `CommandLauncher` (a `useState` initialiser, so it
 * survives every open/close of the panel below it) and handed to whichever
 * `CommandBar` is currently mounted. Opening the panel again re-mounts a bar
 * that reads exactly the status, the buttons and the input text that stood.
 *
 * ⛔ WHAT RESETS IT, AND WHAT DOES NOT (brief §2). A cancel word, a finished
 * readout's natural end and a new sentence end a conversation, exactly as
 * they did when it lived in the component. Open/close NEVER does: the panel
 * closing is a person looking at the board, not a person abandoning what they
 * were saying. `reset()` exists for the board itself going away (a fresh
 * launcher mount) and for a test's own `beforeEach`; nothing in the open/close
 * path calls it.
 *
 * ⚠️ WHICH KEY CLOSES AND WHICH CANCELS (brief §2, the maintainer's own
 * wording on the panel header). **Escape CLOSES** — `CommandBar`'s Escape
 * ladder clears the status line, then the input, then calls `onEscapeIdle`
 * (the launcher's `close`), and the panel's own handler closes outright from
 * anywhere else inside it. None of those is a cancel any more: the
 * conversation survives every one of them, so reopening shows what stood.
 * **A cancel word cancels** — "no", "cancel", "stop", "nope", "never mind"
 * … typed or spoken into the bar. That is the only thing that ends a
 * standing question without answering it.
 *
 * ⭐ WHY THE CANDIDATE BUTTONS ARE DATA, NOT CLOSURES. A `Status` held here
 * outlives the component that built it, so a button whose `onClick` closed
 * over that component's functions, refs and props would come back from a
 * reopen still pointing at a bar that no longer exists. Every button is
 * therefore a `CandidateAction` — a plain, structurally-cloneable description
 * of what pressing it does — and the CURRENTLY MOUNTED bar is what turns one
 * into a call (`CommandBar.tsx`'s own `runCandidateAction`). That is what
 * makes CB-keep-4/5 possible at all.
 *
 * This module holds no rule of the board's: it is state, the trace's own
 * post, and nothing else.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  AssignCommand,
  Attach,
  BookCommand,
  Command,
  Existing,
  HeadcountCommand,
  MoveCommand,
  SingleCommand,
  UnassignCommand,
} from "@/lib/command/parse";
import type {
  Candidate,
  ResolveOptions,
  ResolvedBook,
  ResolvedCommand,
  ResolvedMove,
  ResolvedUnassign,
} from "@/lib/command/resolve";
import type { Highlight } from "../lib/highlight";
import { renderLine, type TraceEntry } from "@/lib/voice/trace";

/**
 * S51 (R-400, design §19.98/D127): a several's inner commands are always one
 * of the resolver's four SINGLE resolved shapes. Declared here rather than in
 * `CommandBar.tsx` (which re-exports it, so every existing importer is
 * unchanged) because the LOT that holds them is this store's state now.
 */
export type ResolvedAny = ResolvedCommand | ResolvedBook | ResolvedUnassign | ResolvedMove;

/**
 * What pressing one of the bar's candidate buttons does. Data, never a
 * closure — see the module doc above for why that matters. `CommandBar.tsx`
 * owns the one `switch` that turns one of these into a call.
 */
export type CandidateAction =
  | {
      kind: "pick_candidate";
      command: Command;
      field: "operator" | "product" | "place" | "shift";
      candidate: Candidate;
      /** S55 (D130 item 1): the exact word the question was asked about --
       *  needed only to tell a `replace`/`swap`'s TWO person fields apart. */
      text?: string;
    }
  | {
      kind: "pick_part_as_place";
      command: AssignCommand | BookCommand | HeadcountCommand;
      product: string;
      candidate: Candidate;
    }
  | { kind: "pick_attach"; command: AssignCommand; attach: Attach }
  | {
      kind: "pick_existing";
      command: Command;
      existing:
        Existing | BookCommand["existing"] | UnassignCommand["existing"] | MoveCommand["existing"];
    }
  /** S59 / R-419: "Show that day" — moves the window, then re-runs
   *  `command` once a `ctx` carrying `target` arrives. */
  | { kind: "show_day"; command: Command; target: string }
  /** S51: the lot's own "Do all N". */
  | { kind: "run_lot" };

export interface CandidateButton {
  key: string;
  label: string;
  action: CandidateAction;
}

export type Status =
  | { kind: "shape"; message: string }
  | {
      kind: "question";
      message: string;
      candidates: CandidateButton[];
      /** S47: set only for remove_which/move_which/block_exists -- the ids
       *  to outline on the board (`onHighlight`) while this status stands.
       *  S51: the LOT's own finished status sets this to a LIST. */
      blockHighlight?: Highlight | Highlight[];
      /** S51: set ONLY on the lot's own "N commands ready" status. */
      lot?: boolean;
      /**
       * S61-a (R-425, F-155): set ONLY on a `not_certified` "warn" question
       * for an ordinary single sentence -- this question takes free TEXT as
       * its answer (the override reason), never a candidate button and never
       * the block-question confirm/cancel vocabulary.
       */
      awaitingOverrideReason?: boolean;
      /**
       * F-165 (S62-b): the AREA twin of `awaitingOverrideReason` -- set ONLY
       * on an `outside_area` question for an ordinary single sentence. Same
       * conversation shape, a different field on the write (the server keeps
       * `area_override`/`area_override_reason` apart from
       * `eligibility_override`/`override_reason`, migration 0072's own two
       * doors), so the bar has to know which reason it is collecting.
       */
      awaitingAreaReason?: boolean;
    }
  | { kind: "readout"; message: string }
  /** S44-b: shown while `reader(text, signal)` is pending. */
  | { kind: "reading"; message: string };

/**
 * F-167: WHAT BECAME OF A WRITE THE BAR HANDED TO A POP-UP.
 *
 * `popup` is an honest answer but not a final one: a sentence that opened the
 * create pop-up has not been written, refused OR abandoned yet, and F-165 is
 * exactly what that silence costs. Every writer prop that may open a pop-up is
 * handed a REPORTER as its third argument, which it passes down to whichever
 * pop-up it opened (`openCreateFromCommand`'s own `onResult` option);
 * `CreatePopover` calls it once, when Create succeeds, when the server
 * refuses, or when the pop-up is cancelled. The bar keeps the sentence's trace
 * entry OPEN until then (a pop-up left open is still flushed on teardown,
 * F-157) and shows the turn in the thread meanwhile as "Waiting: …", which
 * becomes Written / Refused / Cancelled the moment this lands.
 *
 * Declared HERE rather than in `CommandBar.tsx` (which re-exports it) so
 * `CreatePopover` can take the type without importing the bar.
 */
export type PopupResult =
  | { kind: "written"; readout?: string }
  | { kind: "refused"; message: string }
  | { kind: "cancelled" }
  /**
   * S62-b reviewer fix (C): NOT a terminal answer. The create pop-up handed
   * the write on to ANOTHER pop-up (D61's split coverage) -- still nothing
   * written, still not over. The bar records what it is waiting on now and
   * keeps the entry open; the pop-up that took it over reports the terminal
   * result through the SAME reporter. Without this the thread said "Waiting:
   * the create pop-up" for ever.
   */
  | { kind: "handed_off"; what: string };

export type PopupReporter = (result: PopupResult) => void;

/** S51 (R-400/D127): the lot a `several` sentence is being walked through. */
export interface Lot {
  commands: SingleCommand[];
  index: number;
  done: ResolvedAny[];
}

/** S59 (R-419): the command a "Show that day" press is waiting to re-run. */
export interface PendingRerun {
  command: Command;
  target: string;
}

/**
 * R-427 (the maintainer, 17 Sept): ONE FINISHED TURN OF THE CONVERSATION.
 *
 * "The sentence clearing is not going to help unless we have conversation
 * history ... It will be a good sanity check to see what options were provided
 * and what was chosen." F-162 empties the input to make room for the answer,
 * which is right, and leaves the person with nothing to look back at, which is
 * not -- so every sentence that ENDS is kept here as well as posted to
 * `data/voice/trace/bar.jsonl`.
 *
 * ⭐ THE FILE AND THE THREAD ARE THE SAME ENTRY, RENDERED TWICE. Every field
 * below except `offered` is a `TraceEntry` field, read off the very entry
 * `finishTrace` is posting -- there is no second place a turn is assembled and
 * no second idea of what a turn is (CLAUDE.md 4: a list that appears twice is
 * a bug with a delay on it). `offered` is the one addition the maintainer
 * asked for and the trace never carried: WHICH BUTTONS WERE ON OFFER, as
 * labels, so the thread can show what the choice actually was and mark the one
 * taken.
 */
export interface HistoryTurn {
  /** The trace entry's own `at` -- and this turn's identity in the thread. */
  at: string;
  heard: string;
  by: "typed" | "browser" | "local";
  read: string;
  asked: string | null;
  /** The labels of the buttons standing when the turn ended, in order. */
  offered: string[];
  answered: string | null;
  ran: string[];
  outcome: string | null;
}

/** R-427: 24 hours, the maintainer's own span ("history for the last day"). */
export const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** R-427: and a ceiling, so one long day cannot grow the key without bound. */
export const HISTORY_MAX_TURNS = 200;

/** Everything the bar was saying, holding or waiting on. */
export interface ConversationValues {
  /** The input box's own text. */
  text: string;
  /**
   * F-162: the SENTENCE the standing question is about, kept here because
   * the input box is emptied to take the answer. `null` whenever no answer
   * box stands. Escape puts it back in the input.
   */
  sentence: string | null;
  status: Status | null;
  /** The last parsed command, kept so an answer can re-resolve it. */
  held: Command | null;
  /**
   * F-165: the reasons already given for THIS held command, accumulated
   * across re-resolves — a certificate reason answered first must not be
   * asked for again when an area question follows it (and vice versa).
   * Cleared whenever `held` is.
   */
  heldOptions: ResolveOptions;
  lot: Lot | null;
  pendingRerun: PendingRerun | null;
  /** S59-e (R-421): the entry for the sentence currently in progress. */
  trace: TraceEntry | null;
  /** S51: true while `onRunLot` is in flight for the current lot. */
  runningLot: boolean;
  /** S51: bumped by every lot run, compared on resolve. */
  lotRunSeq: number;
  /** S44-b: the in-flight reading's abort controller, and its generation. */
  readingAbort: AbortController | null;
  readingSeq: number;
  /**
   * R-427: the labels of the buttons standing for the CURRENT sentence --
   * reset by `startTrace`, refreshed by the bar whenever a question with
   * candidates is shown, and read once when the turn is filed into `history`.
   */
  offered: string[];
  /** R-427: the finished turns, OLDEST FIRST (the thread's own order). */
  history: HistoryTurn[];
  /**
   * F-167: the `at` of the turn already filed for the CURRENTLY OPEN entry,
   * or `null`. A sentence handed to the create pop-up is filed into the
   * thread the moment it is handed over -- so the person can see "Waiting:
   * the create pop-up" while it waits -- but its entry stays OPEN until the
   * pop-up answers, and the trace file gets exactly one line either way.
   * This is what tells `fileTurn` to UPDATE that turn rather than append a
   * second one.
   */
  filedTurnAt: string | null;
  /**
   * R-427: where this history is persisted -- `localStorage` under this
   * person and this plant (`historyStorageKey`). `null` until the launcher
   * knows both, and while it is null nothing is written to storage (the
   * thread still works for the session; it is simply not kept).
   */
  historyKey: string | null;
}

export interface ConversationState extends ConversationValues {
  set: (patch: Partial<ConversationValues>) => void;
  setStatus: (next: Status | null | ((prev: Status | null) => Status | null)) => void;
  setText: (next: string) => void;
  /** R-427: files one finished turn and persists the pruned thread. */
  appendTurn: (turn: HistoryTurn) => void;
  /** F-167: patches the turn filed at `at` -- the pop-up answering a
   *  sentence that was already shown in the thread as waiting. */
  updateTurn: (at: string, patch: Partial<HistoryTurn>) => void;
  /** R-427: the "Clear history" control's own door -- empties the thread here
   *  and in storage. Never touches the trace file, which is the developer's
   *  log, not the person's. */
  clearHistory: () => void;
  /** R-427: points this store at a person+plant key and loads whatever that
   *  key already holds (pruned). Called by `CommandLauncher` once the board
   *  knows both. */
  useHistoryKey: (key: string | null) => void;
  /** Back to a bar that has never been spoken to. */
  reset: () => void;
}

export type ConversationStore = StoreApi<ConversationState>;

const EMPTY: ConversationValues = {
  text: "",
  sentence: null,
  status: null,
  held: null,
  heldOptions: {},
  lot: null,
  pendingRerun: null,
  trace: null,
  runningLot: false,
  lotRunSeq: 0,
  readingAbort: null,
  readingSeq: 0,
  offered: [],
  history: [],
  filedTurnAt: null,
  historyKey: null,
};

/**
 * R-427: where one person's thread for ONE BOARD lives.
 *
 * ⚠️ `rootPath` IS THE BOARD'S OWN ROOT, NOT THE PLANT (S62-b reviewer fix F).
 * `BoardPage` feeds it the root the person is actually looking at, which for a
 * plant admin is the plant and for a line supervisor is her line -- so two
 * boards inside one plant keep two threads, and that is the right answer: the
 * turns are about the cells in front of you. Keyed on the person as well
 * because a browser on the floor is shared.
 */
export function historyStorageKey(userId: string, rootPath: string): string {
  return `commandConversation.history.${userId}.${rootPath}`;
}

/** R-427: the thread as it is allowed to be kept -- nothing older than a day,
 *  and never more than `HISTORY_MAX_TURNS`, keeping the NEWEST. Applied on
 *  load AND on every append, so a tab left open overnight prunes itself the
 *  next time it is spoken to rather than only at startup. */
function prune(turns: HistoryTurn[], nowMs: number): HistoryTurn[] {
  const fresh = turns.filter((t) => {
    const at = Date.parse(t.at);
    // An unparseable time is kept rather than silently dropped: it is a bug in
    // whatever wrote it, not a reason to lose the person's record.
    return Number.isNaN(at) || nowMs - at < HISTORY_MAX_AGE_MS;
  });
  return fresh.length > HISTORY_MAX_TURNS ? fresh.slice(fresh.length - HISTORY_MAX_TURNS) : fresh;
}

/** Storage is best-effort throughout: a private window, a full quota or a
 *  browser with site data blocked must never break the bar. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * S62-b reviewer fix (B): EVERY FIELD, NOT JUST `at`.
 *
 * This used to keep any object with a string `at` -- so one bad stored value
 * (a turn written by an older shape, a half-written key, a hand-edited entry)
 * came back with no `offered` array, the bar read `turn.offered.length` while
 * rendering the thread, and the whole board was a white screen from then on,
 * permanently, because the bad value is reloaded on every mount. Storage is
 * untrusted input; a turn that does not typecheck is dropped, not repaired.
 */
function isHistoryTurn(value: unknown): value is HistoryTurn {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.at === "string" &&
    typeof t.heard === "string" &&
    (t.by === "typed" || t.by === "browser" || t.by === "local") &&
    typeof t.read === "string" &&
    isStringOrNull(t.asked) &&
    isStringArray(t.offered) &&
    isStringOrNull(t.answered) &&
    isStringArray(t.ran) &&
    isStringOrNull(t.outcome)
  );
}

function readStoredHistory(key: string): HistoryTurn[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryTurn);
  } catch {
    return [];
  }
}

function writeStoredHistory(key: string | null, turns: HistoryTurn[]): void {
  if (key === null) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(turns));
  } catch {
    // Best effort -- see above.
  }
}

export function createConversationStore(): ConversationStore {
  return createStore<ConversationState>((set, get) => ({
    ...EMPTY,
    set: (patch) => set(patch),
    setStatus: (next) => set({ status: typeof next === "function" ? next(get().status) : next }),
    setText: (next) => set({ text: next }),
    appendTurn: (turn) => {
      const next = prune([...get().history, turn], Date.now());
      set({ history: next });
      writeStoredHistory(get().historyKey, next);
    },
    updateTurn: (at, patch) => {
      const next = get().history.map((t) => (t.at === at ? { ...t, ...patch } : t));
      set({ history: next });
      writeStoredHistory(get().historyKey, next);
    },
    clearHistory: () => {
      set({ history: [] });
      const key = get().historyKey;
      if (key === null) return;
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Best effort.
      }
    },
    useHistoryKey: (key) => {
      const state = get();
      if (state.historyKey === key) return;
      // S62-b reviewer fix (F): A KEY CHANGE IS A DIFFERENT BOARD (or a
      // different person). Whatever was being said was about the OLD one, so
      // an entry still open is flushed INTO THE OLD THREAD and its file line
      // posted, and the current turn -- status, held command, lot, pending
      // rerun, the input's own text -- is dropped. Nothing may survive
      // pointing at cells that are no longer on screen.
      const open = state.trace;
      if (open !== null) {
        const turn: HistoryTurn = {
          at: open.at,
          heard: open.heard,
          by: open.by,
          read: open.read,
          asked: open.asked,
          offered: state.offered,
          answered: open.answered,
          ran: [...open.ran],
          outcome: open.outcome,
        };
        // `appendTurn`/`updateTurn` still write under the OLD key here, which
        // is the point: the turn belongs to the board it was said on.
        if (state.filedTurnAt === open.at) state.updateTurn(open.at, turn);
        else state.appendTurn(turn);
        postTraceOnTeardown(open);
      }
      const loaded = key === null ? [] : prune(readStoredHistory(key), Date.now());
      set({
        ...EMPTY,
        // Same reasoning as `reset`'s: a run or a reading still in flight has
        // to be discarded when it settles, never matched against a fresh
        // generation.
        lotRunSeq: state.lotRunSeq + 1,
        readingSeq: state.readingSeq + 1,
        historyKey: key,
        history: loaded,
      });
      // Write the pruned thread straight back, so an entry that aged out is
      // gone from storage too rather than only from the screen.
      if (key !== null) writeStoredHistory(key, loaded);
    },
    // `lotRunSeq`/`readingSeq` deliberately KEEP counting across a reset:
    // a run or a reading still in flight when this is called must still be
    // discarded when it settles, and restarting the counters at 0 would let
    // one of them match a fresh generation and clobber it.
    //
    // R-427: `history`/`historyKey` are NOT reset either -- the thread is the
    // record of what was done, not part of the current turn.
    reset: () =>
      set({
        ...EMPTY,
        lotRunSeq: get().lotRunSeq + 1,
        readingSeq: get().readingSeq + 1,
        history: get().history,
        historyKey: get().historyKey,
      }),
  }));
}

/**
 * A `{ current }` view of one field of `store`, so the bar's existing
 * `heldRef.current = x` / `lotRef.current` idiom reads and writes the store
 * with no change at any of its many call sites. Cheap to build (an object
 * with two accessors) and deliberately NOT memoised: it must always read
 * through to the live store, never to a snapshot.
 */
export function storeRef<K extends keyof ConversationValues>(
  store: ConversationStore,
  key: K,
): { current: ConversationValues[K] } {
  return {
    get current(): ConversationValues[K] {
      return store.getState()[key];
    },
    set current(value: ConversationValues[K]) {
      store.getState().set({ [key]: value } as Partial<ConversationValues>);
    },
  };
}

// ---------------------------------------------------------------------------
// The trace's own post (S59-e / R-421 / F-157), moved here from
// `CommandBar.tsx` so the entry can outlive the bar exactly as the rest of
// the conversation now does: the LAUNCHER (this store's owner) is what
// flushes an entry still open when the board itself goes away.
// ---------------------------------------------------------------------------

/** Entries already sent, so a deferred write outcome settling after the
 *  sentence was superseded can never post the same line twice (F-164). */
const POSTED = new WeakSet<TraceEntry>();

/** Posts `entry` to the dev server's `/__trace`, fire-and-forget, errors
 *  swallowed, only when `import.meta.env.DEV` (R-421: "a build without it
 *  changes nothing in the bar"). */
export function postTrace(entry: TraceEntry, options?: { revise?: boolean }): void {
  if (!import.meta.env.DEV) return;
  const alreadyPosted = POSTED.has(entry);
  // S62-b reviewer fix (D): a WRITE THAT LANDED LATE gets a corrected line
  // rather than nothing. The file is append-only, so the correction carries
  // the same `at` and `revises: true`; a reader takes the last line per `at`
  // (`TraceEntry.revises`' own doc). Without `revise`, a second post of the
  // same entry is still the no-op it has always been.
  if (alreadyPosted && options?.revise !== true) return;
  POSTED.add(entry);
  const line = renderLine(alreadyPosted ? { ...entry, revises: true } : entry);
  try {
    fetch("/__trace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: line,
    }).catch(() => {});
  } catch {
    // Never throws -- see above.
  }
}

/**
 * F-157: the page actually tearing down is exactly when a sentence's entry
 * is most likely to still be open, and an in-flight `fetch` is free to be
 * cancelled then. `navigator.sendBeacon` is built for this; where it is
 * unavailable (or refuses the payload) this falls back to a keepalive fetch.
 */
export function postTraceOnTeardown(entry: TraceEntry): void {
  if (!import.meta.env.DEV) return;
  if (POSTED.has(entry)) return;
  POSTED.add(entry);
  const line = renderLine(entry);
  try {
    // A plain string, not a `Blob` -- `traceServer.ts`'s own handler reads
    // the raw body regardless of content type.
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon("/__trace", line)) return;
    }
  } catch {
    // Fall through to the fetch keepalive below.
  }
  try {
    fetch("/__trace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: line,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Never throws -- see above.
  }
}

/** Posts whatever entry `store` still has open and clears it -- a no-op when
 *  none is. The sentence's life ends here (R-421: "a readout written, a
 *  cancel, a new sentence"). */
export function finishTrace(store: ConversationStore): void {
  const entry = store.getState().trace;
  if (!entry) return;
  fileTurn(store, entry);
  store.getState().set({ trace: null });
  postTrace(entry);
}

/**
 * R-427: the same entry, filed into the thread. One place, called by both
 * `finishTrace` and `flushTraceOnTeardown`, so the file and the thread can
 * never hold different turns. `offered` is the only field the entry itself
 * does not carry (see `HistoryTurn`'s own doc).
 *
 * S63-a review fix (CP-5, the maintainer looking at the panel: a written
 * single showed twice, once filed here and once still live in `sentence`/
 * `status` underneath it). THIS is where a turn's life actually ends -- never
 * `fileOpenTurn` below, whose whole point is that the turn is NOT over yet --
 * so `sentence`/`status` are cleared back to idle here, the one place, rather
 * than a second idea elsewhere of "is this turn still current" (CLAUDE.md
 * §4). Every path that reaches this function (`finishTrace`, `settleTurn`'s
 * own still-current branch, `flushTraceOnTeardown`) gets it once. A caller
 * with its own last word for this instant -- a lot's "Done: N commands.", a
 * cancel's "Left it.", the "Nothing to say yes to." floor -- sets a fresh
 * `status` right after finishing, which simply replaces the `null` this
 * leaves; a call site that does not (a plain written single, a refusal, an
 * Escape) leaves the live area genuinely empty, and the thread just filed is
 * the only place that turn reads any more.
 */
function fileTurn(store: ConversationStore, entry: TraceEntry): void {
  const state = store.getState();
  // F-167: this entry may ALREADY be in the thread, filed as "Waiting: the
  // create pop-up" when the bar handed the write over. Patch that turn rather
  // than file a second one -- the thread shows one turn per sentence, and the
  // trace file still gets exactly one line (posted by whoever called this).
  if (state.filedTurnAt === entry.at) {
    state.updateTurn(entry.at, {
      asked: entry.asked,
      answered: entry.answered,
      ran: [...entry.ran],
      outcome: entry.outcome,
      offered: state.offered,
    });
    state.set({ filedTurnAt: null, sentence: null, status: null });
    return;
  }
  state.appendTurn({
    at: entry.at,
    heard: entry.heard,
    by: entry.by,
    read: entry.read,
    asked: entry.asked,
    offered: state.offered,
    answered: entry.answered,
    ran: [...entry.ran],
    outcome: entry.outcome,
  });
  state.set({ filedTurnAt: null, sentence: null, status: null });
}

/**
 * S62-b reviewer fix (D): THE ONE PLACE A WRITE'S ANSWER IS RECORDED.
 *
 * Both halves used to be half-done and in opposite directions: `settleWrite`'s
 * superseded branch called `postTrace` alone (a no-op, since the entry had
 * already been posted by the sentence that superseded it) and never touched
 * the thread; `popupReporterFor`'s updated the thread and posted nothing new.
 * Either way a write that landed after the next sentence started left `ran`
 * empty and `outcome` null somewhere.
 *
 * So: one function. The entry's own fields are already set by the caller; this
 * puts them in the thread AND in the file, whether the sentence is still the
 * current one or not.
 */
export function settleTurn(store: ConversationStore, entry: TraceEntry): void {
  if (store.getState().trace === entry) {
    // Still the current sentence -- the ordinary ending, one line.
    finishTrace(store);
    return;
  }
  // Superseded: the line is already in the file without this answer, and the
  // turn is already in the thread saying it was waiting. Correct both.
  store.getState().updateTurn(entry.at, {
    asked: entry.asked,
    answered: entry.answered,
    ran: [...entry.ran],
    outcome: entry.outcome,
  });
  postTrace(entry, { revise: true });
}

/**
 * F-167: files the OPEN entry into the thread without ending it -- the bar
 * calls this when a sentence is handed to the create pop-up, so the person
 * sees the turn (and its "Waiting: …" line) immediately instead of nothing at
 * all until the pop-up is answered. Nothing is posted to the trace file here;
 * that still happens once, when the entry is actually finished.
 */
export function fileOpenTurn(store: ConversationStore): void {
  const state = store.getState();
  const entry = state.trace;
  if (!entry) return;
  if (state.filedTurnAt === entry.at) {
    state.updateTurn(entry.at, {
      asked: entry.asked,
      answered: entry.answered,
      ran: [...entry.ran],
      outcome: entry.outcome,
      offered: state.offered,
    });
    return;
  }
  state.appendTurn({
    at: entry.at,
    heard: entry.heard,
    by: entry.by,
    read: entry.read,
    asked: entry.asked,
    offered: state.offered,
    answered: entry.answered,
    ran: [...entry.ran],
    outcome: entry.outcome,
  });
  state.set({ filedTurnAt: entry.at });
}

/** The teardown twin of `finishTrace` -- the board going away, or the page
 *  being hidden. */
export function flushTraceOnTeardown(store: ConversationStore): void {
  const entry = store.getState().trace;
  if (!entry) return;
  fileTurn(store, entry);
  store.getState().set({ trace: null });
  postTraceOnTeardown(entry);
}
