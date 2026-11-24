// Writes the generated fixtures in pages/: long pages whose evidence sits far past the first 20,000-character slice,
// a Latin-1 page and two non-text bodies. The output is frozen in the repo; run this only to add or change a generated
// fixture, then re-run the eval and update RESULTS.md:
//
//   node apps/server/eval/web-reading/generate.ts
//
// Deterministic: a seeded generator, no clock, no network.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "pages");

let seed = 0x5eed;
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

const SUBJECTS = [
  "The committee",
  "Local residents",
  "The operator",
  "A spokesperson",
  "Engineers on the project",
  "The regional authority",
  "Several councillors",
  "The contractor",
  "An independent review",
  "Business owners nearby",
];
const VERBS = [
  "noted",
  "argued",
  "suggested",
  "confirmed",
  "questioned whether",
  "reported that",
  "pointed out that",
  "welcomed the news that",
];
const CLAUSES = [
  "the budget had been revised twice since the spring",
  "traffic modelling would be repeated after the consultation",
  "the drainage survey found no unexpected obstacles",
  "evening work would be limited to the quieter months",
  "the procurement timetable remained unchanged",
  "noise monitoring stations had been installed along the route",
  "the design panel asked for more trees along the frontage",
  "a second public meeting would follow in the new year",
  "the archaeological watching brief had recorded only modern fill",
  "parking during construction would move to the eastern field",
];

function sentence(): string {
  return `${pick(SUBJECTS)} ${pick(VERBS)} ${pick(CLAUSES)}.`;
}
function paragraph(n = 5): string {
  return Array.from({ length: n }, sentence).join(" ");
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function page(title: string, body: string, chrome = true): string {
  const nav = chrome
    ? `<header class="site"><a href="/">Example</a><nav>${Array.from({ length: 12 }, (_, i) => `<a href="/s/${i}">Section ${i}</a>`).join(" ")}</nav></header>`
    : "";
  const footer = chrome
    ? `<footer>&copy; 2026 Example. All rights reserved. <a href="/privacy">Privacy</a></footer>`
    : "";
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head>\n<body>${nav}\n<main>\n${body}\n</main>${footer}</body></html>\n`;
}

// a02: a long news feature (~40K characters of text); the answer is near the end.
{
  const parts = ["<article>", "<h1>Airport expansion: what the inquiry heard</h1>"];
  for (let s = 1; s <= 9; s++) {
    parts.push(`<h2>Day ${s} of the inquiry</h2>`);
    for (let p = 0; p < 6; p++) parts.push(`<p>${paragraph(6)}</p>`);
  }
  parts.push("<h2>The decision</h2>");
  parts.push(`<p>${paragraph(4)}</p>`);
  parts.push(
    "<p>The inspector approved the plan with conditions. The new terminal is scheduled to open on 14 March 2029, with the second runway following two years later.</p>",
  );
  parts.push(`<p>${paragraph(3)}</p>`, "</article>");
  writeFileSync(join(OUT, "a02-news-long.html"), page("Airport expansion: what the inquiry heard", parts.join("\n")));
}

// a04: an encyclopedia-style article (~70K characters) with an infobox, a contents list and references.
{
  const sections = [
    "Etymology",
    "Course",
    "Geology",
    "Climate",
    "Tributaries",
    "History",
    "Navigation",
    "Industry",
    "Hydrology",
    "Ecology",
    "Settlements",
    "Recreation",
    "In culture",
  ];
  const parts = [
    "<h1>River Elsby</h1>",
    '<table class="infobox"><tr><th>Length</th><td>187 km</td></tr><tr><th>Source</th><td>Hallam Moor</td></tr><tr><th>Mouth</th><td>Elsby Estuary</td></tr><tr><th>Basin size</th><td>2,940 km²</td></tr></table>',
    `<p>The <b>River Elsby</b> is a river in the north of the country. ${paragraph(4)}</p>`,
    `<div class="toc"><h2>Contents</h2><ol>${sections.map((s) => `<li><a href="#${s}">${s}</a></li>`).join("")}</ol></div>`,
  ];
  for (const s of sections) {
    parts.push(`<h2 id="${s}">${s}</h2>`);
    const count = s === "Hydrology" ? 3 : 8;
    for (let p = 0; p < count; p++) parts.push(`<p>${paragraph(6)}</p>`);
    if (s === "Hydrology")
      parts.push(
        "<p>The mean discharge at the mouth is 412 cubic metres per second, peaking in February after snowmelt on the moor.</p>",
      );
  }
  parts.push(
    `<h2>References</h2><ol class="refs">${Array.from({ length: 40 }, (_, i) => `<li>Survey report ${i + 1}, regional archive, p. ${10 + i}.</li>`).join("")}</ol>`,
  );
  writeFileSync(join(OUT, "a04-encyclopedia-long.html"), page("River Elsby - Encyclopedia", parts.join("\n")));
}

// d02: a configuration reference with 60 options; the answer is option 47.
{
  const words = ["cache", "retry", "queue", "worker", "upload", "session", "export", "audit", "webhook", "index"];
  const units = ["ms", "seconds", "items", "bytes", "connections"];
  const parts = [
    "<h1>Configuration reference</h1>",
    "<p>Every option can be set in larkspur.toml or as an environment variable with the LARKSPUR_ prefix.</p>",
  ];
  for (let i = 1; i <= 60; i++) {
    const name = i === 47 ? "retry_backoff_ms" : `${pick(words)}_${pick(words)}_${i}`;
    parts.push(`<h2 id="${name}">${name}</h2>`);
    if (i === 47) {
      parts.push("<p>The delay before the first retry of a failed outbound call. Each later retry doubles it.</p>");
      parts.push(
        "<table><tr><th>Type</th><td>integer</td></tr><tr><th>Default</th><td>750</td></tr><tr><th>Range</th><td>100 to 60000</td></tr></table>",
      );
      parts.push("<p>The default for retry_backoff_ms is 750 milliseconds.</p>");
    } else {
      parts.push(`<p>${paragraph(3)}</p>`);
      parts.push(
        `<table><tr><th>Type</th><td>integer</td></tr><tr><th>Default</th><td>${Math.floor(rand() * 1000)}</td></tr><tr><th>Unit</th><td>${pick(units)}</td></tr></table>`,
      );
      parts.push(`<pre><code class="language-toml">${name} = ${Math.floor(rand() * 1000)}</code></pre>`);
    }
  }
  writeFileSync(
    join(OUT, "d02-config-reference.html"),
    page("Configuration reference — Larkspur Docs", parts.join("\n")),
  );
}

// p01: an API reference with 40 endpoints; the answer is endpoint 31.
{
  const resources = ["orders", "customers", "products", "refunds", "shipments", "invoices", "webhooks", "payouts"];
  const methods = ["GET", "POST", "PATCH", "DELETE"];
  const parts = [
    "<h1>API reference</h1>",
    "<p>All endpoints are under https://api.larkspur.example/v2 and take JSON bodies.</p>",
  ];
  for (let i = 1; i <= 40; i++) {
    const special = i === 31;
    const method = special ? "POST" : pick(methods);
    const path = special
      ? "/payouts/{id}/reverse"
      : `/${pick(resources)}/{id}/${pick(["items", "events", "notes", "history"])}${i}`;
    parts.push(`<h2>${method} ${esc(path)}</h2>`);
    parts.push(special ? "<p>Reverses a payout that has not yet settled.</p>" : `<p>${paragraph(2)}</p>`);
    parts.push(
      `<table><thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${Array.from(
        { length: 4 },
        (_, k) =>
          `<tr><td>param_${k}</td><td>${pick(["string", "integer", "boolean"])}</td><td>${k === 0 ? "yes" : "no"}</td><td>${sentence()}</td></tr>`,
      ).join("")}</tbody></table>`,
    );
    parts.push(
      special
        ? "<p>Rate limit: this endpoint allows 10 requests per minute per project.</p>"
        : `<p>Rate limit: standard (${100 + i} requests per second).</p>`,
    );
    parts.push(
      `<pre><code class="language-bash">curl -X ${method} https://api.larkspur.example/v2${esc(path).replace("{id}", "ord_123")}</code></pre>`,
    );
  }
  writeFileSync(join(OUT, "p01-api-reference.html"), page("API reference — Larkspur", parts.join("\n")));
}

