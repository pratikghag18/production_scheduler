/**
 * S195-D (DEF-0054, R-459, R-431): what the bar says while one of the board's
 * own pop-ups stands over a sentence it handed on. One plain sentence each,
 * built from the board's own facts, never the code's words ("re-time",
 * "attachment", "keep/scale", "pop-up", "standalone assignment") and never
 * the done-form readout -- nothing is done until the pop-up is answered.
 *
 * The maintainer chose these sentences (30 Sept); the two attachment variants
 * beyond "take off" (put on, move between) are the same shape for the two
 * other things that pop-up can ask, and are the only ones not quoted from him.
 */

const ANSWER_IT = "Answer it on the board.";

/** A person's name as the sentence says it; a departed person's row has none. */
function who(person: string | null): string {
  return person !== null && person !== "" ? person : "that person";
}

/** R-365: the block would leave its job. `from` and `to` are job names
 *  (the product, "Housing A"), null when there is no job on that side. */
export function attachmentWaiting(args: {
  person: string | null;
  from: string | null;
  to: string | null;
}): string {
  const name = who(args.person);
  if (args.from !== null && args.to === null) {
    return `The board is asking whether to take ${name} off the ${args.from} job. ${ANSWER_IT}`;
  }
  if (args.from === null && args.to !== null) {
    return `The board is asking whether to put ${name} on the ${args.to} job. ${ANSWER_IT}`;
  }
  if (args.from !== null && args.to !== null) {
    return `The board is asking whether to move ${name} from the ${args.from} job to the ${args.to} job. ${ANSWER_IT}`;
  }
  return `The board is asking whether to change the job ${name} is on. ${ANSWER_IT}`;
}

/** R-031: a typed target and a changed length -- keep the total or scale it. */
export function targetWaiting(person: string | null): string {
  return `The board is asking what to do with the target for ${who(person)}'s block. ${ANSWER_IT}`;
}

/** A job's new hours leave some of its crew outside them. */
export const CREW_OUTSIDE_WAITING = `The board is asking what to do with the people outside the job's new hours. ${ANSWER_IT}`;

/** The create pop-up, in any of its three forms (a person, a job, a move). */
export const CREATE_WAITING =
  "The board has opened the details for this one. Finish it on the board.";

/** Split coverage: the person is already booked over the hours asked for. */
export function splitWaiting(person: string | null): string {
  const name = person !== null && person !== "" ? person : "That person";
  return `${name} is already booked then. The board is asking how to split the time. ${ANSWER_IT}`;
}
