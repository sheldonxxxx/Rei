// Web Push in this browser: whether it can work here, and turning it on and off for this device.
import type { PushSubscriptionJson } from "@rei/protocol";
import type { Api } from "../api/client.ts";

/** Why push can't be turned on here, or "ok". */
export type PushSupport = "ok" | "needs_home_screen" | "unsupported" | "denied";

/** What the Settings control needs from the browser; tests pass a fake. */
export interface PushEnv {
  support(): PushSupport;
  /** Whether this browser holds a push subscription. */
  subscribed(): Promise<boolean>;
  /** Asks permission, subscribes and tells the server. Throws PushDenied when the user says no. */
  enable(api: Pick<Api, "getPushKey" | "registerChannel">): Promise<void>;
  /** Removes this device's Web Push channel on the server and drops the browser's subscription. */
  disable(api: Pick<Api, "getDevices" | "removeChannel">): Promise<void>;
}

export class PushDenied extends Error {
  constructor() {
    super("Notifications are blocked.");
    this.name = "PushDenied";
  }
}

export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const isIos = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = (): boolean =>
  (navigator as { standalone?: boolean }).standalone === true ||
  (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);

async function registration(): Promise<ServiceWorkerRegistration> {
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("The app isn't ready for notifications yet. Reload and try again.")), 5_000),
  );
  return Promise.race([ready, timeout]);
}

export const browserPush: PushEnv = {
  support() {
    // iOS only has push in an app on the Home Screen, and there Safari shows no PushManager until then.
    if (isIos() && !isStandalone()) return "needs_home_screen";
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
      return "unsupported";
    if (Notification.permission === "denied") return "denied";
    return "ok";
  },
  async subscribed() {
    if (this.support() !== "ok" || Notification.permission !== "granted") return false;
    try {
      return (await (await registration()).pushManager.getSubscription()) !== null;
    } catch {
      return false;
    }
  },
  async enable(api) {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new PushDenied();
    const { publicKey } = await api.getPushKey();
    const reg = await registration();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey),
    });
    const json = sub.toJSON();
    const subscription: PushSubscriptionJson = {
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    };
    try {
      await api.registerChannel({ kind: "webpush", subscription });
    } catch (error) {
      await sub.unsubscribe().catch(() => false); // the server doesn't know it, so the browser shouldn't keep it
      throw error;
    }
  },
  async disable(api) {
    const sub = await (await registration()).pushManager.getSubscription();
    // The channel belongs to this device: a browser holds one push subscription, so its Web Push channels are this one.
    const { devices } = await api.getDevices();
    const here = devices.find((d) => d.current);
    for (const channel of here?.channels ?? []) {
      if (channel.kind === "webpush") await api.removeChannel(channel.id);
    }
    if (sub) await sub.unsubscribe().catch(() => false);
  },
};
