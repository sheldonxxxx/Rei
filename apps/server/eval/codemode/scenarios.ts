// The Code mode eval's fixtures and scenarios. Everything is synthetic and seeded through the public API, so the same
// scenarios run against the in-process faux server (tests of the harness) and a real stack with a real model.
//
// Each scenario has:
//   - a natural-language `prompt` for the real model;
//   - `check`, assertions on the final answer (and on what the run did), never an LLM judge;
//   - `faux`, a reference plan for the faux model: the tool calls a good agent makes without Code mode (`off`) and the
//     one script a good agent writes with it (`on`). The faux model cannot reason, so these prove that the fixtures,
//     the assertions and the metrics work; they say nothing about how a real model behaves.
import { DEMO_RECORDS } from "../../src/pi/demo-tools.ts";

export type Kind = "multi" | "single" | "approval";

export interface SeedIds {
  /** Library file ids by name. */
  files: Map<string, { id: string; versionId: string }>;
  /** Knowledge page ids by title. */
  pages: Map<string, string>;
  /** Everything created, for cleanup against a real stack. */
  created: { files: string[]; pages: string[]; memory: string[] };
}

export interface Outcome {
  /** The last assistant message of the conversation. */
  answer: string;
  /** Approval cards of the conversation. */
  approvals: { tool: string; status: string; summary: string; execution?: string | undefined }[];
}

