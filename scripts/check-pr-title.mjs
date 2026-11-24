// The pull request title gate: `node scripts/check-pr-title.mjs "<title>"`, or the title in $PR_TITLE.
//
// Pull requests are squash-merged and the title becomes the commit on `main`, so it must be a Conventional Commit
// header: `type(scope)!: summary`, with an optional scope and `!`. The allowed types are listed in TYPES and in
// docs/workflow.md. Exits 1 with the reason when the title does not fit.

export const TYPES = ["feat", "fix", "docs", "test", "refactor", "perf", "build", "ci", "chore", "revert", "style"];

const HEADER = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9._/-]*\\))?(!)?: (\\S.*)$`);
// Generous enough for Dependabot's titles ("… in /containers/exec in the docker-minor-patch group across 1 directory").
const MAX_LENGTH = 150;

/** Returns null when the title is a valid header, or the reason it is not. */
export function titleProblem(title) {
  if (typeof title !== "string" || title.trim() === "") return "the title is empty.";
  if (title !== title.trim()) return "the title starts or ends with whitespace.";
  if (title.length > MAX_LENGTH) return `the title is ${title.length} characters; keep it to ${MAX_LENGTH}.`;
  const match = HEADER.exec(title);
  if (!match) {
    return `"${title}" is not \`type(scope): summary\`. Types: ${TYPES.join(", ")}. The scope and a \`!\` for a breaking change are optional.`;
  }
  if (/\.$/.test(match[4])) return "the summary ends with a period.";
  return null;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const title = process.argv[2] ?? process.env.PR_TITLE ?? "";
  const problem = titleProblem(title);
  if (problem) {
    console.error(`check-pr-title: ${problem}`);
    process.exit(1);
  }
  console.log(`check-pr-title: ok (${title})`);
}
