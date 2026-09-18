import { useEffect, useRef, useState } from "react";
import { SpeechBubble } from "@/components/icons";
import { CommandBar, type CommandBarProps } from "./CommandBar";
import { createConversationStore, flushTraceOnTeardown } from "../store/commandConversation";
import { clampPanelSize, readPanelSize, writePanelSize, type PanelSize } from "../lib/panelSize";
import styles from "./CommandLauncher.module.css";

/**
 * S48-a — the corner launcher (brief docs/agent-briefs/s48-a-launcher-brief.md,
 * R-396, design §19.95/D124). The command bar leaves the top of the board and
 * becomes a round button fixed in the lower right; pressing it, or the slash
 * key, opens a panel above the button holding the bar exactly as it is. A
 * viewer never sees the button, the same way they never saw the bar (the
 * `canPlace` guard stays `BoardPage`'s — this component only owns whether the
 * panel is open once it is rendered at all).
 *
 * This component owns nothing the bar does not already own: `open` is its
 * only state (S63-a adds `size`, the panel's own remembered width/height --
 * see the resize section below). Every prop `CommandBar` takes is passed
 * straight through; the one addition on the wire is `onEscapeIdle` (a S48-a
 * `CommandBar` prop), bound here to `close` so the bar's own Escape rule --
 * clear the status, then the input, then (nothing left) tell whoever is
 * listening -- reaches this panel's close without the bar knowing a panel
 * exists around it.
 *
 * `onEscapeIdle` only ever fires for an Escape whose target IS the bar's own
 * input (that is where `CommandBar`'s `onKeyDown` is bound). The header's own
 * promise, "Esc closes", has to hold from anywhere focus can be inside the
 * panel — the mic button, a candidate button — so the panel wrapper carries
 * its own `onKeyDown` too (review fix, session after first landing): an
 * Escape whose target is NOT the input closes right there, since nothing
 * else in the tree is going to see it (`CommandBar` never attached a
 * handler to the mic/candidate buttons, only to its input).
 *
 * Closing never asks the bar to tidy up first: it unmounts `CommandBar`
 * outright, and unmounting is already the bar's own cue (S46-a/S47) to stop a
 * listening session, and (via the `onHighlight` cleanup effect) report the
 * highlight `null` — nothing here duplicates that.
 *
 * ⭐ F-163 — WHAT CLOSING MUST NOT TAKE WITH IT (the maintainer, 17 Sept:
 * "The chatbot also vanished when I moved the slider something which you
 * claimed would not happen"). That unmount used to destroy the whole
 * conversation, because the status, the held command, the pending question,
 * the lot and the open trace entry were `CommandBar`'s own refs. They are now
 * a store this component creates ONCE per board mount
 * (`../store/commandConversation.ts`) and hands to whichever bar is mounted,
 * so closing and reopening the panel shows exactly what stood.
 *
 * ⭐ S63-a / R-429 — THE PANEL NOW STAYS OPEN BESIDE THE BOARD. The maintainer
 * asked for a panel that behaves like an ordinary chat window: closing an
 * outside mousedown used to be the ONLY way most people ever closed it, and
 * that made it impossible to drag a block, move the zoom slider, or read a
 * cell while a question stood, without the panel vanishing out from under
 * you. So that effect, its exemptions and the constant that listed them
 * (`FOCUSABLE_SELECTOR`, the `[role="dialog"]` walk) are GONE — scrolling,
 * dragging and clicking the board or the toolbar all leave the panel open
 * now, on purpose. What is left as a close: the launcher button itself
 * (already toggled `open`), the panel header's own "Close" button, and
 * Escape from inside the panel (the two rules above, unchanged). `close`
 * always returns focus to the launcher button now — the one exception that
 * used to exist (a mousedown about to focus something else outside) went
 * with the effect it belonged to, since there is no more outside-mousedown
 * close for it to except.
 *
 * This component also owns the trace entry's LAST resort (F-157): the bar
 * only flushes an entry still open at unmount when it owns its own store,
 * which it does not here — so the flush moves to this component's own
 * unmount, which is the board itself going away.
 *
 * ⭐ S63-a / R-429 — RESIZABLE, REMEMBERED. The panel is anchored bottom-right
 * (`CommandLauncher.module.css`'s own `.panel`), so it can only grow from its
 * TOP and LEFT edges without the button underneath moving — a handle sits on
 * the top-left corner (and the top and left edges on their own, for a
 * one-axis drag) and turns a pointer drag into a new inline width/height,
 * clamped by `panelSize.ts`'s `clampPanelSize` to a floor and to the
 * viewport. The size is kept in ordinary `useState`, not the conversation
 * store — it is a property of the PANEL, not of what is being said, and a
 * closed panel has no size to keep in sync — and persisted per person
 * (`panelSize.ts`, keyed off `historyKey` exactly as the thread is, with its
 * own prefix so the two never collide in storage). A `historyKey` of `null`
 * still resizes for the session; it is simply not written to storage
 * (`writePanelSize`'s own contract).
 *
 * ⭐ S63-a REVIEW FIX — NO DEFAULT SIZE, EITHER (the maintainer, looking at
 * the panel on disk: "a tall remembered size, nothing in the thread ...
 * feels out of place and unprofessional"). `size` starts (and stays, across
 * a `historyKey` with nothing stored) at `null` -- no inline style at all,
 * so the panel sizes to its own content (`.panel`'s CSS width, 372px, the
 * mock's own number; the height whatever the header, the thread and the
 * input actually need). Only a drag, or a `historyKey` that DOES have a
 * saved size, ever puts an explicit width/height on it.
 *

 * This panel's own `role="dialog"` (R-396's contract: "the panel ...
 * `role="dialog"`") is a deliberate second entry in `popoverStandard.test.ts`'s
 * allowlist, not an oversight, and stays one after S63-a: the shared
 * `<Popover>` shell computes its position from an anchor point via
 * `resolvePopoverPlacement` and sizes itself from its own CSS module's `rem`
 * width -- exactly wrong for a panel pinned to a fixed screen corner and, now,
 * resized in px by the person looking at it. Composing `<Popover>` here would
 * fight both. Semantically this IS a dialog, so the role is right;
 * structurally it is not the shared shell's dialog, so it does not compose
 * it. It also carries no `aria-modal` and no backdrop (R-429: the board stays
 * fully usable beside it), which an ordinary dialog would.
 */

