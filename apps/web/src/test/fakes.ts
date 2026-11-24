import type { LiveClientMessage, LiveServerMessage } from "@rei/protocol";

/** A WebSocket the test drives: the server's side is `serverSend`, `serverFrame` and `serverClose`; what the app sent is in `sent`. */
export class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  static get last(): FakeWebSocket {
    return FakeWebSocket.all[FakeWebSocket.all.length - 1]!;
  }
  static reset() {
    FakeWebSocket.all = [];
  }
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.all.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  /** What the app sent, parsed. */
  get messages(): LiveClientMessage[] {
    return this.sent.map((s) => JSON.parse(s) as LiveClientMessage);
  }
  serverSend(msg: LiveServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
  serverFrame(blob: Blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" })) {
    this.onmessage?.({ data: blob } as MessageEvent);
  }
  serverClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

export const hello = (over: Partial<Extract<LiveServerMessage, { type: "hello" }>> = {}): LiveServerMessage => ({
  type: "hello",
  viewport: { width: 1280, height: 900 },
  url: "https://bank.example.com/login",
  title: "Sign in",
  control: false,
  ...over,
});