// c03: a long Chinese report; the answer is in the last section.
{
  const zh = [
    "委員會表示預算已在春季調整兩次。",
    "居民關心施工期間的噪音問題。",
    "承包商確認排水調查沒有發現異常。",
    "交通模型將在公聽會後重新計算。",
    "設計小組要求沿街增加更多樹木。",
    "停車位將在施工期間移至東側空地。",
    "第二場說明會將於明年初舉行。",
    "監測站已沿線設置完成。",
  ];
  const para = (n: number) => Array.from({ length: n }, () => pick(zh)).join("");
  const parts = ["<article>", "<h1>北區河濱公園改造計畫期末報告</h1>"];
  for (let s = 1; s <= 11; s++) {
    parts.push(`<h2>第${s}章</h2>`);
    for (let p = 0; p < 16; p++) parts.push(`<p>${para(10)}</p>`);
  }
  parts.push("<h2>第12章 結論</h2>");
  parts.push(`<p>${para(4)}</p>`);
  parts.push("<p>報告建議將自行車道拓寬為三公尺，並於二〇二八年六月前完成全線改造。</p>");
  parts.push("</article>");
  writeFileSync(
    join(OUT, "c03-zh-long.html"),
    page("北區河濱公園改造計畫期末報告", parts.join("\n")).replace('lang="en"', 'lang="zh-Hant"'),
  );
}

// m02: ISO-8859-1 bytes, the charset named only in a <meta>.
{
  const html =
    '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>Café du Marché</title></head>' +
    "<body><main><h1>Café du Marché</h1><p>Le Café du Marché ouvre à 08:00 du mardi au dimanche.</p><p>Fermé le lundi.</p></main></body></html>";
  writeFileSync(join(OUT, "m02-latin1.html"), Buffer.from(html, "latin1"));
}

// u01, u02: bodies that are not text.
writeFileSync(
  join(OUT, "u01-document.pdf"),
  "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);
writeFileSync(
  join(OUT, "u02-image.png"),
  Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
    "hex",
  ),
);
