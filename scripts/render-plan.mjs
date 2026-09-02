#!/usr/bin/env node
// scripts/render-plan.mjs — validate docs/plan.yaml (+ docs/defects/*.md) and render docs/plan.html.
//
//   npm run plan            validate, then write docs/plan.html
//   npm run plan -- --check validate only (CI and the tester run this)
//
// WHY IT VALIDATES. The plan file replaced three hand-maintained documents that drifted apart
// because nothing compared them. This script is the thing that compares: an unknown id, a stage
// naming a requirement that does not exist, a session entry with no test count, or a defect that
// violates a requirement nobody wrote all fail here, loudly, with the path of the offending entry.
// The rendered page is a VIEW of the file and is never edited by hand. See docs/plan-format.md.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN = join(ROOT, "docs", "plan.yaml");
const DEFECTS_DIR = join(ROOT, "docs", "defects");
const OUT = join(ROOT, "docs", "plan.html");
const CHECK_ONLY = process.argv.includes("--check");

// ---------------------------------------------------------------- style (the gameplan's own, kept)
const CSS = String.raw`
:root{--ground:#EFF2F5;--surface:#FFFFFF;--surface-2:#E4E9EE;--line:#C8D2DB;--line-soft:#DCE3E9;
--ink:#16202B;--ink-2:#43535F;--ink-3:#6D7C88;--accent:#1F6FB2;--accent-soft:#DCEAF5;--amber:#9A6212;
--amber-soft:#F6E9D3;--green:#28684A;--green-soft:#D9EADF;--red:#A63A32;--red-soft:#F6DEDB;
--shadow:0 1px 2px rgba(22,32,43,.06),0 8px 24px -16px rgba(22,32,43,.35)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#0E141A;--surface:#161F27;
--surface-2:#1E2A34;--line:#2C3A46;--line-soft:#22303B;--ink:#DEE6ED;--ink-2:#A6B4C0;--ink-3:#7A8996;
--accent:#6BB3E8;--accent-soft:#16303F;--amber:#DDA451;--amber-soft:#33280F;--green:#6FC195;
--green-soft:#12291D;--red:#E88A80;--red-soft:#301715;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -16px rgba(0,0,0,.8)}}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font-family:"Source Sans 3","Segoe UI",system-ui,sans-serif;
font-size:17px;line-height:1.6;margin:0;padding:0 20px 88px}
.wrap{max-width:920px;margin:0 auto}
h1,h2,h3{font-family:Archivo,"Segoe UI",system-ui,sans-serif;text-wrap:balance;margin:0}
h1{font-size:clamp(32px,5vw,46px);font-weight:700;letter-spacing:-.025em;line-height:1.08}
h2{font-size:22px;font-weight:600;letter-spacing:-.01em}
h3{font-size:17px;font-weight:600;letter-spacing:-.005em}
p{margin:0}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.eyebrow{font-family:Archivo,sans-serif;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
code{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.86em;background:var(--surface-2);padding:.1em .34em;border-radius:3px}
header{padding:54px 0 26px;display:flex;flex-direction:column;gap:13px}
.sub{color:var(--ink-2);font-size:19px;max-width:62ch}
section{padding:38px 0 0;display:flex;flex-direction:column;gap:16px}
.rule{height:1px;background:var(--line-soft);border:0;margin:30px 0 0}
.glance{background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);overflow-x:auto}
.glance table{border-collapse:collapse;width:100%}
.glance caption{text-align:left;padding:13px 16px 9px;font-size:13px;color:var(--ink-3)}
.glance td{padding:7px 16px;border-top:1px solid var(--line-soft);font-size:14.5px;vertical-align:top}
.glance td.chipcol{text-align:right;white-space:nowrap}
.glance .g-n{font-family:"IBM Plex Mono",monospace;font-size:13px;color:var(--ink-3);width:5rem;font-variant-numeric:tabular-nums;white-space:nowrap}
.glance tr.g-now td,.glance tr.g-next td{background:var(--surface-2)}
.glance tr.r-contradicted td{background:var(--red-soft)}
.glance table.fixed{table-layout:fixed}
.glance table.fixed td{overflow-wrap:anywhere}
.glance tr.r-superseded td{color:var(--ink-3)}
.grouphead{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-family:Archivo,sans-serif}
.donefold{border:1px solid var(--line);border-radius:8px;background:var(--surface-2)}
.donefold>summary{cursor:pointer;padding:13px 16px;font-size:14.5px;color:var(--ink-2)}
.donefold[open]>summary{border-bottom:1px solid var(--line-soft)}
.donefold>.stages,.donefold>.inner{padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.donefold>.inner p{font-size:15px;color:var(--ink-2)}
.stages{display:flex;flex-direction:column;gap:10px}
.stage{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:16px 20px 16px 18px;display:grid;
grid-template-columns:34px 1fr auto;gap:4px 15px;align-items:start;border-left:3px solid var(--line)}
.stage.done{border-left-color:var(--green)}
.stage.now{border-left-color:var(--amber);box-shadow:var(--shadow)}
.stage.open{border-left-color:var(--accent)}
.num{font-family:"IBM Plex Mono",monospace;font-size:13px;color:var(--ink-3);font-weight:500;padding-top:2px;font-variant-numeric:tabular-nums}
.stage h3{grid-column:2}
.stage>.what,.stage>.state,.stage>.measure,.stage>.fine{grid-column:2}
.what{color:var(--ink-2);font-size:15.5px;line-height:1.5;display:flex;flex-direction:column;gap:8px}
.what ul{margin:0;padding-left:1.1rem}
.state{font-size:14.5px;color:var(--ink-3);line-height:1.5;padding-top:7px;border-top:1px solid var(--line-soft);margin-top:7px}
.state b{color:var(--ink-2);font-weight:600}
.tags{grid-column:3;grid-row:1 / span 6;display:flex;flex-direction:column;gap:5px;align-items:flex-end}
.chip{font-family:Archivo,sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:3px 9px;border-radius:99px;white-space:nowrap}
.chip.done{background:var(--green-soft);color:var(--green)}
.chip.now{background:var(--amber-soft);color:var(--amber)}
.chip.next{background:var(--accent-soft);color:var(--accent)}
.chip.q{background:var(--surface-2);color:var(--ink-3)}
.chip.bad{background:var(--red-soft);color:var(--red)}
.chip.mine{background:transparent;color:var(--ink-3);border:1px solid var(--line)}
.chip.yours{background:transparent;color:var(--amber);border:1px solid var(--amber)}
.band{background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);display:grid;
grid-template-columns:repeat(auto-fit,minmax(160px,1fr));overflow:hidden}
.stat{padding:16px 20px;border-right:1px solid var(--line-soft);display:flex;flex-direction:column;gap:3px}
.stat:last-child{border-right:0}
.stat .n{font-family:Archivo,sans-serif;font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.1}
.stat .l{font-size:13px;color:var(--ink-3)}
.stat.ok .n{color:var(--green)}
.stat.act .n{color:var(--amber)}
.find{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:19px 23px;display:flex;flex-direction:column;gap:10px}
.find p{font-size:15.5px;color:var(--ink-2);line-height:1.5}
.find ul{margin:0;padding-left:1.1rem;font-size:15.5px;color:var(--ink-2)}
.find .tag{font-family:Archivo,sans-serif;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--red)}
.find.fix .tag{color:var(--green)}
.measure{background:var(--ground);border:1px solid var(--line-soft);border-radius:5px;padding:10px 13px;font-family:"IBM Plex Mono",monospace;
font-size:12.5px;line-height:1.75;overflow-x:auto;white-space:pre;color:var(--ink-2)}
.fine{font-size:13.5px;color:var(--ink-3)}
.lead{font-size:18px;color:var(--ink-2);max-width:64ch}
div.lead{display:flex;flex-direction:column;gap:8px}
footer{margin-top:42px;padding-top:16px;border-top:1px solid var(--line-soft);font-size:13.5px;color:var(--ink-3)}
`;

