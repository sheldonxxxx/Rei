// The chat format note is the model's list of the Markdown its replies can use. It must name each syntax the chat
// renderer supports and keep the full-width-bracket warning, so a reply writes links that render.
import { describe, expect, it } from "vitest";
import { CHAT_FORMAT_NOTE, createChatFormatExtension } from "../src/pi/chat-format.ts";

describe("chat format note", () => {
  it("names the syntax the chat renderer supports", () => {
    for (const marker of [
      "**bold**",
      "~~strikethrough~~",
      "```mermaid",
      "> [!NOTE]",
      "[!CAUTION]",
      "- [ ] open",
      "|:--|--:|",
      "[^1]:",
      "[text](https://",
      "mailto:",
      "page:<id>#<slug>",
      "file:<id>",
      "![alt](file:<id>)",
      "Not supported:",
    ]) {
      expect(CHAT_FORMAT_NOTE, marker).toContain(marker);
    }
  });

  it("opens with the reply language, so every agent answers in the user's language", () => {
    expect(CHAT_FORMAT_NOTE.split("\n")[0]).toBe(
      "Reply in the language the user writes in, unless they ask for another.",
    );
  });

  it("warns that full-width brackets are not links", () => {
    expect(CHAT_FORMAT_NOTE).toContain("full-width brackets");
  });

  it("is installed as one prompt section", () => {
    const extension = createChatFormatExtension();
    expect(extension.name).toBe("chat_format");
    expect(extension.sections).toHaveLength(1);
  });
});