const PANEL_ID = "command-launcher-panel";
const BAR_INPUT_ID = "command-bar-input";

/**
 * S63-a review fix (the maintainer, looking at the panel on disk: "a tall
 * remembered size, nothing in the thread ... feels out of place and
 * unprofessional"): this is no longer the panel's own default SIZE -- with
 * nothing ever dragged and nothing stored, the panel carries no inline size
 * at all (`size` stays `null`, below) and sizes itself to its content, the
 * same as any ordinary box; `.panel`'s own CSS still gives it its width
 * (372px, the mock's own number). This constant is now only the DRAG MATH's
 * starting point -- `startResize`'s `size ?? DEFAULT_PANEL_SIZE` -- so a
 * first drag (from a content-sized panel jsdom and a real browser both
 * measure differently) has a sane, deterministic number to grow from.
 */
const DEFAULT_PANEL_SIZE: PanelSize = { width: 372, height: 480 };

function currentViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export interface CommandLauncherProps extends CommandBarProps {
  /**
   * R-427: which thread this board is showing -- one person, one plant
   * (`historyStorageKey`). `null` (or omitted) while the board does not yet
   * know both: the thread still works for the session, it is simply not
   * persisted. Owned here rather than in `CommandBar` because the STORE is
   * owned here; the bar only renders whatever thread its store holds.
   *
   * S63-a: the panel's remembered SIZE is keyed off this same value (its own
   * prefix, `panelSize.ts`) for the same reason -- one person's board, one
   * remembered shape.
   */
  historyKey?: string | null;
}

/** True when `target` is (or is inside) an input, a textarea, or any
 *  contenteditable element -- the slash key must not open the panel while
 *  someone is typing into one of those (brief §2 item 2). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  return target.isContentEditable;
}

/** S63-a: which edges a drag handle grows. A corner handle changes both; an
 *  edge handle on its own changes only the one dimension it sits on. */
type ResizeAxis = "both" | "width" | "height";

