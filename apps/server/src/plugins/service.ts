import type {
  ComponentOwner,
  PluginDetail,
  PluginInstallationRequest,
  PluginPackage,
  PluginRevision,
  PluginSummary,
} from "@rei/protocol";
import type { McpService } from "../mcp/service.ts";
import type { SaveInput, SkillStore } from "../skills/store.ts";
import { GLOBAL_STREAM } from "../store/events.ts";
import type { AppStore } from "../store/store.ts";
import { HttpError, Invalid, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { validatePackage } from "./package.ts";

interface Row {
  id: string;
  name: string;
  current_revision: number;
  enabled: number;
  agents_json: string | null;
}
interface ConnectionRow {
  plugin_id: string;
  name: string;
  connector_id: string | null;
  url: string;
  status: "pending" | "needs_auth" | "ready" | "error";
  error: string | null;
}
interface SkillBinding {
  plugin_id: string;
  name: string;
  skill_id: string;
}
export class PluginService {
  #tail: Promise<unknown> = Promise.resolve();
  #writes: Promise<unknown> = Promise.resolve();
  #projecting = false;
  readonly app: AppStore;
  readonly skills: SkillStore;
  readonly mcp: McpService;
  constructor(app: AppStore, skills: SkillStore, mcp: McpService) {
    this.app = app;
    this.skills = skills;
    this.mcp = mcp;
    skills.available = (id, agent) => this.componentAvailable("plugin_skills", "skill_id", id, agent);
    skills.onSaved = (id) => {
      if (!this.#projecting) this.syncSkill(id);
    };
  }
  get db() {
    return this.app.db;
  }
  #changed() {
    this.app.events.append(GLOBAL_STREAM, { type: "plugins.changed" });
  }
  #row(id: string) {
    return this.db.get<Row>("SELECT * FROM plugins WHERE id = ? OR name = ?", id, id);
  }
  #content(row: Row, revision = row.current_revision): PluginPackage {
    const saved = this.db.get<{ package_json: string }>(
      "SELECT package_json FROM plugin_revisions WHERE plugin_id = ? AND revision = ?",
      row.id,
      revision,
    );
    if (!saved) throw notFound("That plugin revision does not exist.");
    return JSON.parse(saved.package_json);
  }
  #summary(row: Row): PluginSummary {
    const pkg = this.#content(row);
    return {
      id: row.id,
      name: row.name,
      description: pkg.description,
      revision: row.current_revision,
      enabled: !!row.enabled,
      agents: row.agents_json ? JSON.parse(row.agents_json) : null,
      builtIn: false,
      skillCount: pkg.skills.length,
      connectionCount: pkg.mcp.length,
    };
  }
  visible(id: string, agent?: string): boolean {
    const r = this.#row(id);
    return (
      !!r &&
      (agent === undefined ||
        (!!r.enabled && (!r.agents_json || (JSON.parse(r.agents_json) as string[]).includes(agent))))
    );
  }
  componentAvailable(
    table: "plugin_skills" | "plugin_connections",
    column: "skill_id" | "connector_id",
    id: string,
    agent?: string,
  ): boolean {
    const binding = this.db.get<{ plugin_id: string }>(`SELECT plugin_id FROM ${table} WHERE ${column} = ?`, id);
    if (this.db.get("SELECT 1 FROM plugin_retired_connections WHERE connector_id = ?", id)) return false;
    return !binding || this.visible(binding.plugin_id, agent ?? "");
  }
  /** The plugin that owns a skill or connector; null when it is standalone. */
  owner(kind: "skill" | "connection", id: string): ComponentOwner | null {
    const row =
      kind === "skill"
        ? this.db.get<Row>(
            "SELECT p.* FROM plugin_skills ps JOIN plugins p ON p.id = ps.plugin_id WHERE ps.skill_id = ?",
            id,
          )
        : this.db.get<Row>(
            "SELECT p.* FROM plugin_connections pc JOIN plugins p ON p.id = pc.plugin_id WHERE pc.connector_id = ?",
            id,
          );
    return row ? { id: row.id, name: row.name, enabled: !!row.enabled } : null;
  }
  skillInfo(id: string): { plugin: string; reference: string } | undefined {
    const b = this.db.get<{ name: string; plugin: string }>(
      "SELECT ps.name, p.name AS plugin FROM plugin_skills ps JOIN plugins p ON p.id = ps.plugin_id WHERE skill_id = ?",
      id,
    );
    return b ? { plugin: b.plugin, reference: `${b.plugin}/${b.name}` } : undefined;
  }
  guidance(id: string): { plugin: string; skills: string[] } | undefined {
    const binding = this.db.get<ConnectionRow>("SELECT * FROM plugin_connections WHERE connector_id = ?", id);
    if (!binding) return undefined;
    const row = this.#row(binding.plugin_id);
    if (!row) return undefined;
    return {
      plugin: row.name,
      skills: (this.#content(row).mcp.find((c) => c.name === binding.name)?.skills ?? []).map(
        (s) => `${row.name}/${s}`,
      ),
    };
  }
  #insert(pkg: PluginPackage, author: "user" | "agent", session: string | null): Row {
    const id = newId("plg", this.app.clock.now());
    this.db.run("INSERT INTO plugins (id,name,current_revision) VALUES (?,?,1)", id, pkg.name);
    this.db.run(
      "INSERT INTO plugin_revisions VALUES (?,?,?,?,?,?)",
      id,
      1,
      JSON.stringify(pkg),
      author,
      session,
      this.app.clock.now(),
    );
    return this.#row(id)!;
  }
  async list(agent?: string): Promise<PluginSummary[]> {
    await this.#tail.catch(() => undefined);
    const saved = this.db
      .all<Row>("SELECT * FROM plugins ORDER BY name")
      .filter((r) => this.visible(r.id, agent))
      .map((r) => this.#summary(r));
    const builtin = this.skills
      .list(agent)
      .filter((s) => s.builtIn)
      .map(
        (s): PluginSummary => ({
          id: s.id,
          name: s.name,
          description: s.description,
          revision: s.version,
          enabled: true,
          agents: null,
          builtIn: true,
          skillCount: 1,
          connectionCount: 0,
        }),
      );
    return [...builtin, ...saved];
  }
  async get(id: string, agent?: string, revision?: number): Promise<PluginDetail> {
    const builtin =
      this.skills.get(id) ??
      this.skills
        .list()
        .filter((s) => s.builtIn && s.name === id)
        .map((s) => this.skills.get(s.id))[0];
    if (builtin?.skill.builtIn)
      return {
        id,
        name: builtin.skill.name,
        description: builtin.skill.description,
        revision: builtin.version,
        enabled: true,
        agents: null,
        builtIn: true,
        skillCount: 1,
        connectionCount: 0,
        selectedRevision: builtin.version,
        package: {
          formatVersion: 1,
          name: builtin.skill.name,
          description: builtin.skill.description,
          skills: [{ name: builtin.skill.name, files: builtin.files }],
          mcp: [],
        },
        skills: [{ name: builtin.skill.name, id, reference: builtin.skill.name }],
        connections: [],
        revisions: [],
      };
    const row = this.#row(id);
    if (!row || !this.visible(row.id, agent)) throw notFound("That plugin is unavailable.");
    const pkg = this.#content(row, revision);
    const connectors = await this.mcp.list().catch(() => []);
    const connections = this.db
      .all<ConnectionRow>("SELECT * FROM plugin_connections WHERE plugin_id = ? ORDER BY name", row.id)
      .map((r) => {
        const c = connectors.find((c) => c.id === r.connector_id);
        return {
          name: r.name,
          connectorId: r.connector_id,
          status: c
            ? c.status === "connected"
              ? ("ready" as const)
              : c.status
            : r.connector_id && r.status === "ready"
              ? ("error" as const)
              : r.status,
          error: c?.error ?? r.error ?? (r.connector_id && !c ? "Connection is unavailable. Retry setup." : null),
          ...(c ? { connector: c } : {}),
        };
      });
    return {
      ...this.#summary(row),
      package: pkg,
      selectedRevision: revision ?? row.current_revision,
      revisions: this.db
        .all<{ revision: number; author: "user" | "agent"; session_id: string | null; created_at: number }>(
          "SELECT revision,author,session_id,created_at FROM plugin_revisions WHERE plugin_id = ? ORDER BY revision DESC",
          row.id,
        )
        .map(
          (v): PluginRevision => ({
            revision: v.revision,
            author: v.author,
            sessionId: v.session_id,
            createdAt: v.created_at,
          }),
        ),
      skills: this.db
        .all<SkillBinding>("SELECT * FROM plugin_skills WHERE plugin_id = ?", row.id)
        .map((s) => ({ name: s.name, id: s.skill_id, reference: `${row.name}/${s.name}` })),
      connections,
    };
  }
  validate(value: unknown, id?: string, expectedRevision?: number): PluginPackage {
    const pkg = validatePackage(value);
    const row = id ? this.#row(id) : undefined;
    if (id && !row) throw notFound("That plugin does not exist or is read-only.");
    if (row && expectedRevision !== row.current_revision)
      throw new HttpError(409, "plugin_changed", "The plugin changed. Read it again before updating.");
    if (row && pkg.name !== row.name) throw new Invalid("A plugin's name cannot change.");
    const other = this.#row(pkg.name);
    if (other && other.id !== row?.id && JSON.stringify(pkg) !== JSON.stringify(this.#content(other)))
      throw new HttpError(409, "plugin_exists", "A plugin with that name already exists.");
    return pkg;
  }
  save(
    value: unknown,
    options: { id?: string; expectedRevision?: number; author: "user" | "agent"; sessionId?: string },
  ): Promise<PluginDetail> {
    const task = this.#writes
      .catch(() => undefined)
      .then(async () => {
        await this.#tail.catch(() => undefined);
        return this.#save(value, options);
      });
    this.#writes = task;
    return task;
  }
  async #save(
    value: unknown,
    options: { id?: string; expectedRevision?: number; author: "user" | "agent"; sessionId?: string },
  ): Promise<PluginDetail> {
    const pkg = this.validate(value, options.id, options.expectedRevision);
    const existing = options.id ? this.#row(options.id) : this.#row(pkg.name);
    let id = existing?.id;
    this.app.tx(() => {
      // Recheck within the write transaction.
      this.validate(pkg, options.id, options.expectedRevision);
      let row = existing;
      if (!row) row = this.#insert(pkg, options.author, options.sessionId ?? null);
      else if (JSON.stringify(this.#content(row)) !== JSON.stringify(pkg)) {
        const next = row.current_revision + 1;
        this.db.run(
          "INSERT INTO plugin_revisions VALUES (?,?,?,?,?,?)",
          row.id,
          next,
          JSON.stringify(pkg),
          options.author,
          options.sessionId ?? null,
          this.app.clock.now(),
        );
        this.db.run("UPDATE plugins SET current_revision = ? WHERE id = ?", next, row.id);
      }
      id = row.id;
      this.#projecting = true;
      try {
        const prior = this.db.all<SkillBinding>("SELECT * FROM plugin_skills WHERE plugin_id = ?", row.id);
        for (const s of pkg.skills) {
          const binding = prior.find((b) => b.name === s.name);
          const skill = this.skills.save({
            files: s.files,
            storageName: binding ? this.skills.get(binding.skill_id)!.skill.name : `${pkg.name}/${s.name}`,
            author: options.author,
            sessionId: options.sessionId,
            note: "Plugin update",
            log: options.author === "user",
          }).skill;
          this.db.run("INSERT OR REPLACE INTO plugin_skills VALUES (?,?,?)", row.id, s.name, skill.id);
        }
        for (const b of prior.filter((b) => !pkg.skills.some((s) => s.name === b.name))) {
          this.db.run("DELETE FROM plugin_skills WHERE skill_id = ?", b.skill_id);
          this.skills.remove(b.skill_id);
        }
      } finally {
        this.#projecting = false;
      }
      const connections = this.db.all<ConnectionRow>("SELECT * FROM plugin_connections WHERE plugin_id = ?", row.id);
      for (const b of connections) {
        const next = pkg.mcp.find((c) => c.name === b.name);
        const before = this.#content(existing ?? row).mcp.find((c) => c.name === b.name);
        if (next?.url === b.url && (!before || before.auth === next.auth)) continue;
        if (b.connector_id)
          this.db.run("INSERT OR IGNORE INTO plugin_retired_connections VALUES (?,?)", b.connector_id, row.id);
        this.db.run("DELETE FROM plugin_connections WHERE plugin_id = ? AND name = ?", row.id, b.name);
      }
      for (const c of pkg.mcp)
        this.db.run(
          "INSERT OR IGNORE INTO plugin_connections (plugin_id,name,url) VALUES (?,?,?)",
          row.id,
          c.name,
          c.url,
        );
      this.#changed();
    });
    await this.reconcile(id!);
    return this.get(id!);
  }
  /** Single queue prevents duplicate provisioning; persisted bindings allow retries after restart. */
  reconcile(id: string): Promise<void> {
    const task = this.#tail
      .catch(() => undefined)
      .then(async () => {
        const row = this.#row(id);
        if (!row) return;
        for (const retired of this.db.all<{ connector_id: string }>(
          "SELECT connector_id FROM plugin_retired_connections WHERE plugin_id = ?",
          row.id,
        )) {
          try {
            await this.mcp.remove(retired.connector_id);
            this.db.run("DELETE FROM plugin_retired_connections WHERE connector_id = ?", retired.connector_id);
          } catch (e) {
            if (e instanceof HttpError && e.status === 404)
              this.db.run("DELETE FROM plugin_retired_connections WHERE connector_id = ?", retired.connector_id);
          }
        }
        for (const b of this.db.all<ConnectionRow>("SELECT * FROM plugin_connections WHERE plugin_id = ?", row.id)) {
          try {
            // A stable owner key makes a retry safe even if the gateway committed before the response was lost.
            let connector = b.connector_id;
            if (!connector) {
              const c = await this.mcp.create({
                name: `${row.name}/${b.name}`,
                url: b.url,
                auth: this.#content(row).mcp.find((c) => c.name === b.name)?.auth,
                ownerKey: `${row.id}/${b.name}/${b.url}`,
              });
              connector = c.id;
              this.db.run(
                "UPDATE plugin_connections SET connector_id = ? WHERE plugin_id = ? AND name = ? AND url = ?",
                connector,
                row.id,
                b.name,
                b.url,
              );
            }
            await this.mcp.tools(connector, true);
            this.db.run(
              "UPDATE plugin_connections SET status = 'ready', error = NULL WHERE plugin_id = ? AND name = ?",
              row.id,
              b.name,
            );
          } catch (e) {
            const message = e instanceof Error ? e.message : "Connection setup failed.";
            this.db.run(
              "UPDATE plugin_connections SET status = ?, error = ? WHERE plugin_id = ? AND name = ?",
              e instanceof HttpError && e.code === "needs_auth" ? "needs_auth" : "error",
              message,
              row.id,
              b.name,
            );
          }
        }
        this.app.tx(() => this.#changed());
      });
    this.#tail = task;
    return task;
  }
  async installation(id: string, input: PluginInstallationRequest): Promise<PluginDetail> {
    const row = this.#row(id);
    if (!row) throw notFound("That plugin is read-only or unavailable.");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean")
      throw new Invalid("enabled must be a boolean.");
    if (
      input.agents !== undefined &&
      input.agents !== null &&
      (!Array.isArray(input.agents) || input.agents.some((id) => typeof id !== "string" || !this.app.getAgent(id)))
    )
      throw new Invalid("agents must contain existing agent IDs.");
    this.app.tx(() => {
      if (input.enabled !== undefined)
        this.db.run("UPDATE plugins SET enabled = ? WHERE id = ?", input.enabled ? 1 : 0, row.id);
      if (input.agents !== undefined)
        this.db.run(
          "UPDATE plugins SET agents_json = ? WHERE id = ?",
          input.agents === null ? null : JSON.stringify(input.agents),
          row.id,
        );
      this.#changed();
    });
    return this.get(row.id);
  }
  async remove(id: string): Promise<void> {
    const row = this.#row(id);
    if (!row) throw notFound("That plugin is read-only or unavailable.");
    await this.installation(id, { enabled: false });
    // Retain a disabled installation when cleanup fails, so deletion can be retried.
    for (const b of this.db.all<ConnectionRow>("SELECT * FROM plugin_connections WHERE plugin_id = ?", row.id))
      if (b.connector_id) await this.mcp.remove(b.connector_id);
    for (const retired of this.db.all<{ connector_id: string }>(
      "SELECT connector_id FROM plugin_retired_connections WHERE plugin_id = ?",
      row.id,
    )) {
      await this.mcp.remove(retired.connector_id);
      this.db.run("DELETE FROM plugin_retired_connections WHERE connector_id = ?", retired.connector_id);
    }
    if (this.db.get("SELECT 1 FROM plugin_retired_connections WHERE plugin_id = ?", row.id))
      throw new HttpError(502, "cleanup_failed", "Connection cleanup failed. Retry removal.");
    this.app.tx(() => {
      for (const s of this.db.all<SkillBinding>("SELECT * FROM plugin_skills WHERE plugin_id = ?", row.id))
        this.skills.remove(s.skill_id);
      this.db.run("DELETE FROM plugins WHERE id = ?", row.id);
      this.#changed();
    });
  }
  /** A plugin skill edited through the skill store (Settings, save_skill): mirror it into the owning package. */
  syncSkill(id: string) {
    const b = this.db.get<SkillBinding>("SELECT * FROM plugin_skills WHERE skill_id = ?", id);
    // A standalone skill has no package to mirror into.
    if (!b) return;
    const row = this.#row(b.plugin_id)!;
    const skill = this.skills.get(id)!;
    const pkg = this.#content(row);
    const s = pkg.skills.find((s) => s.name === b.name)!;
    if (JSON.stringify(s.files) === JSON.stringify(skill.files)) return;
    s.files = skill.files;
    this.app.tx(() => {
      this.db.run(
        "INSERT INTO plugin_revisions VALUES (?,?,?,?,?,?)",
        row.id,
        row.current_revision + 1,
        JSON.stringify(pkg),
        skill.skill.author,
        null,
        this.app.clock.now(),
      );
      this.db.run("UPDATE plugins SET current_revision = current_revision + 1 WHERE id = ?", row.id);
      this.#changed();
    });
  }
  removeComponent(kind: "skill" | "connection", id: string) {
    const b =
      kind === "skill"
        ? this.db.get<{ plugin_id: string; name: string }>("SELECT * FROM plugin_skills WHERE skill_id = ?", id)
        : this.db.get<{ plugin_id: string; name: string }>(
            "SELECT * FROM plugin_connections WHERE connector_id = ?",
            id,
          );
    if (!b) return;
    this.app.tx(() => {
      const row = this.#row(b.plugin_id)!;
      const pkg = this.#content(row);
      if (kind === "skill") {
        pkg.skills = pkg.skills.filter((s) => s.name !== b.name);
        pkg.mcp = pkg.mcp.map((c) => ({ ...c, skills: c.skills.filter((s) => s !== b.name) }));
        this.db.run("DELETE FROM plugin_skills WHERE skill_id = ?", id);
      } else {
        pkg.mcp = pkg.mcp.filter((c) => c.name !== b.name);
        this.db.run("DELETE FROM plugin_connections WHERE connector_id = ?", id);
      }
      if (!pkg.skills.length && !pkg.mcp.length) this.db.run("DELETE FROM plugins WHERE id = ?", row.id);
      else {
        this.db.run(
          "INSERT INTO plugin_revisions VALUES (?,?,?,?,?,?)",
          row.id,
          row.current_revision + 1,
          JSON.stringify(pkg),
          "user",
          null,
          this.app.clock.now(),
        );
        this.db.run("UPDATE plugins SET current_revision = current_revision + 1 WHERE id = ?", row.id);
      }
      this.#changed();
    });
  }
  async drain() {
    await this.#writes.catch(() => undefined);
    await this.#tail.catch(() => undefined);
  }
  saveSkill(input: SaveInput) {
    return this.skills.save(input);
  }
}