// ---------------------------------------------------------------- load
let plan;
try {
  plan = yaml.load(readFileSync(PLAN, "utf8"));
} catch (e) {
  console.error(`plan.yaml does not parse: ${e.message}`);
  process.exit(1);
}
const defects = readdirSync(DEFECTS_DIR)
  .filter((f) => /^DEF-\d{4}\.md$/.test(f))
  .sort()
  .map((f) => parseDefect(join(DEFECTS_DIR, f), f));

function parseDefect(path, name) {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { _file: name, _error: "no YAML front matter" };
  let meta;
  try {
    meta = yaml.load(m[1]);
  } catch (e) {
    return { _file: name, _error: `front matter does not parse: ${e.message}` };
  }
  return { ...meta, body: m[2].trim(), _file: name };
}

// ---------------------------------------------------------------- validate
const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const ENUMS = {
  stageStatus: ["done", "now", "open", "parked"],
  owner: ["agent", "maintainer"],
  reqStatus: ["covered", "uncovered", "contradicted", "superseded"],
  statedBy: ["maintainer", "agent", "brief"],
  verifyKind: ["vitest", "sql", "e2e", "mutation", "manual", "screen"],
  findingStatus: ["fixed", "open", "owed", "wontfix"],
  foundBy: ["maintainer", "agent", "test", "tester", "reviewer"],
  defectStatus: ["open", "fix-claimed", "verified", "reopened", "wontfix"],
  severity: ["blocker", "major", "minor", "cosmetic"],
};
const isList = (v) => Array.isArray(v);
// YAML reads an unquoted 2026-09-02 as a Date; accept both and print both the same way.
const isDate = (v) => v instanceof Date || /^\d{4}-\d{2}-\d{2}$/.test(String(v));
const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const need = (where, obj, key, test = nonEmpty) => {
  if (!(key in obj) || !test(obj[key])) fail(where, `missing or invalid \`${key}\``);
};
const inEnum = (where, obj, key, list) => {
  if (!list.includes(obj[key])) fail(where, `\`${key}\` must be one of ${list.join(" | ")}`);
};