export function CommandLauncher({ historyKey = null, ...props }: CommandLauncherProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // F-163: ONE conversation per board mount. `useState`'s initialiser form,
  // never `createConversationStore()` inline -- a fresh store per render
  // would be a fresh conversation per render.
  const [conversation] = useState(createConversationStore);
  // S63-a review fix (the maintainer): `null` until EITHER a stored size is
  // loaded or a drag sets one -- the panel then carries no inline size at
  // all and sizes to its content (`.panel`'s own CSS gives it its width;
  // the height is whatever the header + thread + input actually need). Only
  // once a size exists here (loaded or dragged) does the panel get an
  // explicit, persisted width/height.
  const [size, setSize] = useState<PanelSize | null>(null);
  // CR-2 (reviewer fix): the drag in progress, if any -- a plain ref, not
  // state, since only `pointermove`'s own math needs it and a ref update
  // must not itself trigger a render (`setSize` below already does that).
  // `null` outside an active drag; `latest` is what gets persisted on
  // release, since `size` from this closure would still read the value from
  // BEFORE this drag's `setSize` calls.
  const resizeRef = useRef<{
    axis: ResizeAxis;
    startX: number;
    startY: number;
    startSize: PanelSize;
    latest: PanelSize;
    pointerId: number;
  } | null>(null);

  // F-157, moved here from `CommandBar` (see the module doc): this component
  // going away IS the board going away, so an entry still open then is the
  // one that would genuinely be lost. The panel merely closing is not.
  useEffect(() => {
    return () => flushTraceOnTeardown(conversation);
  }, [conversation]);

  // R-427: point the store at this person's thread for this plant and load
  // whatever it already holds (pruned to the last day). Runs whenever either
  // half changes -- signing in as somebody else, or opening another plant's
  // board, is a different thread, never a continuation of this one.
  useEffect(() => {
    conversation.getState().useHistoryKey(historyKey);
  }, [conversation, historyKey]);

  // S63-a review fix: the panel's remembered size, same key, same trigger --
  // but ONLY when one was actually saved. A missing or corrupt stored value
  // (`readPanelSize`'s own contract) leaves `size` at `null` (content-sized),
  // never a default forced on a panel nobody has resized yet.
  useEffect(() => {
    const stored = readPanelSize(historyKey);
    setSize(stored !== null ? clampPanelSize(stored, currentViewport()) : null);
  }, [historyKey]);

  /** R-429: `close` always returns focus to the launcher button now -- the
   *  one exception S48-a carried (a mousedown about to focus something else
   *  outside) belonged to the outside-mousedown close this session removed,
   *  and went with it. */
  function close(): void {
    setOpen(false);
    buttonRef.current?.focus();
  }

  /** The panel's own Escape rule -- "Esc closes" has to hold from anywhere
   *  focus is inside the panel, not only the bar's input. When the event's
   *  target IS the input, this does nothing and leaves it to `CommandBar`'s
   *  own `onKeyDown` (bound directly on that element), which already runs
   *  first (bubbling) and calls `onEscapeIdle` only when it found nothing
   *  left to clear -- exactly the existing multi-Escape rule, untouched.
   *  Anything else inside the panel (the mic button, a candidate button, the
   *  header) has no handler of its own, so this is the only thing that would
   *  ever see that Escape. */
  function handlePanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== "Escape") return;
    if (e.target instanceof HTMLElement && e.target.id === BAR_INPUT_ID) return;
    close();
  }

  // Slash opens the panel from anywhere on the page, provided no input,
  // textarea or contenteditable currently has focus. Removed on unmount
  // (brief §2 item 2).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== "/" || open) return;
      if (isEditableTarget(document.activeElement)) return;
      e.preventDefault();
      setOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Focus the bar's input once the panel has mounted. The bar already has an
  // internal `inputRef`; rather than thread a focus method through a new ref
  // prop (the brief's other option), this reaches the input the same way the
  // bar names it to everyone else -- its own id -- which keeps `CommandBar`
  // itself untouched beyond the two named changes.
  useEffect(() => {
    if (!open) return;
    document.getElementById(BAR_INPUT_ID)?.focus();
  }, [open]);

  /**
   * S63-a: a pointer drag on a resize handle. `axis` picks which of
   * width/height this handle changes (the corner handle passes "both"; the
   * top and left edge handles pass "height"/"width" respectively). Dragging
   * UP or LEFT grows the panel (it is anchored at its bottom-right corner),
   * so the delta is (start - current), not (current - start).
   *
   * Listens on `document`, not the handle itself: a fast drag routinely
   * outruns the handle's own bounding box, and a lost pointer capture must
   * not leave the panel stuck mid-resize. `latest` (a plain variable, not
   * state) is what gets written to storage on release -- `size` itself would
   * still read the value from BEFORE this render's `setSize`, a stale read
   * `useState` warns about for exactly this reason.
   *
   * `size ?? DEFAULT_PANEL_SIZE`: the FIRST drag ever, on a panel that has
   * never been sized before, starts the math from the default rather than
   * `null` -- there is no inline size to read a real number back from yet.
   * Every later drag (and every reopen once one has been saved) reads the
   * real, remembered `size`.
   *
   * CR-2 (reviewer fix, S63 review): this used to track the drag with plain
   * `document.addEventListener("pointermove"/"pointerup", ...)` and no
   * `setPointerCapture` at all -- the one thing D33
   * (`useDragGesture.ts`'s own doc) exists to warn about. A release OUTSIDE
   * the browser window (or over an iframe, or anywhere the OS delivers the
   * mouse-up to something other than this document) never reaches
   * `document` as a `pointerup` at all, so the listeners were never removed:
   * the next hover back over the page kept resizing the panel with no
   * button held, until some unrelated click elsewhere finally fired a
   * `pointerup` to clean up. `setPointerCapture` on the handle at
   * `pointerdown` is the same fix every other drag in this codebase already
   * uses -- the browser then routes pointermove/pointerup/pointercancel for
   * this pointer to the handle itself regardless of where the cursor ends
   * up, so the handlers can live as ordinary `onPointerMove`/`onPointerUp`/
   * `onPointerCancel` props on the handle rather than a manual
   * document-level subscription, and `pointercancel` (the browser taking
   * the gesture over, e.g. a touch scroll) ends the drag exactly like a
   * `pointerup` would instead of leaving it stuck.
   */
  function handleResizePointerDown(
    axis: ResizeAxis,
  ): (e: React.PointerEvent<HTMLDivElement>) => void {
    return (e) => {
      e.preventDefault();
      const startSize = size ?? DEFAULT_PANEL_SIZE;
      resizeRef.current = {
        axis,
        startX: e.clientX,
        startY: e.clientY,
        startSize,
        latest: startSize,
        pointerId: e.pointerId,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    };
  }

  function handleResizePointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = drag.startX - e.clientX;
    const dy = drag.startY - e.clientY;
    const next = clampPanelSize(
      {
        width: drag.axis === "height" ? drag.startSize.width : drag.startSize.width + dx,
        height: drag.axis === "width" ? drag.startSize.height : drag.startSize.height + dy,
      },
      currentViewport(),
    );
    drag.latest = next;
    setSize(next);
  }

  /** Ends a resize on either `pointerup` or `pointercancel` -- see the CR-2
   *  doc above for why both matter here. */
  function endResize(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    resizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    writePanelSize(historyKey, drag.latest);
  }

  // Close on a mousedown outside the panel and the button: REMOVED, S63-a
  // (R-429) -- see the module doc's own section on why. The panel now closes
  // only by the launcher button, the header's "Close" button, and Escape.

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={open ? `${styles.launch} ${styles.open}` : styles.launch}
        aria-label="Tell the board"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <svg
            viewBox="0 0 24 24"
            width={24}
            height={24}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M7 7l10 10M17 7L7 17" />
          </svg>
        ) : (
          <SpeechBubble size={24} />
        )}
      </button>
      {open && (
        <div
          id={PANEL_ID}
          role="dialog"
          aria-label="Tell the board"
          className={styles.panel}
          // S63-a review fix: no inline size at all until one exists (loaded
          // or dragged) -- `undefined` leaves `.panel`'s own CSS (width
          // 372px, height auto to content) in charge.
          style={size !== null ? { width: size.width, height: size.height } : undefined}
          onKeyDown={handlePanelKeyDown}
        >
          {/* S63-a: the top-left corner handle resizes both dimensions at
              once; the top and left edges on their own resize one. CR-2: the
              drag is tracked with `setPointerCapture` on the handle itself
              (D33, `useDragGesture.ts`'s own convention), never a raw
              `document` subscription -- see `handleResizePointerDown`'s own
              doc for why. */}
          <div
            className={styles.resizeCorner}
            onPointerDown={handleResizePointerDown("both")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            aria-hidden="true"
          />
          <div
            className={styles.resizeTop}
            onPointerDown={handleResizePointerDown("height")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            aria-hidden="true"
          />
          <div
            className={styles.resizeLeft}
            onPointerDown={handleResizePointerDown("width")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            aria-hidden="true"
          />
          <div className={styles.header}>
            <span className={styles.headerLabel}>Tell the board</span>
            <button type="button" className={styles.closeButton} onClick={() => close()}>
              Close
            </button>
          </div>
          <CommandBar {...props} onEscapeIdle={close} conversation={conversation} />
        </div>
      )}
    </>
  );
}
