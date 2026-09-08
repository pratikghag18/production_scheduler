import { useEffect, useRef, useState } from "react";
import {
  applyCopyWeek,
  describeSchedulerError,
  fetchCopyWeekPlan,
  isSchedulerError,
  listWeekTemplates,
  type CopyWeekChoice,
  type CopyWeekClash,
  type CopyWeekItem,
  type CopyWeekPlan,
  type CopyWeekResult,
  type WeekTemplate,
} from "@/lib/api";
import { DEFAULT_DATE_FORMAT, type DateFormat } from "@/lib/format/dates";
import fieldStyles from "@/components/Field.module.css";
import { addMinutes, formatClock, formatDayLabel, formatFull, MINUTES_PER_DAY } from "../lib/time";
import { useSchedulerToast } from "../hooks/useSchedulerToast";
import { BoardPopover } from "./BoardPopover";
import styles from "./CopyWeekDialog.module.css";

/**
 * Copy Week (R-339 / S35).
 *
 * The maintainer's rule, verbatim: "For the copy week, if there are conflicts
 * lets present them to the user and let them decide what they want to keep, the
 * prior plan or the copied plan." So this screen does three things and nothing
 * else: it asks the server what copying one week onto another WOULD do
 * (`copy_week_plan`, which writes nothing); it lists every clash with both
 * candidates side by side and a control offering exactly the choices the
 * server said it would accept; and, once every clash has an answer, it sends
 * those answers in one call (`apply_copy_week`, one transaction).
 *
 * R-239: THE CHOICES ARE THE SERVER'S. `clash.choices` is rendered as-is and
 * never widened here -- a `["prior"]` item draws no "take the copied plan"
 * control, and says why beside the gap. The server recomputes the plan on
 * apply and refuses a choice it did not offer, so this is a courtesy that
 * keeps the screen honest rather than a second authority.
 *
 * The plan is fetched on open and again whenever the two dates change to a
 * pair the server would accept (a whole, non-zero number of weeks apart --
 * the same test `copy_week_plan` runs, so the screen never asks for what the
 * server will refuse, CLAUDE.md section 4). Answers are reset with the plan,
 * because an answer to a clash that no longer exists is not an answer.
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING, and no error is swallowed: a refusal from
 * either call is shown in the dialog with its sentence, and the dialog stays
 * open so the person can change something and try again.
 */