for (const key of ["meta", "tracks", "stages", "requirements", "findings", "sessions", "next"]) {
  if (!(key in plan)) fail("plan.yaml", `top-level \`${key}\` is missing`);
}
if (errors.length) report();

need("meta", plan.meta, "title");
need("meta", plan.meta, "updated", isDate);
need("meta", plan.meta, "tip");
need("meta", plan.meta, "baseline", (v) => v && typeof v === "object");

const ids = new Map();
const claim = (id, where) => {
  if (ids.has(id)) fail(where, `id \`${id}\` is already used by ${ids.get(id)}`);
  else ids.set(id, where);
};
const trackIds = new Set();
for (const t of plan.tracks) {
  need(`tracks[${t.id}]`, t, "id");
  need(`tracks[${t.id}]`, t, "title");
  trackIds.add(t.id);
}
const stageIds = new Set(plan.stages.map((s) => s.id));
const reqIds = new Set(plan.requirements.map((r) => r.id));
const findIds = new Set(plan.findings.map((f) => f.id));

for (const s of plan.stages) {
  const w = `stage ${s.id}`;
  claim(s.id, w);
  need(w, s, "title");
  need(w, s, "what");
  need(w, s, "num", (v) => Number.isInteger(v));
  if (!trackIds.has(s.track)) fail(w, `track \`${s.track}\` is not in tracks`);
  inEnum(w, s, "status", ENUMS.stageStatus);
  inEnum(w, s, "owner", ENUMS.owner);
  for (const r of s.delivers ?? [])
    if (!reqIds.has(r)) fail(w, `delivers unknown requirement ${r}`);
}

for (const r of plan.requirements) {
  const w = `requirement ${r.id}`;
  claim(r.id, w);
  need(w, r, "title");
  need(w, r, "claim");
  need(w, r, "source", (v) => isList(v) && v.length > 0);
  inEnum(w, r, "stated_by", ENUMS.statedBy);
  inEnum(w, r, "status", ENUMS.reqStatus);
  if (!isList(r.verified_by)) fail(w, "`verified_by` must be a list (empty means uncovered)");
  for (const v of r.verified_by ?? []) {
    inEnum(`${w} verified_by`, v, "kind", ENUMS.verifyKind);
    if (v.kind === "manual" || v.kind === "screen") need(`${w} verified_by`, v, "steps");
    else need(`${w} verified_by`, v, "file");
  }
  const real = (r.verified_by ?? []).filter((v) => v.kind !== "manual" && v.kind !== "screen");
  if (r.status === "covered" && real.length === 0) {
    fail(w, "status is `covered` but nothing non-manual verifies it");
  }
  if (r.status === "uncovered" && real.length > 0) {
    fail(w, "status is `uncovered` but a test is named — make it `covered` or drop the test");
  }
  if (r.superseded_by && !reqIds.has(r.superseded_by)) {
    fail(w, `superseded_by ${r.superseded_by} does not exist`);
  }
  if (r.status === "superseded" && !r.superseded_by && !nonEmpty(r.note)) {
    fail(w, "superseded needs `superseded_by` or a `note` saying by what");
  }
}

