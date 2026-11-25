// Notifications: the worker that sends `notify` outbox rows to Web Push (every subscribed device) and the settings
// behind the Settings screen. The gateway holds the VAPID key; this side decides what to send, to whom, and when to try
// again.
import {
  type DeliveryChannel,
  type DeviceNotifications,
  NOTIFY_CATEGORIES,
  type NotificationsResponse,
  type NotifyCategory,
  type NotifyPayload,
  notifyCategory,
  type PushSubscriptionJson,
  type RegisterChannelRequest,
  type UpdateDeviceNotificationsRequest,
} from "@rei/protocol";
import { type AppStore, type OutboxRow, SEEN_SUFFIX } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import { badRequest, HttpError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";

/** How long after the n-th failed try the next one happens: 1 minute, 5 minutes, 30 minutes; then that destination gives up. */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;
/** A notification older than this is no longer news. */
export const DROP_AFTER_MS = 24 * 3_600_000;
/** A device's presence report counts for this long; clients report again well within it while visible. */
export const PRESENCE_MS = 90_000;
/** A device is active while it is visible and was touched this recently; while any device is active, push is held. */
export const ACTIVE_MS = 120_000;
const GATEWAY_TIMEOUT_MS = 15_000;
const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export interface NotifyDeps {
  store: AppStore;
  clock: Clock;
  log: Logger;
  /** The gateway's base URL; unset (faux mode): nothing can be sent. */
  gatewayUrl: string | undefined;
  fcmEnabled?: boolean;
  token: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch | undefined;
  /** How often the worker looks for rows that are due (default 15 s). */
  tickMs?: number;
}

interface SubRow {
  id: number;
  device_id: string | null;
  kind: "webpush" | "apns" | "fcm";
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: number;
  last_ok_at: number | null;
  failures: number;
}
interface DeliveryRow {
  outbox_id: number;
  destination: string;
  state: string;
  attempts: number;
  next_attempt_at: number | null;
}
type Outcome = { ok: true } | { ok: false; gone?: boolean; retryAfterMs?: number; status: number };

/** What a notification says instead of its body while previews are hidden: what kind of thing happened, not what. */
const HIDDEN_BODY: Record<NotifyPayload["event"], string> = {
  approval: "An agent is waiting for your approval.",
  takeover: "An agent needs you in its browser.",
  trigger_report: "A scheduled task has a report.",
  trigger_failed: "A scheduled task failed.",
  trigger_paused: "A scheduled task was paused.",
  session_done: "A chat has a new reply.",
  backup_failed: "A backup needs attention.",
};

/** The payload as sent: unchanged, or with its body replaced when previews are hidden. */
export function shownPayload(payload: NotifyPayload, preview: boolean): NotifyPayload {
  return preview ? payload : { ...payload, body: HIDDEN_BODY[payload.event] ?? "Open Rei to see it." };
}

/** What one device last said about itself: when it said it, and whether it was visible and touched then. */
interface Presence {
  reportedAt: number;
  visible: boolean;
  /** When the user last touched the device, on this server's clock. */
  inputAt: number;
}

const channelId = (row: SubRow) => `ch_${row.id}`;

export class NotificationService {
  readonly #d: NotifyDeps;
  readonly #presence = new Map<string, Presence>();
  /** Outbox rows (SEEN_SUFFIX) that were queued while a device was in use: you saw them happen. */
  readonly #seen = new Set<number>();
  #chain: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = true;
  constructor(deps: NotifyDeps) {
    this.#d = deps;
  }

  get #db() {
    return this.#d.store.db;
  }
  get #now(): number {
    return this.#d.clock.now();
  }

  start(): void {
    this.#stopped = false;
    this.#d.store.onNotifyQueued = () => {
      this.#noteSeen();
      void this.deliver();
    };
    this.#timer = setInterval(() => void this.deliver(), this.#d.tickMs ?? 15_000);
    this.#timer.unref?.();
    void this.deliver();
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#d.store.onNotifyQueued = undefined;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#chain;
  }

  // ---- the gateway -------------------------------------------------------------------------------------------------

  async #gateway(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const base = this.#d.gatewayUrl;
    if (!base)
      throw new HttpError(503, "gateway_unavailable", "Notifications need the gateway, which isn't running here.");
    const doFetch = this.#d.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const token = await this.#d.token();
    let res: Response;
    try {
      res = await doFetch(`${base.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, "gateway_unavailable", "The gateway could not be reached.");
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  }

  // ---- settings (the App API) --------------------------------------------------------------------------------------

  async vapidKey(): Promise<string> {
    const { status, body } = await this.#gateway("GET", "/notify/webpush/key");
    const response = asObject(body);
    if (status !== 200 || typeof response?.publicKey !== "string")
      throw new HttpError(502, "gateway_unavailable", "The gateway has no push key to give.");
    return response.publicKey;
  }

  /** Registers a browser's Web Push subscription; with a device, the subscription becomes that device's channel. */
  subscribe(
    subscription: PushSubscriptionJson,
    label: string,
    origin: string | undefined,
    deviceId?: string,
  ): DeliveryChannel {
    return this.#d.store.tx(() => {
      this.#db.run(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at, device_id, kind) VALUES (?, ?, ?, ?, ?, ?, 'webpush')
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, failures = 0,
           device_id = COALESCE(excluded.device_id, push_subscriptions.device_id), kind = 'webpush'`,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        label,
        this.#now,
        deviceId ?? null,
      );
      this.#recordOrigin(origin);
      return this.#channel(
        this.#db.get<SubRow>("SELECT * FROM push_subscriptions WHERE endpoint = ?", subscription.endpoint)!,
      );
    });
  }

  /** Registers (or refreshes) one of a device's delivery channels. */
  registerChannel(deviceId: string, label: string, request: RegisterChannelRequest, origin?: string): DeliveryChannel {
    if (request.kind === "webpush") return this.subscribe(request.subscription, label, origin, deviceId);
    return this.#d.store.tx(() => {
      this.#db.run(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at, device_id, kind) VALUES (?, '', '', ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET label = excluded.label, failures = 0, device_id = excluded.device_id, kind = excluded.kind`,
        `${request.kind}:${request.token}`,
        label,
        this.#now,
        deviceId,
        request.kind,
      );
      const channel = this.#db.get<SubRow>(
        "SELECT * FROM push_subscriptions WHERE endpoint = ?",
        `${request.kind}:${request.token}`,
      )!;
      // Android has one Firebase registration per installation. Retire older registrations atomically.
      if (request.kind === "fcm") {
        for (const old of this.#db.all<SubRow>(
          "SELECT * FROM push_subscriptions WHERE device_id = ? AND kind = 'fcm' AND id <> ?",
          deviceId,
          channel.id,
        ))
          this.#removeSubscription(old);
      }
      return this.#channel(channel);
    });
  }

  /** A device's delivery channels, oldest first. */
  channels(deviceId: string): DeliveryChannel[] {
    return this.#db
      .all<SubRow>("SELECT * FROM push_subscriptions WHERE device_id = ? ORDER BY id", deviceId)
      .map((row) => this.#channel(row));
  }

  removeChannel(deviceId: string, id: string): void {
    const row = this.#db
      .all<SubRow>("SELECT * FROM push_subscriptions WHERE device_id = ?", deviceId)
      .find((r) => channelId(r) === id);
    if (!row) throw new HttpError(404, "not_found", "No such channel on this device.");
    this.#removeSubscription(row);
  }

  /** A revoked device: its channels, choices and presence go with it. */
  removeDevice(deviceId: string): void {
    for (const row of this.#db.all<SubRow>("SELECT * FROM push_subscriptions WHERE device_id = ?", deviceId))
      this.#removeSubscription(row);
    this.#db.run("DELETE FROM device_notification_muted WHERE device_id = ?", deviceId);
    this.#presence.delete(deviceId);
    void this.deliver();
  }

  // ---- what a device receives --------------------------------------------------------------------------------------

  #mutedCategories(deviceId: string): Set<NotifyCategory> {
    return new Set(
      this.#db
        .all<{ category: string }>("SELECT category FROM device_notification_muted WHERE device_id = ?", deviceId)
        .map((r) => r.category as NotifyCategory),
    );
  }

  /** Which kinds of notification a device receives; every one is on until the device turns it off. */
  deviceSettings(deviceId: string): DeviceNotifications {
    const muted = this.#mutedCategories(deviceId);
    return {
      categories: Object.fromEntries(
        NOTIFY_CATEGORIES.map((category) => [category, !muted.has(category)]),
      ) as DeviceNotifications["categories"],
    };
  }

  /** Changes only the categories named; answers the full settings. */
  updateDeviceSettings(deviceId: string, request: UpdateDeviceNotificationsRequest): DeviceNotifications {
    this.#d.store.tx(() => {
      for (const category of NOTIFY_CATEGORIES) {
        const on = request.categories[category];
        if (on === undefined) continue;
        if (on) {
          this.#db.run(
            "DELETE FROM device_notification_muted WHERE device_id = ? AND category = ?",
            deviceId,
            category,
          );
        } else {
          this.#db.run(
            "INSERT OR IGNORE INTO device_notification_muted (device_id, category) VALUES (?, ?)",
            deviceId,
            category,
          );
        }
      }
    });
    return this.deviceSettings(deviceId);
  }

  #canSend(kind: SubRow["kind"]): boolean {
    return kind === "webpush" || (kind === "fcm" && this.#d.fcmEnabled === true && Boolean(this.#d.gatewayUrl));
  }
  #channel(row: SubRow): DeliveryChannel {
    return {
      id: channelId(row),
      kind: row.kind,
      state: !this.#canSend(row.kind) ? "not_configured" : row.failures > 0 ? "failing" : "active",
      createdAt: row.created_at,
      ...(row.last_ok_at !== null ? { lastOkAt: row.last_ok_at } : {}),
    };
  }
  unsubscribe(endpoint: string): void {
    this.#removeSubscription(this.#db.get<SubRow>("SELECT * FROM push_subscriptions WHERE endpoint = ?", endpoint));
  }
  #removeSubscription(sub: SubRow | undefined): void {
    if (!sub) return;
    this.#d.store.tx(() => {
      this.#db.run("DELETE FROM push_subscriptions WHERE id = ?", sub.id);
      this.#db.run("DELETE FROM notify_deliveries WHERE destination = ?", `push:${sub.id}`);
    });
  }
  #recordOrigin(origin: string | undefined): void {
    if (!origin) return;
    this.#db.run("UPDATE notification_settings SET app_url = ? WHERE id = 1", origin);
  }
  #preview(): boolean {
    return (
      this.#db.get<{ push_preview: number }>("SELECT push_preview FROM notification_settings WHERE id = 1")
        ?.push_preview !== 0
    );
  }
  #subscriptions(): SubRow[] {
    return this.#db
      .all<SubRow>("SELECT * FROM push_subscriptions ORDER BY id")
      .filter((row) => this.#canSend(row.kind));
  }

  /**
   * A device says whether it is visible and how long ago it was last touched. Devices that never name themselves
   * (the deprecated /api/presence of older web builds) count as touched whenever they report visible.
   */
  presence(deviceId: string, visible: boolean, idleMs = 0): void {
    const now = this.#now;
    this.#presence.set(deviceId, { reportedAt: now, visible, inputAt: now - Math.max(0, idleMs) });
    if (!this.#anyActive()) void this.deliver();
  }
  /** Visible and touched within ACTIVE_MS, by a report that is still fresh. */
  active(deviceId: string): boolean {
    const p = this.#presence.get(deviceId);
    const now = this.#now;
    return p?.visible === true && now - p.reportedAt < PRESENCE_MS && now - p.inputAt < ACTIVE_MS;
  }
  #anyActive(): boolean {
    for (const id of this.#presence.keys()) if (this.active(id)) return true;
    return false;
  }
  #present(): boolean {
    return this.#anyActive();
  }
  /** Remembers which queued notifications about visible things happened while a device was in use. */
  #noteSeen(): void {
    if (!this.#anyActive()) return;
    for (const row of this.#d.store.pendingOutbox("notify"))
      if (row.request_id.endsWith(SEEN_SUFFIX)) this.#seen.add(row.id);
  }

  async state(origin?: string): Promise<NotificationsResponse> {
    this.#recordOrigin(origin);
    const devices =
      this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions WHERE kind = 'webpush'")?.n ?? 0;
    return { devices, preview: this.#preview() };
  }

  /** Whether message text may show outside the app (notifications, glances); the user can hide it. */
  previewShown(): boolean {
    return this.#preview();
  }

  async setPreview(preview: boolean, origin?: string): Promise<NotificationsResponse> {
    this.#db.run("UPDATE notification_settings SET push_preview = ? WHERE id = 1", preview ? 1 : 0);
    return this.state(origin);
  }

  // ---- sending -----------------------------------------------------------------------------------------------------

  async #sendPush(sub: SubRow, payload: NotifyPayload, urgent: boolean): Promise<Outcome> {
    try {
      const settings = { ttl: DROP_AFTER_MS / 1000, urgency: urgent ? "high" : "normal" };
      const { status, body } =
        sub.kind === "fcm"
          ? await this.#gateway("POST", "/notify/fcm/send", {
              token: sub.endpoint.slice("fcm:".length),
              data: {
                event: payload.event,
                sessionId: payload.sessionId,
                ...(payload.messageId ? { messageId: payload.messageId } : {}),
                title: payload.title,
                body: payload.body,
                deviceId: sub.device_id ?? "",
              },
              ...settings,
            })
          : await this.#gateway("POST", "/notify/webpush/send", {
              subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload: JSON.stringify(payload),
              ...settings,
            });
      const response = asObject(body);
      if (status === 200 && response?.ok === true) return { ok: true };
      if (status === 200 && response?.ok === false)
        return {
          ok: false,
          gone: response.gone === true,
          status: Number(response.status) || 0,
          ...(typeof response.retryAfterMs === "number" && response.retryAfterMs > 0
            ? { retryAfterMs: response.retryAfterMs }
            : {}),
        };
      // The gateway refuses an endpoint that isn't on a known push service: it will never work, so drop it like a gone one.
      if (status === 400 && asObject(response?.error)?.code === "endpoint_not_allowed")
        return { ok: false, gone: true, status };
      return { ok: false, status };
    } catch {
      return { ok: false, status: 0 };
    }
  }
  /** Sends a test to every subscribed device now (not through the outbox, ignoring presence). Throws with the reason when something fails. */
  async test(): Promise<void> {
    const payload: NotifyPayload = {
      event: "session_done",
      sessionId: "",
      title: "Rei",
      body: "Hi! Notifications are on for this device. I'll let you know when something needs you.",
      path: "#/",
    };
    const subs = this.#subscriptions();
    if (subs.length === 0) throw badRequest("no_destinations", "Turn on notifications on this device first.");
    const failures: string[] = [];
    for (const sub of subs) {
      const result = await this.#sendPush(sub, payload, false);
      if (result.ok)
        this.#db.run("UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?", this.#now, sub.id);
      else if (result.gone) this.#removeSubscription(sub);
      else failures.push(`${sub.label} didn't accept it.`);
    }
    if (failures.length > 0) throw new HttpError(502, "test_failed", failures.join(" "));
  }

  // ---- the worker --------------------------------------------------------------------------------------------------

  /** Delivers what is due. Calls queue behind each other, so one row is never sent twice at once; resolves when this call's pass is done. */
  deliver(): Promise<void> {
    const run = this.#chain.then(() => this.#pass());
    this.#chain = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  async #pass(): Promise<void> {
    if (this.#stopped) return;
    const rows = this.#d.store.pendingOutbox("notify");
    if (rows.length === 0 || !this.#d.gatewayUrl) return;
    if (this.#present()) return;
    for (const row of rows) {
      if (this.#present()) return;
      try {
        await this.#deliverRow(row);
      } catch (error) {
        this.#d.log.error("notify.failed", {
          requestId: row.request_id,
          error: error instanceof Error ? error.name : "error",
        });
      }
    }
  }

  async #deliverRow(row: OutboxRow): Promise<void> {
    const now = this.#now;
    if (now - row.created_at > DROP_AFTER_MS || this.#seen.has(row.id)) return this.#finish(row, "dropped");
    const preview = this.#preview();
    // Previews are applied when sending, so changing the setting covers notifications already queued.
    const payload = shownPayload(JSON.parse(row.payload) as NotifyPayload, preview);
    // A device that turned this kind off never gets it, whatever channel it has; the choice is read when sending.
    const category = notifyCategory(payload.event);
    const done = new Map(
      this.#db
        .all<DeliveryRow>("SELECT * FROM notify_deliveries WHERE outbox_id = ?", row.id)
        .map((d) => [d.destination, d]),
    );
    const destinations = this.#subscriptions()
      .filter((s) => s.device_id === null || !this.#mutedCategories(s.device_id).has(category))
      .map((s) => ({ key: `push:${s.id}`, sub: s }));
    let open = 0;
    for (const dest of destinations) {
      const prior = done.get(dest.key);
      if (prior && prior.state !== "pending") continue;
      if (prior && prior.next_attempt_at !== null && prior.next_attempt_at > now) {
        open++;
        continue;
      }
      const result = await this.#sendPush(
        dest.sub,
        payload,
        payload.event === "approval" || payload.event === "takeover",
      );
      // A device can rotate or revoke its channel while the gateway request is in flight.
      if (!this.#db.get("SELECT id FROM push_subscriptions WHERE id = ?", dest.sub.id)) {
        if (this.#subscriptions().some((current) => !destinations.some(({ sub }) => sub.id === current.id))) open++;
        continue;
      }
      const attempts = (prior?.attempts ?? 0) + 1;
      if (result.ok) {
        this.#setDelivery(row.id, dest.key, "done", attempts, null);
        this.#db.run("UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?", now, dest.sub.id);
      } else if (result.gone) {
        this.#removeSubscription(dest.sub);
      } else if (attempts > RETRY_DELAYS_MS.length) {
        this.#setDelivery(row.id, dest.key, "failed", attempts, null);
        this.#db.run("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?", dest.sub.id);
      } else {
        const wait = Math.max(RETRY_DELAYS_MS[attempts - 1]!, result.retryAfterMs ?? 0);
        this.#setDelivery(row.id, dest.key, "pending", attempts, this.#now + wait);
        open++;
      }
    }
    if (open === 0) this.#finish(row, "delivered");
  }

  #setDelivery(outboxId: number, destination: string, state: string, attempts: number, next: number | null): void {
    this.#db.run(
      `INSERT INTO notify_deliveries (outbox_id, destination, state, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (outbox_id, destination) DO UPDATE SET state = excluded.state, attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at`,
      outboxId,
      destination,
      state,
      attempts,
      next,
    );
  }

  #finish(row: OutboxRow, state: "delivered" | "dropped"): void {
    this.#seen.delete(row.id);
    this.#d.store.tx(() => {
      this.#db.run(
        "UPDATE outbox SET state = ?, delivered_at = ?, payload = '{}' WHERE id = ?",
        state,
        this.#now,
        row.id,
      );
      this.#db.run("DELETE FROM notify_deliveries WHERE outbox_id = ?", row.id);
    });
  }
}
