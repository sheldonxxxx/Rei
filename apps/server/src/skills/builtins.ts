import type { SkillFile, SkillResponse } from "@rei/protocol";
import { KNOWLEDGE_SKILL_FILES } from "./knowledge-files.generated.ts";
import { buildSkillMd, parseSkillMd } from "./parse.ts";

export const BROWSER_SKILL_NAME = "rei-browser";
export const BROWSER_SKILL_ID = "builtin_browser";

const description =
  "Operate the built-in browser for pages that need JavaScript, sign-in, forms or other interaction. Load before using browser tools.";
const body = [
  "# Browser",
  "Use web_fetch to read pages that don't need JavaScript, a sign-in or interaction. Use the browser for the rest. Each chat has its own Chromium window on the agent computer. It keeps its own profile, so sign-ins persist between chats, but it is not the user's own browser.",
  "## Read and act",
  'browser_open opens a URL and returns the page as readable text. browser_snapshot reads the current page as the full element tree (view="text" for readable text). Elements you can act on carry a mark like [ref=p3e12]. Pass that ref to browser_click, browser_type or browser_select. Refs change when the page changes: always use the newest snapshot. The result of a click is already the new snapshot. browser_press sends a key; browser_back goes back.',
  'A full snapshot is cut at 20,000 characters; its footer gives the offset to read on. On a big page, browser_snapshot with view="interactive" lists only what you can click or fill in. view="changes" shows what changed since your last snapshot; use it after waiting for content to load or update. Start at offset 0 when changing view.',
  "After a click, Enter or submission, use browser_wait for the expected text, URL or enabled element instead of taking repeated snapshots. Use gone for a spinner or modal to disappear. A wait returns the changes view by default, even after a timeout.",
  "Use browser_scroll to bring an element into view or load more of a feed. Use browser_hover to open a hover menu or reveal a tooltip. Both return the changes view.",
  "## Forms and screenshots",
  "Use browser_check to set a checkbox or switch to a specific state or to choose a radio option. Use browser_type with slowly=true when ordinary typing leaves autocomplete or a custom field unchanged.",
  "To send a file the user asked to upload, call browser_upload with the file input or upload button ref and an exact Library version or agent workspace path. Selection can send the file immediately. Outside YOLO, each upload asks for approval. Check the site for its upload result before reporting success.",
  "browser_batch runs up to 10 steps in one call, including wait, scroll, hover and check. After a step that loads a new page, wait for text or the URL and take a new snapshot before using more refs. Confirm field values and the result of submitting a form.",
  "browser_screenshot shows the page as a picture. With annotate=true it outlines actionable elements and tags them with refs; use this when text is ambiguous, such as repeated buttons or icon-only controls.",
  "## User takeover and task boundaries",
  "A code prompt is handled like a sign-in page. Give browser_takeover a one-line reason, tell the user in one sentence and end your turn; continue when they finish in the window. Stay within the user's task.",
].join("\n\n");

export const KNOWLEDGE_SKILL_NAME = "rei-knowledge";
export const KNOWLEDGE_SKILL_ID = "builtin_knowledge";

/** Every built-in skill's id and name: both are reserved. */
export const BUILTIN_SKILLS = [
  { id: BROWSER_SKILL_ID, name: BROWSER_SKILL_NAME },
  { id: KNOWLEDGE_SKILL_ID, name: KNOWLEDGE_SKILL_NAME },
];
export const isBuiltInId = (id: string | undefined): boolean => BUILTIN_SKILLS.some((s) => s.id === id);
export const isBuiltInName = (name: string | undefined): boolean => BUILTIN_SKILLS.some((s) => s.name === name);

/** Shipped with the app, outside the editable skill/version tables. */
export function browserSkill(): SkillResponse {
  return builtIn(BROWSER_SKILL_ID, BROWSER_SKILL_NAME, description, [
    { path: "SKILL.md", encoding: "text", content: buildSkillMd({ name: BROWSER_SKILL_NAME, description, body }) },
  ]);
}

/** Its Markdown is in `knowledge/`; `npm run build:skills` embeds it in the generated module. */
export function knowledgeSkill(): SkillResponse {
  const files: SkillFile[] = KNOWLEDGE_SKILL_FILES.map((f) => ({ path: f.path, encoding: "text", content: f.content }));
  const parsed = parseSkillMd(files.find((f) => f.path === "SKILL.md")!.content);
  return builtIn(KNOWLEDGE_SKILL_ID, KNOWLEDGE_SKILL_NAME, parsed.description, files);
}

function builtIn(id: string, name: string, description: string, files: SkillFile[]): SkillResponse {
  return {
    skill: {
      id,
      name,
      description,
      version: 1,
      agents: null,
      fileCount: files.length,
      author: "user",
      builtIn: true,
      createdAt: 0,
      updatedAt: 0,
    },
    version: 1,
    files,
    versions: [
      {
        version: 1,
        author: "user",
        sessionId: null,
        note: "Built into Rei; updated with the application.",
        createdAt: 0,
      },
    ],
  };
}