for (const f of plan.findings) {
  const w = `finding ${f.id}`;
  claim(f.id, w);
  need(w, f, "title");
  need(w, f, "story");
  inEnum(w, f, "status", ENUMS.findingStatus);
  inEnum(w, f, "found_by", ENUMS.foundBy);
  if (f.stage && !stageIds.has(f.stage)) fail(w, `stage ${f.stage} does not exist`);
  for (const r of f.violates ?? [])
    if (!reqIds.has(r)) fail(w, `violates unknown requirement ${r}`);
}

let confirmedSeen = false;
for (const s of plan.sessions) {
  const w = `session ${s.id}`;
  claim(`session:${s.id}`, w);
  need(w, s, "title");
  need(w, s, "summary");
  need(w, s, "date", isDate);
  if (typeof s.confirmed !== "boolean") fail(w, "`confirmed` must be true or false");
  if (!s.numbers || typeof s.numbers !== "object") fail(w, "`numbers` is missing");
  else {
    for (const k of ["app_tests", "app_test_files"]) {
      if (!(k in s.numbers)) fail(w, `numbers.${k} is missing (write null if unknown)`);
      else if (s.numbers[k] === null && s.confirmed) fail(w, `confirmed but numbers.${k} is null`);
      else if (s.numbers[k] !== null && !Number.isInteger(s.numbers[k])) {
        fail(w, `numbers.${k} must be an integer`);
      }
    }
  }
  for (const st of s.shipped ?? []) if (!stageIds.has(st)) fail(w, `shipped unknown stage ${st}`);
  if (s.confirmed) confirmedSeen = true;
}
if (!confirmedSeen)
  fail("sessions", "no session has `confirmed: true`; the numbers band has no source");

for (const [i, n] of (plan.next ?? []).entries()) {
  const w = `next[${i}]`;
  if (n.stage && !stageIds.has(n.stage)) fail(w, `stage ${n.stage} does not exist`);
  if (n.requirement && !reqIds.has(n.requirement))
    fail(w, `requirement ${n.requirement} does not exist`);
  if (!n.stage && !n.requirement && !nonEmpty(n.text))
    fail(w, "needs `stage`, `requirement` or `text`");
  need(w, n, "why");
}

for (const [i, b] of (plan.backlog ?? []).entries()) {
  const w = `backlog[${i}]`;
  need(w, b, "text");
  need(w, b, "phase", (v) => v !== undefined && String(v).length > 0);
  inEnum(w, b, "status", ["done", "partial", "open"]);
  if (b.stage && !stageIds.has(b.stage)) fail(w, `stage ${b.stage} does not exist`);
}

