// Loaded only for a capable terminal. The basic CLI works even before npm ci installs Clack.
import type { Guide, Prompter } from "./io.ts";

export function useGuide(argv: string[], env: NodeJS.ProcessEnv, terminal: boolean): boolean {
  return (
    terminal &&
    !argv.some((arg) => ["--basic", "--non-interactive", "--json"].includes(arg)) &&
    !env.CI &&
    env.TERM !== "dumb"
  );
}

export async function loadGuide(): Promise<{ guide: Guide; prompter: Prompter } | undefined> {
  let p: typeof import("@clack/prompts");
  try {
    p = await import("@clack/prompts");
  } catch {
    return undefined;
  }
  const answer = <T>(value: T): Exclude<T, symbol> => {
    if (p.isCancel(value)) throw new Error("cancelled");
    return value as Exclude<T, symbol>;
  };
  const message = (text: string) =>
    text
      .replace(/^\d+\.\s*/, "")
      .trim()
      .replace(/:\s*$/, "");
  const guide: Guide = {
    intro: (title) => p.intro(title),
    outro: (text) => p.outro(text),
    message: (text, kind = "info") => p.log[kind](text),
    async task(text, work) {
      const spin = p.spinner();
      spin.start(text);
      try {
        const result = await work();
        if (
          result &&
          typeof result === "object" &&
          (("code" in result && result.code !== 0) || ("status" in result && result.status === "fail"))
        )
          spin.error("This step needs attention");
        else spin.stop(text.replace(/…$/, ""));
        return result;
      } catch (error) {
        spin.error("This step could not finish");
        throw error;
      }
    },
  };
  return {
    guide,
    prompter: {
      interactive: true,
      ask: async (question) => answer(await p.text({ message: message(question), defaultValue: "" })),
      askHidden: async (question) => answer(await p.password({ message: message(question) })),
      confirm: async (question, initialValue) => answer(await p.confirm({ message: message(question), initialValue })),
      select: async (question, options, initialValue) =>
        answer(
          await p.select<string>({ message: question, options: options.map((o) => ({ ...o })), initialValue }),
        ) as typeof initialValue,
    },
  };
}
