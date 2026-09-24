/**
 * S72-a (R-456, F-222): the verb the board did not hear, offered as a choice.
 *
 * PRE-SEATED STUB (24 Sept, the main session): the signature both lanes code
 * against. Lane S72-a fills it in; lane S72-b calls it from `CommandBar.tsx`.
 * Until S72-a lands, this returns no guesses, so the bar behaves exactly as
 * before (the grammar hint or the grounding refusal).
 *
 * Same runtime-import rule as `grounded.ts` (commandPurity U1): the verb lists
 * are handed in by the caller, never imported from `parse.ts` at runtime.
 */
import type { VerbLists } from "./grounded";

/** One candidate reading of a sentence with a verb put in. `label` is the
 *  board's own reading of `sentence` (`formatCommand` of its parse), the
 *  words the button shows; `sentence` is the text the press runs. */
export interface VerbGuess {
  verb: string;
  sentence: string;
  label: string;
}

/**
 * The verbs a sentence with no (or a misheard) command word could have meant,
 * best first, at most three; `[]` when the sentence already carries a verb the
 * board knows, or has no shape of a command at all (no person, place, part or
 * hour), in which case the caller keeps its old answer.
 */
export function guessVerbs(_heard: string, _verbs: VerbLists): VerbGuess[] {
  return [];
}