const contradicted = new Set();
for (const d of defects) {
  const w = `defect ${d._file}`;
  if (d._error) {
    fail(w, d._error);
    continue;
  }
  claim(d.id, w);
  if (`${d.id}.md` !== d._file) fail(w, `id ${d.id} does not match the file name`);
  need(w, d, "title");
  need(w, d, "class");
  need(w, d, "filed", isDate);
  need(w, d, "filed_by");
  inEnum(w, d, "severity", ENUMS.severity);
  inEnum(w, d, "status", ENUMS.defectStatus);
  if (!isList(d.violates) || d.violates.length === 0)
    fail(w, "`violates` must name at least one requirement");
  for (const r of d.violates ?? []) {
    if (!reqIds.has(r)) fail(w, `violates unknown requirement ${r}`);
    else if (d.status === "open" || d.status === "reopened" || d.status === "fix-claimed")
      contradicted.add(r);
  }
  if (d.status === "fix-claimed" && !nonEmpty(d.fix_commit))
    fail(w, "fix-claimed needs `fix_commit`");
  if (d.status === "verified" && !nonEmpty(d.fix_commit)) fail(w, "verified needs `fix_commit`");
  if (d.pin && !existsSync(join(ROOT, d.pin))) fail(w, `pin ${d.pin} does not exist on disk`);
  for (const h of ["## Reproduction", "## Expected", "## Actual"]) {
    if (!d.body.includes(h)) fail(w, `body is missing the \`${h}\` section`);
  }
}
for (const r of plan.requirements) {
  if (r.status === "contradicted" && !contradicted.has(r.id)) {
    fail(
      `requirement ${r.id}`,
      "status is `contradicted` but no open defect names it under `violates`",
    );
  }
  if (r.status !== "contradicted" && r.status !== "superseded" && contradicted.has(r.id)) {
    fail(`requirement ${r.id}`, "an open defect violates it — set status to `contradicted`");
  }
}
report();

