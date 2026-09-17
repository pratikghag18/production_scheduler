import { useEffect, useRef, useState } from "react";
import { SpeechBubble } from "@/components/icons";
import { CommandBar, type CommandBarProps } from "./CommandBar";
import { createConversationStore, flushTraceOnTeardown } from "../store/commandConversation";
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
 * only state. Every prop `CommandBar` takes is passed straight through; the
 * one addition on the wire is `onEscapeIdle` (a S48-a `CommandBar` prop),
 * bound here to `close` so the bar's own Escape rule — clear the status, then
 * the input, then (nothing left) tell whoever is listening — reaches this
 * panel's close without the bar knowing a panel exists around it.
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
 * so an outside mousedown — the toolbar, the day count, the zoom slider — and
 * Escape both close a panel that reopens showing exactly what stood.
 *
 * ⚠️ WHICH KEY CLOSES AND WHICH CANCELS. **Escape closes** — the header says
 * so and means it: inside the bar's input it first drops a standing question
 * (putting the sentence back in the box, F-162), then clears the input, then
 * reaches `onEscapeIdle` = `close`; from anywhere else in the panel it closes
 * outright. None of those cancels the conversation — closing is a person
 * looking at the board. **A cancel word cancels** ("no", "cancel", "stop",
 * "nope", "never mind", typed or spoken): that is the only thing that ends a
 * standing question without answering it, and the only thing besides a
 * finished readout or a new sentence that resets the store.
 *
 * This component also owns the trace entry's LAST resort (F-157): the bar
 * only flushes an entry still open at unmount when it owns its own store,
 * which it does not here — so the flush moves to this component's own
 * unmount, which is the board itself going away.
 *
 * `close` also decides where focus goes next (review fix: it used to leave
 * focus wherever the closing event found it, which for Escape and for a
 * mousedown on inert board chrome meant focus fell all the way back to
 * `<body>`). Escape and a mousedown on something NOT itself focusable both
 * move focus back to the launcher button, the nearest still-visible control
 * that was responsible for the panel in the first place. A mousedown on a
 * focusable element outside (another button, a field) is the one exception:
 * the browser is about to focus THAT element as part of the same click, so
 * `close` is told not to fight it (`refocusButton = false`) and leaves focus
 * where the click put it.
 *
 * "Outside" for the close-on-mousedown rule is decided by role, not by DOM
 * position: a pop-up the bar opens (`CreatePopover` and friends) is the
 * shared dialog shell (`src/components/Popover.tsx`, `role="dialog"`),
 * portaled to `document.body` and rendered by `BoardPage` as a SIBLING of
 * this component, not a descendant of the panel — an "inside the panel"
 * containment check alone would call a click inside one of those pop-ups
 * "outside" and close this panel out from under a sentence-opened create
 * pop-up mid-answer. Walking up from the click target for a `[role="dialog"]`
 * ancestor catches that pop-up wherever it is portaled, without this
 * component needing to know which pop-up is open or where `BoardPage` put it
 * — the simpler of the brief's two options, and the one chosen.
 *
 * This panel's own `role="dialog"` (R-396's contract: "the panel ...
 * `role="dialog"`") is a deliberate second entry in `popoverStandard.test.ts`'s
 * allowlist, not an oversight: the shared `<Popover>` shell computes its
 * position from an anchor point via `resolvePopoverPlacement` and sizes
 * itself from its own CSS module's `rem` width — exactly wrong for a panel
 * the mock pins to a fixed screen corner at a fixed px width. Composing
 * `<Popover>` here would fight both. Semantically this IS a dialog, so the
 * role is right; structurally it is not the shared shell's dialog, so it
 * does not compose it.
 */

const PANEL_ID = "command-launcher-panel";
const BAR_INPUT_ID = "command-bar-input";

/** The shared shell's own list (`src/components/Popover.tsx`'s
 *  `FOCUSABLE_SELECTOR`) -- not imported from there since that constant is
 *  private to the module, but the same set: elements a mousedown is about to
 *  focus itself, so `close` must not fight it for focus (review fix 2). */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface CommandLauncherProps extends CommandBarProps {
  /**
   * R-427: which thread this board is showing -- one person, one plant
   * (`historyStorageKey`). `null` (or omitted) while the board does not yet
   * know both: the thread still works for the session, it is simply not
   * persisted. Owned here rather than in `CommandBar` because the STORE is
   * owned here; the bar only renders whatever thread its store holds.
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

export function CommandLauncher({ historyKey = null, ...props }: CommandLauncherProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // F-163: ONE conversation per board mount. `useState`'s initialiser form,
  // never `createConversationStore()` inline -- a fresh store per render
  // would be a fresh conversation per render.
  const [conversation] = useState(createConversationStore);

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

  /** Review fix 2: `refocusButton` defaults to true (Escape, and a mousedown
   *  on something not itself focusable) -- the one caller that must NOT
   *  fight the browser for focus (a mousedown outside on a focusable
   *  element) passes `false` explicitly. */
  function close(refocusButton = true): void {
    setOpen(false);
    if (refocusButton) buttonRef.current?.focus();
  }

  /** Review fix 1: the panel's own Escape rule -- "Esc closes" has to hold
   *  from anywhere focus is inside the panel, not only the bar's input.
   *  When the event's target IS the input, this does nothing and leaves it
   *  to `CommandBar`'s own `onKeyDown` (bound directly on that element),
   *  which already runs first (bubbling) and calls `onEscapeIdle` only when
   *  it found nothing left to clear -- exactly the existing multi-Escape
   *  rule, untouched. Anything else inside the panel (the mic button, a
   *  candidate button, the header) has no handler of its own, so this is
   *  the only thing that would ever see that Escape. */
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

  // Close on a mousedown outside the panel and the button. See the module
  // doc above for why a `[role="dialog"]` ancestor is also exempted, and for
  // `refocusButton`'s one exception (a focusable element outside keeps the
  // focus the click itself is about to give it).
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent): void {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      const clickWillFocusItself = target instanceof Element && target.closest(FOCUSABLE_SELECTOR);
      close(!clickWillFocusItself);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

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
          ref={panelRef}
          role="dialog"
          aria-label="Tell the board"
          className={styles.panel}
          onKeyDown={handlePanelKeyDown}
        >
          <div className={styles.header}>
            <span className={styles.headerLabel}>Tell the board</span>
            <span>Esc closes</span>
          </div>
          <CommandBar {...props} onEscapeIdle={close} conversation={conversation} />
        </div>
      )}
    </>
  );
}
