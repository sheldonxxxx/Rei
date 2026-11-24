// Line input for a terminal in raw mode (needed to not echo a key). A small state machine so it can be tested without a tty.

export interface Fed {
  /** What to write back to the terminal for this input. */
  echo: string;
  done: boolean;
  cancelled: boolean;
}

/** Arrow keys and other escape sequences (and the brackets around a bracketed paste) are dropped. */
const ESCAPES = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)/g;

export class LineReader {
  readonly #echo: boolean;
  #value = "";

  constructor(echo: boolean) {
    this.#echo = echo;
  }

  get value(): string {
    return this.#value;
  }

  feed(chunk: string): Fed {
    let echo = "";
    for (const ch of chunk.replace(ESCAPES, "")) {
      if (ch === "\r" || ch === "\n") return { echo, done: true, cancelled: false };
      if (ch === "\x03" || (ch === "\x04" && this.#value === "")) return { echo, done: false, cancelled: true };
      if (ch === "\x7f" || ch === "\b") {
        if (this.#value.length > 0) {
          this.#value = this.#value.slice(0, -1);
          if (this.#echo) echo += "\b \b";
        }
      } else if (ch >= " ") {
        this.#value += ch;
        if (this.#echo) echo += ch;
      }
    }
    return { echo, done: false, cancelled: false };
  }
}