function report() {
  if (errors.length === 0) return;
  console.error(`plan.yaml: ${errors.length} problem${errors.length === 1 ? "" : "s"}`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

// ---------------------------------------------------------------- summarise
const newestConfirmed = plan.sessions.find((s) => s.confirmed);
const newest = plan.sessions[0];
const counts = {
  stages: countBy(plan.stages, "status"),
  reqs: countBy(plan.requirements, "status"),
  findings: countBy(plan.findings, "status"),
  defects: countBy(defects, "status"),
};
function countBy(list, key) {
  const out = {};
  for (const x of list) out[x[key]] = (out[x[key]] ?? 0) + 1;
  return out;
}
const openDefects = defects.filter((d) => ["open", "reopened", "fix-claimed"].includes(d.status));
console.log(
  `plan.yaml ok — ${plan.stages.length} stages, ${plan.requirements.length} requirements ` +
    `(${counts.reqs.covered ?? 0} covered, ${counts.reqs.uncovered ?? 0} uncovered, ` +
    `${counts.reqs.contradicted ?? 0} contradicted), ${plan.findings.length} findings, ` +
    `${defects.length} defects (${openDefects.length} open), ${plan.sessions.length} sessions. ` +
    `Numbers from session ${newestConfirmed.id}: ${newestConfirmed.numbers.app_tests} tests in ` +
    `${newestConfirmed.numbers.app_test_files} files.`,
);
if (CHECK_ONLY) process.exit(0);

// ---------------------------------------------------------------- render
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// A deliberately small Markdown: paragraphs, `- ` lists, **bold**, *em*, `code`. Nothing else.
function md(text) {
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return String(text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // A paragraph may be a heading line followed by "- " items; render each run as its own block.
      const lines = p.split("\n");
      const out = [];
      let i = 0;
      while (i < lines.length) {
        if (/^- /.test(lines[i])) {
          const items = [];
          while (i < lines.length && /^- /.test(lines[i])) items.push(lines[i++].slice(2));
          out.push("<ul>" + items.map((l) => `<li>${inline(l)}</li>`).join("") + "</ul>");
        } else {
          const text = [];
          while (i < lines.length && !/^- /.test(lines[i])) text.push(lines[i++]);
          out.push(`<p>${inline(text.join(" "))}</p>`);
        }
      }
      return out.join("");
    })
    .join("\n");
}
const chip = (cls, label) => `<span class="chip ${cls}">${esc(label)}</span>`;
const STAGE_CHIP = {
  done: ["done", "Done"],
  now: ["now", "In progress"],
  open: ["next", "Open"],
  parked: ["q", "Parked"],
};
const REQ_CHIP = { covered: "done", uncovered: "q", contradicted: "bad", superseded: "mine" };
const DEF_CHIP = {
  open: "bad",
  reopened: "bad",
  "fix-claimed": "now",
  verified: "done",
  wontfix: "mine",
};

function stageCard(s) {
  const [cls, label] = STAGE_CHIP[s.status];
  const owner = s.owner === "maintainer" ? chip("yours", "Your run") : chip("mine", "Mine");
  const refs = (s.refs ?? []).length ? `<p class="fine">${esc(s.refs.join(" · "))}</p>` : "";
  const delivers = (s.delivers ?? []).length
    ? `<p class="fine">Delivers ${s.delivers.map((r) => `<a href="#${r}">${esc(r)}</a>`).join(", ")}</p>`
    : "";
  const measure = s.measure
    ? `<div class="measure">${esc(
        Object.entries(s.measure)
          .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
          .join("\n"),
      )}</div>`
    : "";
  const measureNote = s.measure_note ? `<div class="measure">${esc(s.measure_note)}</div>` : "";
  return `<div class="stage ${s.status}" id="${esc(s.id)}">
  <span class="num">${esc(s.num)}</span>
  <h3>${esc(s.title)}</h3>
  <div class="what">${md(s.what)}</div>
  ${s.state ? `<div class="state">${md(s.state)}</div>` : ""}
  ${measure}${measureNote}${refs}${delivers}
  <span class="tags">${chip(cls, label)}${owner}</span>
</div>`;
}

function findingCard(f) {
  const stage = f.stage ? ` · <a href="#${f.stage}">${esc(f.stage)}</a>` : "";
  const who = {
    maintainer: "you found it",
    agent: "found while building",
    test: "a test found it",
    tester: "the tester found it",
    reviewer: "a reviewer found it",
  }[f.found_by];
  const status =
    f.status === "fixed" ? "fixed" : f.status === "wontfix" ? "will not fix" : f.status;
  return `<div class="find ${f.status === "fixed" ? "fix" : ""}" id="${esc(f.id)}">
  <span class="tag">${esc(f.tag || f.id)} · ${esc(status)} · ${esc(who)}${stage}</span>
  <h3>${esc(f.title)}</h3>
  ${md(f.story)}
  ${(f.refs ?? []).length ? `<p class="fine">${esc(f.refs.join(" · "))}</p>` : ""}
</div>`;
}

function defectCard(d) {
  return `<div class="find ${d.status === "verified" ? "fix" : ""}" id="${esc(d.id)}">
  <span class="tag">${esc(d.id)} · ${esc(d.severity)} · ${esc(d.class)} · ${esc(d.status)}</span>
  <h3>${esc(d.title)}</h3>
  <p class="fine">Violates ${d.violates.map((r) => `<a href="#${r}">${esc(r)}</a>`).join(", ")} · filed ${esc(iso(d.filed))} by ${esc(d.filed_by)}${d.fix_commit ? ` · fix ${esc(d.fix_commit)}` : ""}${d.pin ? ` · pinned by <code>${esc(d.pin)}</code>` : ""}</p>
  ${md(d.body.replace(/^## (.*)$/gm, "**$1**"))}
</div>`;
}

function requirementRow(r) {
  const proof = (r.verified_by ?? [])
    .map((v) =>
      v.file
        ? `${v.kind} · <code>${esc(v.file)}</code>${v.cases ? ` ${esc(v.cases)}` : ""}`
        : `${v.kind}: ${esc(v.steps)}`,
    )
    .join("<br>");
  return `<tr class="r-${r.status}" id="${esc(r.id)}">
  <td class="g-n">${esc(r.id)}</td>
  <td class="reqmain"><b>${esc(r.title)}</b><br><span class="fine">${md(r.claim).replace(/<\/?p>/g, "")}</span>
      <br><span class="fine">${esc((r.source ?? []).join(", "))} · ${esc(r.stated_by)}${r.superseded_by ? ` · superseded by <a href="#${r.superseded_by}">${esc(r.superseded_by)}</a>` : ""}${r.note ? ` · ${esc(r.note)}` : ""}</span></td>
  <td class="fine">${proof || "—"}</td>
  <td class="chipcol">${chip(REQ_CHIP[r.status], r.status)}</td>
</tr>`;
}

function sessionEntry(s, open) {
  const n = s.numbers ?? {};
  const nums = [
    n.app_tests != null
      ? `${n.app_tests} app tests in ${n.app_test_files ?? "?"} files`
      : "no test count recorded",
    n.db_checks != null ? `${n.db_checks} database checks` : null,
    n.migrations != null ? `${n.migrations} migrations` : null,
    n.tsc != null ? `tsc ${n.tsc}` : null,
    n.eslint != null ? `eslint ${n.eslint}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `<details class="donefold" ${open ? "open" : ""}>
  <summary><b>Session ${esc(s.id)}</b> · ${esc(iso(s.date))} · ${esc(s.title)} ${s.confirmed ? chip("done", "counts confirmed") : chip("q", "counts not confirmed")}</summary>
  <div class="inner">
    ${md(s.summary)}
    <p class="fine">${esc(nums)}${(s.commits ?? []).length ? ` · commits ${esc(s.commits.join(", "))}` : ""}${(s.shipped ?? []).length ? ` · shipped ${s.shipped.map((x) => `<a href="#${x}">${esc(x)}</a>`).join(", ")}` : ""}</p>
  </div>
</details>`;
}

// The newest confirmed session may not have re-measured the database; fall back to the baseline.
const bl = { ...plan.meta.baseline, ...newestConfirmed.numbers };
const band = `<div class="band">
  <div class="stat ok"><span class="n">${esc(bl.app_tests)}</span><span class="l">app tests in ${esc(bl.app_test_files)} files — session ${esc(newestConfirmed.id)}, ${esc(iso(newestConfirmed.date))}</span></div>
  ${bl.mutations ? `<div class="stat ok"><span class="n">${esc(bl.mutations)}</span><span class="l">deliberate breakages caught</span></div>` : ""}
  ${bl.db_checks != null ? `<div class="stat ok"><span class="n">${esc(bl.db_checks)}</span><span class="l">database checks</span></div>` : ""}
  ${bl.migrations != null ? `<div class="stat"><span class="n">${esc(bl.migrations)}</span><span class="l">database changes (migrations)</span></div>` : ""}
  <div class="stat ${openDefects.length ? "act" : "ok"}"><span class="n">${openDefects.length}</span><span class="l">open defects</span></div>
  <div class="stat ${counts.reqs.contradicted ? "act" : ""}"><span class="n">${counts.reqs.covered ?? 0} / ${plan.requirements.length}</span><span class="l">requirements covered by a test${counts.reqs.contradicted ? ` · ${counts.reqs.contradicted} contradicted` : ""}</span></div>
</div>`;

const nextRows = (plan.next ?? [])
  .map((n, i) => {
    const s = n.stage ? plan.stages.find((x) => x.id === n.stage) : null;
    const link = s
      ? `<a href="#${s.id}">${esc(s.id)}</a> `
      : n.requirement
        ? `<a href="#${n.requirement}">${esc(n.requirement)}</a> `
        : "";
    const label = link + esc(n.text ?? (s ? s.title : ""));
    return `<tr class="${i === 0 ? "g-now" : "g-next"}"><td class="g-n">${i + 1}</td><td>${label}<br><span class="fine">${esc(n.why)}</span>${n.decided ? " " + chip("mine", "decided — do not re-ask") : ""}</td></tr>`;
  })
  .join("\n");

const backlogRows = (plan.backlog ?? [])
  .filter((b) => b.status !== "done")
  .map((b) => {
    const st = b.stage ? ` <a href="#${b.stage}">${esc(b.stage)}</a>` : "";
    return `<tr><td class="g-n">${esc(b.phase)}</td><td>${esc(b.text)}${st}${b.note ? `<br><span class="fine">${esc(b.note)}</span>` : ""}</td><td class="chipcol">${chip(b.status === "partial" ? "now" : "q", b.status)}</td></tr>`;
  })
  .join("\n");
const backlogSection = backlogRows
  ? `<section id="backlog"><span class="eyebrow">Backlog</span><h2>Still on the roadmap</h2><p class="fine">The roadmap's remaining checkboxes, by phase. Done items are folded into the stages above.</p><div class="glance"><table><tbody>${backlogRows}</tbody></table></div></section>`
  : "";

const trackSections = plan.tracks
  .map((t) => {
    const mine = plan.stages.filter((s) => s.track === t.id).sort((a, b) => a.num - b.num);
    const openOnes = mine.filter((s) => s.status !== "done");
    const doneOnes = mine.filter((s) => s.status === "done");
    return `<section id="track-${esc(t.id)}">
  <span class="eyebrow">${esc(t.title)}</span>
  <h2>${esc(t.heading ?? t.title)}</h2>
  ${t.lead ? `<div class="lead">${md(t.lead)}</div>` : ""}
  ${openOnes.length ? `<h3 class="grouphead">Open — this is what is left</h3><div class="stages">${openOnes.map(stageCard).join("\n")}</div>` : ""}
  <details class="donefold"><summary>${doneOnes.length} stages shipped — open to read them</summary><div class="stages">${doneOnes.map(stageCard).join("\n")}</div></details>
</section>`;
  })
  .join('\n<hr class="rule">\n');

const reqTable = `<div class="glance"><table class="fixed"><colgroup><col style="width:5.5rem"><col style="width:56%"><col><col style="width:7.5rem"></colgroup>
<caption>${plan.requirements.length} requirements · ${counts.reqs.covered ?? 0} covered · ${counts.reqs.uncovered ?? 0} uncovered · ${counts.reqs.contradicted ?? 0} contradicted · ${counts.reqs.superseded ?? 0} superseded</caption>
<tbody>${plan.requirements.map(requirementRow).join("\n")}</tbody></table></div>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(plan.meta.title)}</title>
<style>${CSS}</style>
</head>
<body><div class="wrap">
<header>
  <span class="eyebrow">Production Scheduler · plan of record · generated from docs/plan.yaml</span>
  <h1>${esc(plan.meta.title)}</h1>
  ${plan.meta.sub ? `<p class="sub">${esc(plan.meta.sub)}</p>` : ""}
</header>

<section>
  <span class="eyebrow">Where we are right now</span>
  <h2>Session ${esc(newest.id)} · ${esc(iso(newest.date))} · ${esc(newest.title)}</h2>
  <div class="lead">${md(newest.summary)}</div>
  ${band}
  <p class="fine">Measured at commit <code>${esc(plan.meta.tip)}</code>. When you run the tests, the count should match <em>exactly</em>; a different number means a test file did not load, which is how a broken suite once looked green.</p>
</section>

<section>
  <span class="eyebrow">Next</span>
  <h2>What comes next, in order</h2>
  <p class="fine">The order is a guess about priority, not a fact. If it has drifted from what the maintainer wants, ask rather than working down the list.</p>
  <div class="glance"><table><tbody>${nextRows}</tbody></table></div>
</section>

${backlogSection}

<hr class="rule">
${trackSections}

<hr class="rule">
<section id="defects">
  <span class="eyebrow">Defects</span>
  <h2>${openDefects.length ? `${openDefects.length} open defect${openDefects.length === 1 ? "" : "s"}` : "No open defects"}</h2>
  <p class="lead">Filed by the tester against a named requirement, each with a reproduction. The developer marks a fix <em>fix-claimed</em>; only the tester marks it <em>verified</em>.</p>
  ${defects.length ? defects.map(defectCard).join("\n") : `<p class="fine">None filed yet.</p>`}
</section>

<hr class="rule">
<section id="findings">
  <span class="eyebrow">What turned up</span>
  <h2>${plan.findings.length} things that weren't in the plan</h2>
  ${[...plan.findings].reverse().map(findingCard).join("\n")}
</section>

<hr class="rule">
<section id="requirements">
  <span class="eyebrow">The ledger</span>
  <h2>Every requirement, and what proves it</h2>
  <p class="lead">One row per thing the product must do. <em>Covered</em> means a test in the suite is named for it; <em>uncovered</em> means nothing but a person checks it; <em>contradicted</em> means an open defect shows the code doing something else.</p>
  ${reqTable}
</section>

<hr class="rule">
<section id="sessions">
  <span class="eyebrow">The log</span>
  <h2>Every session, newest first</h2>
  ${plan.sessions.map((s, i) => sessionEntry(s, i === 0)).join("\n")}
</section>

<footer>Generated from <code>docs/plan.yaml</code> (updated ${esc(iso(plan.meta.updated))}) by <code>scripts/render-plan.mjs</code>. Edit the YAML, never this page.</footer>
</div></body></html>
`;
writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
