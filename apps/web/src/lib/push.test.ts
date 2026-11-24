import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPush, PushDenied, urlBase64ToBytes } from "./push.ts";

afterEach(() => vi.unstubAllGlobals());

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("urlBase64ToBytes", () => {
  it("decodes base64url", () => {
    expect([...urlBase64ToBytes("_-8")]).toEqual([255, 239]);
  });
});

function stubBrowser(
  over: { ua?: string; standalone?: boolean; permission?: NotificationPermission; push?: boolean } = {},
) {
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/x",
    toJSON: () => ({ keys: { p256dh: "pk", auth: "ak" } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const pushManager = {
    subscribe: vi.fn().mockResolvedValue(sub),
    getSubscription: vi.fn().mockResolvedValue(null as typeof sub | null),
  };
  const requestPermission = vi.fn().mockResolvedValue(over.permission ?? "granted");
  vi.stubGlobal("navigator", {
    userAgent: over.ua ?? MAC_CHROME,
    platform: "MacIntel",
    maxTouchPoints: 0,
    standalone: over.standalone,
    serviceWorker: { ready: Promise.resolve({ pushManager }) },
  });
  vi.stubGlobal(
    "Notification",
    Object.assign(() => {}, { permission: over.permission ?? "default", requestPermission }),
  );
  if (over.push !== false) vi.stubGlobal("PushManager", () => {});
  else {
    vi.stubGlobal("PushManager", undefined);
    delete (globalThis as { PushManager?: unknown }).PushManager;
  }
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  return { sub, pushManager, requestPermission };
}

describe("support", () => {
  it("is ok where push exists", () => {
    stubBrowser();
    expect(browserPush.support()).toBe("ok");
  });
  it("asks for the Home Screen on iOS outside an installed app, and allows it inside", () => {
    stubBrowser({ ua: IPHONE, push: false });
    expect(browserPush.support()).toBe("needs_home_screen");
    stubBrowser({ ua: IPHONE, standalone: true });
    expect(browserPush.support()).toBe("ok");
  });
  it("is unsupported without PushManager, and denied when blocked", () => {
    stubBrowser({ push: false });
    expect(browserPush.support()).toBe("unsupported");
    stubBrowser({ permission: "denied" });
    expect(browserPush.support()).toBe("denied");
  });
});

describe("enable and disable", () => {
  it("asks permission, subscribes with the server's key, and registers it as this device's channel", async () => {
    const b = stubBrowser();
    const api = {
      getPushKey: vi.fn().mockResolvedValue({ publicKey: "_-8" }),
      registerChannel: vi.fn().mockResolvedValue({ channel: {} }),
    };
    await browserPush.enable(api);
    expect(b.requestPermission).toHaveBeenCalled();
    expect(b.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([255, 239]),
    });
    expect(api.registerChannel).toHaveBeenCalledWith({
      kind: "webpush",
      subscription: { endpoint: b.sub.endpoint, keys: { p256dh: "pk", auth: "ak" } },
    });
  });

  it("throws PushDenied, and subscribes to nothing, when permission is refused", async () => {
    const b = stubBrowser({ permission: "denied" });
    const api = { getPushKey: vi.fn(), registerChannel: vi.fn() };
    await expect(browserPush.enable(api)).rejects.toBeInstanceOf(PushDenied);
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.getPushKey).not.toHaveBeenCalled();
  });

  it("drops the browser's subscription when the server refuses it", async () => {
    const b = stubBrowser();
    const api = {
      getPushKey: vi.fn().mockResolvedValue({ publicKey: "_-8" }),
      registerChannel: vi.fn().mockRejectedValue(new Error("no")),
    };
    await expect(browserPush.enable(api)).rejects.toThrow("no");
    expect(b.sub.unsubscribe).toHaveBeenCalled();
  });

  it("tells the server and unsubscribes on disable", async () => {
    const b = stubBrowser({ permission: "granted" });
    b.pushManager.getSubscription.mockResolvedValue(b.sub);
    const channel = (id: string, kind: string) => ({ id, kind, state: "active", createdAt: 1 });
    const api = {
      getDevices: vi.fn().mockResolvedValue({
        devices: [
          { id: "dev_other", current: false, channels: [channel("ch_1", "webpush")] },
          { id: "dev_here", current: true, channels: [channel("ch_2", "webpush"), channel("ch_3", "apns")] },
        ],
      }),
      removeChannel: vi.fn().mockResolvedValue({ ok: true }),
    };
    expect(await browserPush.subscribed()).toBe(true);
    await browserPush.disable(api);
    expect(api.removeChannel.mock.calls).toEqual([["ch_2"]]);
    expect(b.sub.unsubscribe).toHaveBeenCalled();
  });
});