export function CopyWeekDialog({
  plantId,
  plantName,
  windowStart,
  anchor,
  dateFormat = DEFAULT_DATE_FORMAT,
  zone,
  isAdmin = true,
  initialSource,
  onClose,
  onApplied,
}: {
  plantId: string;
  plantName: string;
  /** The board window's first day, midnight UTC: the default source week. */
  windowStart: Date;
  anchor: { x: number; y: number };
  dateFormat?: DateFormat;
  zone?: string;
  /**
   * R-356: whether the caller may copy from another WEEK (admin only, the
   * server's `app_is_admin_for`). A placing supervisor gets the dialog too, but
   * only the "a template" source: Copy Week from a week stays admin-only, so
   * offering it here would be a control the server refuses (CLAUDE.md section 4).
   */
  isAdmin?: boolean;
  /**
   * R-358: which source the button that opened this dialog means — "Copy week"
   * passes "week", "Apply a template" passes "template". OPTIONAL, and its
   * absence must leave today's default (`isAdmin ? "week" : "template"}`)
   * exactly as it was: every existing caller and test still gets that answer.
   */
  initialSource?: "week" | "template";
  onClose: () => void;
  /** Called after a successful apply, before the dialog closes, so the board can refresh. */
  onApplied: (result: CopyWeekResult) => void;
}) {
  const toast = useSchedulerToast();
  // R-356: the source is another WEEK (today's flow) or a TEMPLATE. A caller
  // who cannot copy a week (a placing supervisor) starts on the template source.
  // R-358: `initialSource`, when the caller passes it, says which button opened
  // this dialog and wins outright; absent, the rule is exactly what it was.
  const [sourceMode, setSourceMode] = useState<"week" | "template">(
    initialSource ?? (isAdmin ? "week" : "template"),
  );
  const [templates, setTemplates] = useState<WeekTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [sourceStart, setSourceStart] = useState<Date>(windowStart);
  const [targetStart, setTargetStart] = useState<Date>(() =>
    addMinutes(windowStart, 7 * MINUTES_PER_DAY),
  );
  const usingTemplate = sourceMode === "template";
  const selectedTemplate = templates?.find((t) => t.id === templateId) ?? null;
  // The week-pair rule only governs a WEEK source; a template needs a chosen id.
  const weekProblem = usingTemplate ? null : describeWeekProblem(sourceStart, targetStart);
  const templateProblem = usingTemplate && templateId === null ? "Pick a template to copy." : null;

  // Fetch the plant's templates once the template source is chosen.
  useEffect(() => {
    if (!usingTemplate || templates !== null) return;
    let live = true;
    listWeekTemplates(plantId).then(
      (rows) => {
        if (!live) return;
        setTemplates(rows);
        setTemplateId((id) => id ?? rows[0]?.id ?? null);
      },
      (err: unknown) => {
        if (!live) return;
        setTemplates([]);
        setTemplatesError(describeCopyWeekError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [usingTemplate, templates, plantId]);

  const [plan, setPlan] = useState<CopyWeekPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, CopyWeekChoice>>({});
  const [applying, setApplying] = useState(false);
  // Bumped when the server says the plan it holds is not the one on screen
  // (an answer it did not offer, a key it does not know): the plan is read
  // again and the refusal stays on screen so the person knows why.
  const [planNonce, setPlanNonce] = useState(0);
  // The dates can change while a plan is in flight; only the newest request
  // may land, or a stale plan could be answered against fresh dates.
  const requestRef = useRef(0);

  useEffect(() => {
    if (weekProblem !== null || templateProblem !== null) {
      setPlan(null);
      setDecisions({});
      return;
    }
    const request = ++requestRef.current;
    setLoading(true);
    setPlanError(null);
    fetchCopyWeekPlan(
      usingTemplate
        ? { plantId, sourceStart: null, targetStart, templateId }
        : { plantId, sourceStart, targetStart },
    ).then(
      (next) => {
        if (request !== requestRef.current) return;
        setPlan(next);
        setDecisions({});
        setLoading(false);
      },
      (err: unknown) => {
        if (request !== requestRef.current) return;
        setPlan(null);
        setDecisions({});
        setPlanError(describeCopyWeekError(err));
        setLoading(false);
      },
    );
  }, [
    plantId,
    sourceStart,
    targetStart,
    weekProblem,
    templateProblem,
    usingTemplate,
    templateId,
    planNonce,
  ]);

  const clashes = plan === null ? [] : plan.items.filter((i) => i.status === "clash");
  const unanswered = clashes.filter((i) => decisions[i.key] === undefined);
  const applyDisabled = plan === null || loading || applying || unanswered.length > 0;

  async function apply(): Promise<void> {
    if (plan === null || applyDisabled) return;
    setApplying(true);
    setApplyError(null);
    try {
      const decisionList = clashes.map((i) => ({ key: i.key, choice: decisions[i.key] }));
      const result = await applyCopyWeek(
        usingTemplate
          ? { plantId, sourceStart: null, targetStart, templateId, decisions: decisionList }
          : { plantId, sourceStart, targetStart, decisions: decisionList },
      );
      toast.info(describeCopyWeekResult(result, targetStart, dateFormat, zone));
      onApplied(result);
      onClose();
    } catch (err) {
      setApplyError(describeCopyWeekError(err));
      setApplying(false);
      if (planDrifted(err)) setPlanNonce((n) => n + 1);
    }
  }

  return (
    <BoardPopover anchor={anchor} onClose={onClose} title="Copy week" variant="wide">
      <div className={styles.body}>
        <p className={styles.plant}>{plantName}</p>

        {/* R-356: the source is another week (admin) or a template. A
            supervisor who cannot copy a week only ever sees the template
            source, so the picker appears only where there is a real choice. */}
        {isAdmin && (
          <>
            <label htmlFor="cw-mode" className={styles.label}>
              Copy from
            </label>
            <select
              id="cw-mode"
              className={fieldStyles.field}
              value={sourceMode}
              onChange={(e) => {
                setSourceMode(e.target.value === "template" ? "template" : "week");
                setApplyError(null);
              }}
            >
              <option value="week">another week</option>
              <option value="template">a template</option>
            </select>
          </>
        )}

        {usingTemplate ? (
          <>
            <label htmlFor="cw-template" className={styles.label}>
              Template
            </label>
            <select
              id="cw-template"
              className={fieldStyles.field}
              value={templateId ?? ""}
              disabled={templates === null || templates.length === 0}
              onChange={(e) => {
                setTemplateId(e.target.value || null);
                setApplyError(null);
              }}
            >
              {templates !== null && templates.length === 0 && (
                <option value="">No templates saved for this plant yet</option>
              )}
              {(templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {templatesError !== null && (
              <p role="alert" className={styles.error}>
                {templatesError}
              </p>
            )}
          </>
        ) : (
          <>
            <label htmlFor="cw-source" className={styles.label}>
              Copy the week starting
            </label>
            <input
              id="cw-source"
              type="date"
              className={fieldStyles.field}
              value={toInputValue(sourceStart)}
              onChange={(e) => {
                const next = fromInputValue(e.target.value);
                if (next === null) return;
                setSourceStart(next);
                setApplyError(null);
              }}
            />
          </>
        )}
        <label htmlFor="cw-target" className={styles.label}>
          Into the week starting
        </label>
        <input
          id="cw-target"
          type="date"
          className={fieldStyles.field}
          value={toInputValue(targetStart)}
          onChange={(e) => {
            const next = fromInputValue(e.target.value);
            if (next === null) return;
            setTargetStart(next);
            setApplyError(null);
          }}
        />

        {weekProblem !== null && <p className={styles.note}>{weekProblem}</p>}
        {templateProblem !== null && <p className={styles.note}>{templateProblem}</p>}
        {loading && <p className={styles.note}>Working out what the copy would do…</p>}
        {planError !== null && (
          <p role="alert" className={styles.error}>
            {planError}
          </p>
        )}
        {applyError !== null && (
          <p role="alert" className={styles.error}>
            {applyError}
          </p>
        )}

        {plan !== null && !loading && (
          <>
            <p className={styles.counts}>
              {describeCounts(plan, usingTemplate ? (selectedTemplate?.name ?? null) : null)}
            </p>
            {plan.history.runs + plan.history.assignments > 0 && (
              <p className={styles.note}>{describeHistory(plan)}</p>
            )}
            {clashes.length > 0 && (
              <ol className={styles.clashes} aria-label="Clashes">
                {clashes.map((item) => (
                  <li key={item.key}>
                    <ClashRow
                      item={item}
                      dateFormat={dateFormat}
                      zone={zone}
                      choice={decisions[item.key]}
                      onChoose={(choice) => setDecisions((d) => ({ ...d, [item.key]: choice }))}
                    />
                  </li>
                ))}
              </ol>
            )}
          </>
        )}

        <div className={styles.row}>
          <button type="button" className={fieldStyles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={fieldStyles.primaryBtn}
            disabled={applyDisabled}
            onClick={() => void apply()}
          >
            {applying ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </BoardPopover>
  );
}

/**
 * One clash: the copied row's identity as the legend, the reason it clashes,
 * then the prior plan on the left and the copied plan on the right, each with
 * its control -- or, where the server offered no "copied", the reason why.
 */
function ClashRow({
  item,
  dateFormat,
  zone,
  choice,
  onChoose,
}: {
  item: CopyWeekItem;
  dateFormat: DateFormat;
  zone?: string;
  choice: CopyWeekChoice | undefined;
  onChoose: (choice: CopyWeekChoice) => void;
}) {
  // `clash` is non-null on every item this component is handed; the guard is
  // for the type, not for a case that can happen.
  const clash = item.clash;
  if (clash === null) return null;
  const legend = describeItem(item, dateFormat, zone);
  const offersPrior = clash.choices.includes("prior");
  const offersCopied = clash.choices.includes("copied");
  // A warn-policy clash (uncertified, or on leave) records an override when the
  // copied plan is taken; the banner says so (R-338 / R-357).
  const warn =
    (clash.reason === "not_eligible" || clash.reason === "absent") && clash.policy === "warn";

  return (
    <fieldset className={styles.clash}>
      <legend className={styles.legend}>{legend}</legend>
      <p className={styles.reason}>{describeReason(item, clash)}</p>
      <div className={styles.candidates}>
        <div className={styles.candidate}>
          <p className={styles.candidateTitle}>Prior plan</p>
          {clash.prior.map((p) => (
            <p key={p.id} className={styles.line}>
              {describeRow(p, dateFormat, p.kind === "assignment" && p.operatorName === null, zone)}
            </p>
          ))}
          {offersPrior && (
            <label className={styles.choice}>
              <input
                type="radio"
                name={item.key}
                value="prior"
                checked={choice === "prior"}
                onChange={() => onChoose("prior")}
              />
              Keep the prior plan
            </label>
          )}
        </div>
        <div className={styles.candidate}>
          <p className={styles.candidateTitle}>Copied plan</p>
          <p className={styles.line}>
            {describeRow(
              item.copied,
              dateFormat,
              item.kind === "assignment" && item.copied.operatorName === null,
              zone,
            )}
          </p>
          {offersCopied ? (
            <label className={styles.choice}>
              <input
                type="radio"
                name={item.key}
                value="copied"
                checked={choice === "copied"}
                onChange={() => onChoose("copied")}
              />
              Take the copied plan
            </label>
          ) : (
            <p className={styles.notOffered}>{describeNotOffered(clash)}</p>
          )}
        </div>
      </div>
      {warn && <p className={styles.warn}>{describeWarning(item)}</p>}
      {item.parentKey !== null && (
        <p className={styles.note}>
          Attached to a run in this list. If that run keeps the prior plan, this is skipped whatever
          is chosen here.
        </p>
      )}
    </fieldset>
  );
}

/* ---------------------------------------------------------------------------
 * The words. Pure and exported so the test can pin them without a render.
 * ------------------------------------------------------------------------- */

const MS_PER_DAY = MINUTES_PER_DAY * 60_000;

/**
 * The same test `copy_week_plan` runs before it reads anything: the two dates
 * must be a whole, non-zero number of weeks apart, either way. Null when the
 * pair is fine; otherwise the sentence to show instead of a plan.
 */
export function describeWeekProblem(source: Date, target: Date): string | null {
  const days = (target.getTime() - source.getTime()) / MS_PER_DAY;
  if (!Number.isFinite(days)) return "Both weeks need a date.";
  if (days === 0) return "The two weeks are the same week, so there is nothing to copy.";
  if (!Number.isInteger(days) || days % 7 !== 0) {
    return "The target week must be a whole number of weeks from the source week.";
  }
  return null;
}

export function describeCounts(plan: CopyWeekPlan, templateName?: string | null): string {
  const { clean, clash } = plan.counts;
  // R-356: name the template as the source where a week source would be implied.
  const from = templateName ? `From the template ${templateName}: ` : "";
  if (clean + clash === 0) {
    return templateName
      ? `The template ${templateName} is empty, so there is nothing to copy.`
      : "Nothing is scheduled in that week, so there is nothing to copy.";
  }
  const cleanText = `${clean} ${clean === 1 ? "item copies" : "items copy"} cleanly`;
  const clashText =
    clash === 0
      ? "nothing clashes with the prior plan"
      : `${clash} ${clash === 1 ? "clashes" : "clash"} with the prior plan and ${
          clash === 1 ? "needs" : "need"
        } an answer`;
  return `${from}${cleanText}; ${clashText}.`;
}

export function describeHistory(plan: CopyWeekPlan): string {
  const n = plan.history.runs + plan.history.assignments;
  return `${n} ${n === 1 ? "row is" : "rows are"} history (a deleted product or person) and ${
    n === 1 ? "stays" : "stay"
  } where ${n === 1 ? "it is" : "they are"}.`;
}

export function describeCopyWeekResult(
  result: CopyWeekResult,
  targetStart: Date,
  dateFormat: DateFormat,
  zone?: string,
): string {
  const week = `the week of ${formatDayLabel(targetStart, dateFormat, zone)}`;
  const created = result.created.runs + result.created.assignments;
  const parts: string[] = [];
  parts.push(
    created === 0
      ? `Nothing was copied into ${week}.`
      : `Copied ${plural(result.created.runs, "run")} and ${plural(
          result.created.assignments,
          "assignment",
        )} into ${week}.`,
  );
  const removed = result.removed.runs + result.removed.assignments;
  if (removed > 0) {
    parts.push(
      `Removed ${plural(result.removed.runs, "run")} and ${plural(
        result.removed.assignments,
        "assignment",
      )} from the prior plan.`,
    );
  }
  if (result.skipped > 0) {
    parts.push(`Skipped ${plural(result.skipped, "item")} attached to a run that was kept.`);
  }
  return parts.join(" ");
}

/**
 * A refusal, in the words of what was asked. The typed error carries the
 * server's `reason` and this dialog knows what each one means for a copy;
 * anything else falls through to the app's one sentence per error kind.
 */
export function describeCopyWeekError(err: unknown): string {
  if (!isSchedulerError(err)) return "Something went wrong. Please try again.";
  if (err.kind === "NotPermitted") {
    return "You do not administer this plant, so you cannot copy its weeks.";
  }
  if (err.kind === "InvalidArgument") {
    switch (err.reason) {
      case "not_a_plant":
        return "Copy week works on a whole plant, and the board is not showing one.";
      case "same_week":
        return "The two weeks are the same week, so there is nothing to copy.";
      case "not_whole_weeks":
        return "The target week must be a whole number of weeks from the source week.";
      case "undecided":
        return "Every clash needs an answer before anything is copied.";
      case "choice_not_offered":
        return "One of the answers is not a choice the server offered. The plan has changed; it has been refreshed.";
      case "unknown_key":
      case "duplicate_key":
        return "The plan has changed since it was read. It has been refreshed; please answer again.";
      default:
        return describeSchedulerError(err);
    }
  }
  return describeSchedulerError(err);
}

/** The refusals that mean the plan on screen is not the plan the server holds. */
const DRIFT_REASONS: ReadonlySet<string> = new Set([
  "undecided",
  "choice_not_offered",
  "unknown_key",
  "duplicate_key",
]);

export function planDrifted(err: unknown): boolean {
  return isSchedulerError(err) && err.kind === "InvalidArgument" && DRIFT_REASONS.has(err.reason);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * A person the server could not name. An assignment always has a person, so
 * this is never blank and never "no person": there is one, and the copy takes
 * them.
 *
 * ⚠️ IT USED TO READ "a person on loan from another plant", AND THAT SENTENCE
 * IS NOW UNTRUE OF EVERY LIVE ROW (R-345, migration 0058). It was a reasonable
 * reading of a null name when a cross-plant placement could exist: the caller
 * could not read that person's row, so the copy named the situation instead.
 * The table's own guard refuses such a placement outright now, override or no
 * override, so no live assignment holds someone from another plant and there is
 * nothing to be on loan. What is left is a name the read could not resolve for
 * some other reason, and the honest thing to print is that it is missing rather
 * than a story about why (F-099's rule: never blank, never invented).
 */
const UNNAMED = "(unnamed person)";

function describeItem(item: CopyWeekItem, dateFormat: DateFormat, zone?: string): string {
  const kind = item.kind === "run" ? "Run" : "Assignment";
  const who =
    item.kind === "run"
      ? (item.copied.productName ?? "no product")
      : (item.copied.operatorName ?? UNNAMED);
  return `${kind}: ${who} on ${item.copied.nodeName}, ${describeWhen(
    item.copied.start,
    item.copied.end,
    dateFormat,
    zone,
  )}`;
}

function describeRow(
  row: {
    nodeName: string;
    productName: string | null;
    operatorName: string | null;
    start: Date;
    end: Date;
  },
  dateFormat: DateFormat,
  personUnnamed = false,
  zone?: string,
): string {
  const parts = [row.nodeName];
  if (row.productName !== null) parts.push(row.productName);
  if (row.operatorName !== null) parts.push(row.operatorName);
  else if (personUnnamed) parts.push(UNNAMED);
  parts.push(describeWhen(row.start, row.end, dateFormat, zone));
  return parts.join(" · ");
}

function describeWhen(start: Date, end: Date, dateFormat: DateFormat, zone?: string): string {
  const sameDay = start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
  return `${formatFull(start, dateFormat, zone)}–${
    sameDay ? formatClock(end, zone) : formatFull(end, dateFormat, zone)
  }`;
}

function describeReason(item: CopyWeekItem, clash: CopyWeekClash): string {
  const person = item.copied.operatorName ?? UNNAMED;
  switch (clash.reason) {
    case "run_overlap":
      return `${item.copied.nodeName} already has a run at this time.`;
    case "operator_busy":
      return `${person} is already booked at this time.`;
    case "not_eligible":
      return clash.policy === "block"
        ? `${person} is not certified for ${item.copied.nodeName}, and this plant refuses that placement.`
        : `${person} is not certified for ${item.copied.nodeName}.`;
    case "absent":
      // R-357: an assignment over the person's absence, under the plant's policy.
      return clash.policy === "block"
        ? `${person} is on leave at this time, and this plant refuses that placement.`
        : `${person} is on leave at this time.`;
  }
}

function describeWarning(item: CopyWeekItem): string {
  const person = item.copied.operatorName ?? UNNAMED;
  const what =
    item.clash?.reason === "absent" ? "is on leave at this time" : "is not certified for this work";
  return `Warning: ${person} ${what}. Taking the copied plan places them anyway and records an override; keeping the prior plan does not.`;
}

/** Why the server offered only the prior plan (R-239). */
function describeNotOffered(clash: CopyWeekClash): string {
  if (clash.reason === "not_eligible" && clash.policy === "block") {
    return "Not offered: this plant refuses uncertified placements, so only the prior plan can be kept.";
  }
  if (clash.reason === "absent" && clash.policy === "block") {
    return "Not offered: this plant refuses placing someone who is on leave, so only the prior plan can be kept.";
  }
  return "Not offered: the prior plan is somewhere you cannot edit, so only the prior plan can be kept.";
}

/* ---------------------------------------------------------------------------
 * Date inputs hold `YYYY-MM-DD`; the app holds midnight UTC, the way the
 * board's own window field does (BoardToolbar).
 * ------------------------------------------------------------------------- */

function toInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fromInputValue(v: string): Date | null {
  if (!v) return null;
  const next = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(next.getTime()) ? null : next;
}