export interface Scenario {
  id: string;
  title: string;
  kind: Kind;
  prompt: string;
  /** Reasons the outcome fails the scenario; empty when it passes. */
  check(outcome: Outcome): string[];
  faux: {
    /** Directives for the faux model without Code mode. */
    off(ids: SeedIds): string;
    /** The script the faux model runs with Code mode (it prints the final answer). */
    script(ids: SeedIds): string;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Library: 14 English reports (4 mention "Heliotrope") and 6 Chinese notes (2 mention 櫻花).

/** Fixture files and pages carry this marker, so a real stack's own data is never mistaken for them. */
export const MARK = "cmeval";
export const ROOT_PAGE = "Code mode eval fixtures";

export const HELIOTROPE_REPORTS = [3, 7, 8, 12].map((n) => `${MARK}-report-${String(n).padStart(2, "0")}.txt`);
/** Budgets of the Heliotrope reports; report-08 has the highest. The report with the highest budget overall (report-05) does not mention it. */
const BUDGETS: Record<string, number> = {
  [`${MARK}-report-03.txt`]: 12_400,
  [`${MARK}-report-07.txt`]: 31_900,
  [`${MARK}-report-08.txt`]: 48_500,
  [`${MARK}-report-12.txt`]: 27_250,
  [`${MARK}-report-05.txt`]: 91_000,
};
export const REPORTS = Array.from({ length: 14 }, (_, k) => `${MARK}-report-${String(k + 1).padStart(2, "0")}.txt`);
export const SAKURA_NOTES = [2, 5].map((n) => `${MARK}-筆記-${String(n).padStart(2, "0")}.txt`);
export const NOTES = Array.from({ length: 6 }, (_, k) => `${MARK}-筆記-${String(k + 1).padStart(2, "0")}.txt`);

export function libraryFiles(): { name: string; text: string }[] {
  const reports = REPORTS.map((name, k) => {
    const budget = BUDGETS[name] ?? 3000 + ((k * 1373) % 9000);
    const heliotrope = HELIOTROPE_REPORTS.includes(name);
    return {
      name,
      text: [
        `Quarterly report ${k + 1}`,
        `Team: ${["Platform", "Growth", "Support", "Data"][k % 4]}`,
        heliotrope
          ? "Highlights: the Heliotrope migration moved into its second phase."
          : "Highlights: routine maintenance and small fixes.",
        `Budget: ${budget}`,
        "Risks: none that need escalation.",
      ].join("\n"),
    };
  });
  const notes = NOTES.map((name, k) => ({
    name,
    text: [
      `旅行筆記 ${k + 1}`,
      SAKURA_NOTES.includes(name) ? "今天在公園看到盛開的櫻花，人很多。" : "今天在公園看到盛開的梅花，人不多。",
      "晚餐吃了拉麵。",
    ].join("\n"),
  }));
  return [...reports, ...notes];
}

// ---------------------------------------------------------------------------------------------------------------------
// Knowledge.

export const POSTMORTEMS = [
  { title: "Postmortem: login outage", cause: "an expired certificate on the auth proxy" },
  { title: "Postmortem: slow search", cause: "a missing database index" },
  { title: "Postmortem: failed uploads", cause: "an expired certificate on the storage endpoint" },
  { title: "Postmortem: duplicate emails", cause: "a retry bug in the mailer" },
  { title: "Postmortem: dashboard blank", cause: "a bad frontend deploy" },
  { title: "Postmortem: payment errors", cause: "an expired certificate at the payment provider" },
  { title: "Postmortem: stale cache", cause: "a cache key collision" },
  { title: "Postmortem: queue backlog", cause: "a stuck worker" },
];
export const CERT_POSTMORTEMS = POSTMORTEMS.filter((p) => p.cause.includes("expired certificate")).map((p) => p.title);

export const RUNBOOKS = Array.from({ length: 12 }, (_, k) => ({
  title: `Runbook ${String(k + 1).padStart(2, "0")}: ${["DNS", "Backups", "Deploys", "Alerts", "Databases", "Queues", "Cache", "Search", "Storage", "Mail", "Auth", "Billing"][k]}`,
  pager: [1, 4, 7, 11].includes(k + 1),
}));
export const PAGER_RUNBOOKS = RUNBOOKS.filter((r) => r.pager).map((r) => r.title);

const CONTRACTS = [
  { title: "Acme Supply Agreement", renews: "2027-02-15", notice: "60 days" },
  { title: "Birch Logistics Agreement", renews: "2026-12-01", notice: "30 days" },
  { title: "Cobalt Support Agreement", renews: "2027-06-30", notice: "90 days" },
];

export interface PageSeed {
  title: string;
  parent: string | null;
  tags: string[];
  description: string;
  body: string;
}

export function knowledgePages(): PageSeed[] {
  const pages: PageSeed[] = [
    {
      title: ROOT_PAGE,
      parent: null,
      tags: [],
      description: "Synthetic pages for the Code mode eval.",
      body: "Safe to delete.",
    },
    {
      title: "Incidents",
      parent: ROOT_PAGE,
      tags: [],
      description: "Incident write-ups.",
      body: "Index of incident write-ups.",
    },
    {
      title: "Runbooks",
      parent: ROOT_PAGE,
      tags: [],
      description: "Operational runbooks.",
      body: "Index of runbooks.",
    },
    {
      title: "Contracts",
      parent: ROOT_PAGE,
      tags: [],
      description: "Supplier contracts.",
      body: "Index of contracts.",
    },
  ];
  for (const p of POSTMORTEMS)
    pages.push({
      title: p.title,
      parent: "Incidents",
      tags: ["postmortem"],
      description: "Incident postmortem.",
      body: `## Summary\n\nThe root cause was ${p.cause}.\n\n## Follow-up\n\nA ticket was filed.`,
    });
  // Pages with another tag that also mention certificates: the tag filter has to leave them out.
  for (const n of [1, 2, 3, 4])
    pages.push({
      title: `How to renew certificate ${n}`,
      parent: "Incidents",
      tags: ["howto"],
      description: "A how-to.",
      body: "Renew the expired certificate with the standard procedure.",
    });
  for (const r of RUNBOOKS)
    pages.push({
      title: r.title,
      parent: "Runbooks",
      tags: ["runbook"],
      description: "A runbook.",
      body: r.pager
        ? "## Escalation\n\nIf this fails, page the on-call engineer through the pager."
        : "## Escalation\n\nIf this fails, open a ticket and tell the team channel.",
    });
  for (const c of CONTRACTS)
    pages.push({
      title: c.title,
      parent: "Contracts",
      tags: ["contract"],
      description: "A supplier contract.",
      body: `## Terms\n\nRenewal date: ${c.renews}.\n\nNotice period: ${c.notice} before renewal.\n\nPayment: net 30.`,
    });
  return pages;
}

export const MEMORY_LINES = ["Our fiscal year starts on 1 April."];

// ---------------------------------------------------------------------------------------------------------------------
// Scenarios.

const has = (text: string, needle: string | RegExp): boolean =>
  typeof needle === "string" ? text.toLowerCase().includes(needle.toLowerCase()) : needle.test(text);

/** Every `wanted` appears and no `unwanted` does. */
function names(answer: string, wanted: string[], unwanted: string[]): string[] {
  const out: string[] = [];
  // A file may be named with or without its extension.
  const stem = (n: string): string => n.replace(/\.txt$/, "");
  for (const w of wanted) if (!has(answer, stem(w))) out.push(`missing ${w}`);
  for (const u of unwanted) if (has(answer, stem(u))) out.push(`wrongly includes ${u}`);
  return out;
}

const sentToAll = (o: Outcome, to: string[]): string[] => {
  const out: string[] = [];
  const sends = o.approvals.filter((a) => a.tool === "demo_send_message");
  for (const who of to) {
    const hit = sends.find((a) => has(a.summary, `to ${who}`));
    if (!hit) out.push(`no send card for ${who}`);
    else if (hit.status !== "approved" || hit.execution !== "ran")
      out.push(`send to ${who} did not run (${hit.status})`);
  }
  if (sends.length !== to.length) out.push(`${sends.length} send cards, expected ${to.length}`);
  return out;
};

const json = JSON.stringify;
const call = (name: string, args: unknown = {}): string => `[tool: ${name} ${json(args)}]`;

const overdueBig = DEMO_RECORDS.filter((r) => r.status === "overdue" && r.amount > 1000).map((r) => r.id);
const openRecords = DEMO_RECORDS.filter((r) => r.status === "open");
export const OPEN_TOTAL = openRecords.reduce((n, r) => n + r.amount, 0);
const decoyOverdue = DEMO_RECORDS.filter((r) => !overdueBig.includes(r.id)).map((r) => r.id);

/** Directives that read every library file named like `prefix` (the faux model cannot read ids from results). */
function readAll(ids: SeedIds, files: string[]): string {
  return [
    ...files.map((f) => {
      const file = ids.files.get(f)!;
      return call("read_library_file", { fileId: file.id, versionId: file.versionId });
    }),
  ].join(" ");
}

/** A script that reads library files by name through search_library and keeps the lines that pass `keep`. */
const libraryScript = (
  query: string,
  body: string,
): string => `const found = await tools.search_library({ query: ${json(query)} });
const out = [];
for (const f of found.files) {
  const r = await tools.read_library_file({ fileId: f.id, versionId: f.current.versionId });
  ${body}
}`;

export const SCENARIOS: Scenario[] = [
  {
    id: "library-grep",
    title: "Which of 14 library reports mention a project",
    kind: "multi",
    prompt:
      "My library has 14 files named cmeval-report-01.txt to cmeval-report-14.txt. Which of them mention the Heliotrope project? Reply with the file names only.",
    check: (o) =>
      names(
        o.answer,
        HELIOTROPE_REPORTS,
        REPORTS.filter((r) => !HELIOTROPE_REPORTS.includes(r)),
      ),
    faux: {
      off: (ids) => `${call("search_library", { query: `${MARK}-report` })} ${readAll(ids, REPORTS)}`,
      script: () =>
        `${libraryScript(`${MARK}-report`, `if (/heliotrope/i.test(r.text)) out.push(f.name);`)}\nconsole.log(out.sort().join(", "));`,
    },
  },
  {
    id: "library-max",
    title: "Highest budget among the reports that mention a project",
    kind: "multi",
    prompt:
      "Among my library files named cmeval-report-01.txt to cmeval-report-14.txt, find the ones that mention the Heliotrope project. Which of those has the highest Budget value? Give the file name and the number.",
    check: (o) => [
      ...names(o.answer, [`${MARK}-report-08`], []),
      ...(has(o.answer, /48[, ]?500/) ? [] : ["missing the budget 48,500"]),
    ],
    faux: {
      off: (ids) => `${call("search_library", { query: `${MARK}-report` })} ${readAll(ids, REPORTS)}`,
      script: () =>
        `${libraryScript(`${MARK}-report`, `if (/heliotrope/i.test(r.text)) out.push({ name: f.name, budget: Number(/Budget: (\\d+)/.exec(r.text)[1]) });`)}
out.sort((a, b) => b.budget - a.budget);
console.log(out[0].name + " " + out[0].budget);`,
    },
  },
  {
    id: "knowledge-tag",
    title: "Tagged Knowledge pages that state a cause",
    kind: "multi",
    prompt:
      "In Knowledge, look at the pages tagged postmortem. Which of them name an expired certificate as the root cause? List their titles.",
    check: (o) =>
      names(
        o.answer,
        CERT_POSTMORTEMS,
        POSTMORTEMS.filter((p) => !p.cause.includes("expired certificate")).map((p) => p.title),
      ),
    faux: {
      off: (ids) =>
        `${call("knowledge_search", { tags: ["postmortem"], limit: 20 })} ${POSTMORTEMS.map((p) => call("knowledge_read", { pageId: ids.pages.get(p.title)! })).join(" ")}`,
      script: () => `const found = await tools.knowledge_search({ tags: ["postmortem"], limit: 20 });
const out = [];
for (const h of found.hits) {
  const page = await tools.knowledge_read({ pageId: h.pageId });
  if (/expired certificate/i.test(page.text)) out.push(page.title);
}
console.log(out.sort().join("; "));`,
    },
  },
  {
    id: "runbook-scan",
    title: "Scan the child pages of a Knowledge folder",
    kind: "multi",
    prompt:
      "Knowledge has a Runbooks page with 12 runbooks under it. Which of them tell the reader to page the on-call engineer? List the runbook titles.",
    check: (o) =>
      names(
        o.answer,
        PAGER_RUNBOOKS,
        RUNBOOKS.filter((r) => !r.pager).map((r) => r.title),
      ),
    faux: {
      off: (ids) =>
        `${call("knowledge_browse", { pageId: ids.pages.get("Runbooks")! })} ${RUNBOOKS.map((r) => call("knowledge_read", { pageId: ids.pages.get(r.title)! })).join(" ")}`,
      script: (
        ids,
      ) => `const kids = await tools.knowledge_search({ under: ${json(ids.pages.get("Runbooks"))}, limit: 20 });
const out = [];
for (const h of kids.hits) {
  const page = await tools.knowledge_read({ pageId: h.pageId });
  if (/page the on-call/i.test(page.text)) out.push(page.title);
}
console.log(out.sort().join("; "));`,
    },
  },
  {
    id: "records-overdue",
    title: "Connector fan-out: the 3 matching records of 30",
    kind: "multi",
    prompt:
      "Use the demo connector's invoice records (demo_list_records and demo_read_record). There are 30. Which ones are overdue and have an amount over 1000? Reply with the record ids.",
    check: (o) => names(o.answer, overdueBig, decoyOverdue),
    faux: {
      off: () =>
        `${call("demo_list_records")} ${DEMO_RECORDS.map((r) => call("demo_read_record", { id: r.id })).join(" ")}`,
      script: () => `const list = await tools.demo_list_records({});
const ids = list.split("\\n").map((l) => l.split(" | ")[0]).filter(Boolean);
const out = [];
for (const id of ids) {
  const r = await tools.demo_read_record({ id });
  if (/Status: overdue/.test(r) && Number(/Amount: ([\\d.]+)/.exec(r)[1]) > 1000) out.push(id);
}
console.log(out.join(", "));`,
    },
  },
  {
    id: "records-sum",
    title: "Connector fan-out: add up a field",
    kind: "multi",
    prompt:
      "Use the demo connector's invoice records (demo_list_records and demo_read_record). What is the total Amount of all records whose status is open? Give the number.",
    check: (o) => {
      const want = OPEN_TOTAL.toFixed(2);
      const [whole, cents] = want.split(".");
      const grouped = Number(whole).toLocaleString("en-US");
      return has(o.answer, new RegExp(`(${whole}|${grouped})(\\.${cents})?(?!\\d)`)) ? [] : [`expected ${want}`];
    },
    faux: {
      off: () =>
        `${call("demo_list_records")} ${DEMO_RECORDS.map((r) => call("demo_read_record", { id: r.id })).join(" ")}`,
      script: () => `const list = await tools.demo_list_records({});
const ids = list.split("\\n").map((l) => l.split(" | ")[0]).filter(Boolean);
let total = 0;
for (const id of ids) {
  const r = await tools.demo_read_record({ id });
  if (/Status: open/.test(r)) total += Number(/Amount: ([\\d.]+)/.exec(r)[1]);
}
console.log(total.toFixed(2));`,
    },
  },
  {
    id: "cross-tool",
    title: "Memory and Knowledge: find, read two pages, compare",
    kind: "multi",
    prompt:
      "Compare the Acme and Birch agreements in Knowledge: which one renews first? Also tell me which fiscal quarter of ours each renewal falls in (use what you know about my fiscal year).",
    check: (o) => {
      const out: string[] = [];
      // The user's own profile may make the model answer in Chinese, so both languages count.
      const early = "first|earlier|sooner|earliest|先|早";
      if (!has(o.answer, new RegExp(`birch[^.。\\n]{0,80}(${early})|(${early})[^.。\\n]{0,60}birch`, "i")))
        out.push("does not say Birch renews first");
      if (!has(o.answer, /2026-12-01|Dec(ember)? 1\b|12\s*月\s*1\s*日|12\/1\b/i))
        out.push("missing Birch's renewal date");
      if (!has(o.answer, /2027-02-15|Feb(ruary)? 15|\b2\s*月\s*15\s*日|2\/15/i))
        out.push("missing Acme's renewal date");
      if (!has(o.answer, /Q3|third quarter|3rd quarter|第\s*[三3]|[三3]\s*季/i)) out.push("missing Q3 for Birch");
      if (!has(o.answer, /Q4|fourth quarter|4th quarter|第\s*[四4]|[四4]\s*季/i)) out.push("missing Q4 for Acme");
      return out;
    },
    faux: {
      off: (ids) =>
        `${call("knowledge_search", { query: "agreement renewal", limit: 10 })} ${call("knowledge_read", { pageId: ids.pages.get("Acme Supply Agreement")! })} ${call("knowledge_read", { pageId: ids.pages.get("Birch Logistics Agreement")! })}`,
      script: (
        ids,
      ) => `const acme = await tools.knowledge_read({ pageId: ${json(ids.pages.get("Acme Supply Agreement"))} });
const birch = await tools.knowledge_read({ pageId: ${json(ids.pages.get("Birch Logistics Agreement"))} });
const date = (p) => /Renewal date: (\\d{4})-(\\d{2})-(\\d{2})/.exec(p.text).slice(1);
const quarter = ([y, m]) => "Q" + (Math.floor(((Number(m) + 8) % 12) / 3) + 1);
const a = date(acme), b = date(birch);
console.log("Birch renews first (" + b.join("-") + ", " + quarter(b) + "); Acme renews " + a.join("-") + ", " + quarter(a));`,
    },
  },
  {
    id: "single-lookup",
    title: "A single lookup that should not need a script",
    kind: "single",
    prompt: "What notice period does the Acme Supply Agreement in Knowledge require?",
    check: (o) => (has(o.answer, /60[- ]?(days?|天|日)|sixty/i) ? [] : ["missing 60 days"]),
    faux: {
      off: (ids) => call("knowledge_read", { pageId: ids.pages.get("Acme Supply Agreement")! }),
      script: (
        ids,
      ) => `const p = await tools.knowledge_read({ pageId: ${json(ids.pages.get("Acme Supply Agreement"))} });
console.log(/Notice period: ([^.]*)\\./.exec(p.text)[1]);`,
    },
  },
  {
    id: "send-approval",
    title: "Writes that need approval (the user approves each)",
    kind: "approval",
    prompt:
      'Use the demo connector\'s demo_send_message to send the text "Standup moved to 10:00" to each of Ana, Ben and Chi (three separate messages), then tell me when they are sent.',
    check: (o) => [...sentToAll(o, ["Ana", "Ben", "Chi"]), ...(o.answer.trim() === "" ? ["no final answer"] : [])],
    faux: {
      off: () =>
        ["Ana", "Ben", "Chi"].map((to) => call("demo_send_message", { to, text: "Standup moved to 10:00" })).join(" "),
      script:
        () => `for (const to of ["Ana", "Ben", "Chi"]) await tools.demo_send_message({ to, text: "Standup moved to 10:00" });
console.log("Sent to Ana, Ben and Chi.");`,
    },
  },
  {
    id: "chinese-grep",
    title: "A Chinese request over library files",
    kind: "multi",
    prompt:
      "我的檔案庫有 6 份旅行筆記，檔名是 cmeval-筆記-01.txt 到 cmeval-筆記-06.txt。哪幾份提到「櫻花」？只列出檔名。",
    check: (o) =>
      names(
        o.answer,
        SAKURA_NOTES,
        NOTES.filter((n) => !SAKURA_NOTES.includes(n)),
      ),
    faux: {
      off: (ids) => `${call("search_library", { query: `${MARK}-筆記` })} ${readAll(ids, NOTES)}`,
      script: () =>
        `${libraryScript(`${MARK}-筆記`, `if (r.text.includes("櫻花")) out.push(f.name);`)}\nconsole.log(out.sort().join(", "));`,
    },
  },
];
