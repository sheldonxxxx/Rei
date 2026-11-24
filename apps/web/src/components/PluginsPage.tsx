import type { Agent, PluginDetail, PluginPackage, PluginSummary } from "@rei/protocol";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Field, FieldGroup, FieldLabel } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { navigate, PLUGINS_PATH } from "../lib/route.ts";
import { ConnectorDetail } from "./ConnectorsPage.tsx";
import { ConfirmDialog } from "./dialogParts.tsx";
import { PageShell } from "./PageShell.tsx";
import { SkillMdView } from "./SkillDetail.tsx";

const href = (id?: string) => `${PLUGINS_PATH}${id ? `/${encodeURIComponent(id)}` : ""}`;
const empty = (): PluginPackage => ({ formatVersion: 1, name: "", description: "", skills: [], mcp: [] });
const kind = (p: PluginSummary) =>
  p.skillCount && p.connectionCount ? "Skills + MCP" : p.skillCount ? "Skills" : "MCP";

export function PluginsPage({ api, id, agents, rev }: { api: Api; id: string | null; agents: Agent[]; rev: number }) {
  const [items, setItems] = useState<PluginSummary[]>([]);
  const [plugin, setPlugin] = useState<PluginDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [history, setHistory] = useState<PluginDetail | null>(null);
  const load = useCallback(async () => {
    try {
      const list = await api.getPlugins();
      setItems(list.plugins);
      if (id && id !== "new") setPlugin((await api.getPlugin(id)).plugin);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
    setLoaded(true);
  }, [api, id]);
  useEffect(() => {
    setPlugin(null);
    setConnection(null);
    setHistory(null);
    setEditing(false);
    setLoaded(false);
    void load();
  }, [load]);
  useEffect(() => {
    if (rev) void load();
  }, [load, rev]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  if (connection)
    return (
      <ConnectorDetail
        api={api}
        id={connection}
        rev={rev}
        navigate={(url) => window.location.assign(url)}
        banner={null}
        onBack={() => {
          setConnection(null);
          void load();
        }}
      />
    );
  const back = () => {
    setEditing(false);
    setHistory(null);
    navigate(href());
  };
  if (id === "new" || (editing && plugin))
    return (
      <PluginEditor
        key={id}
        initial={plugin?.package ?? empty()}
        existing={!!plugin}
        busy={busy}
        error={error}
        onCancel={() => (plugin ? setEditing(false) : back())}
        onSave={(pkg) =>
          void act(async () => {
            const result = plugin
              ? await api.updatePlugin(plugin.id, { package: pkg, expectedRevision: plugin.revision })
              : await api.createPlugin({ package: pkg });
            setEditing(false);
            navigate(href(result.plugin.id));
          })
        }
      />
    );
  return (
    <PageShell
      title={plugin?.name ?? "Plugins"}
      onBack={plugin ? back : undefined}
      actions={
        !id ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <label>
                Import
                <input
                  type="file"
                  accept=".zip"
                  className="sr-only"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file)
                      void act(async () => {
                        const bytes = new Uint8Array(await file.arrayBuffer());
                        let binary = "";
                        for (const b of bytes) binary += String.fromCharCode(b);
                        const result = await api.importPlugin({ zip: btoa(binary) });
                        navigate(href(result.plugin.id));
                      });
                  }}
                />
              </label>
            </Button>
            <Button
              size="sm"
              onClick={() => {
                navigate(href("new"));
              }}
            >
              New plugin
            </Button>
          </div>
        ) : undefined
      }
    >
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </p>
      )}
      {!loaded && <p role="status">Loading plugins…</p>}
      {loaded && !id && !items.length && (
        <p className="text-sm text-muted-foreground">
          Add skills, MCP tools, or both. You can also ask an agent to create a plugin.
        </p>
      )}
      {!id && (
        <ul className="m-0 flex list-none flex-col divide-y p-0" aria-label="Plugins">
          {items.map((p) => (
            <li key={p.id}>
              <a
                href={href(p.id)}
                className="flex min-w-0 flex-col gap-2 px-4 py-4 text-foreground no-underline hover:bg-muted"
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="flex gap-2">
                    <Badge variant="secondary">{kind(p)}</Badge>
                    {p.builtIn ? <Badge>Built-in</Badge> : !p.enabled && <Badge>Disabled</Badge>}
                  </span>
                </span>
                <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{p.description}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {plugin && (
        <>
          <p className="m-0 text-sm text-muted-foreground">{plugin.description}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{kind(plugin)}</Badge>
            <Badge>Revision {plugin.revision}</Badge>
            <Button asChild size="sm" variant="outline">
              <a href={`/api/plugins/${encodeURIComponent(plugin.id)}/export`} download>
                Export
              </a>
            </Button>
            {!plugin.builtIn && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit plugin
              </Button>
            )}
          </div>
          {!plugin.builtIn && (
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="plugin-enabled">Enabled</FieldLabel>
                <Switch
                  id="plugin-enabled"
                  checked={plugin.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => void act(() => api.installPlugin(plugin.id, { enabled }))}
                />
              </Field>
              <Field>
                <FieldLabel>Available to agents</FieldLabel>
                <div className="flex flex-wrap gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={plugin.agents === null}
                      disabled={busy}
                      onChange={(e) =>
                        void act(() => api.installPlugin(plugin.id, { agents: e.target.checked ? null : [] }))
                      }
                    />
                    All agents
                  </label>
                  {plugin.agents !== null &&
                    agents.map((a) => (
                      <label key={a.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={plugin.agents!.includes(a.id)}
                          disabled={busy}
                          onChange={(e) =>
                            void act(() =>
                              api.installPlugin(plugin.id, {
                                agents: e.target.checked
                                  ? [...plugin.agents!, a.id]
                                  : plugin.agents!.filter((id) => id !== a.id),
                              }),
                            )
                          }
                        />
                        {a.name}
                      </label>
                    ))}
                </div>
              </Field>
            </FieldGroup>
          )}
          {!!plugin.package.skills.length && (
            <section className="flex min-w-0 flex-col gap-4" aria-label="Skills">
              <h4 className="text-sm font-medium">Skills</h4>
              {plugin.package.skills.map((s) => (
                <div key={s.name} className="min-w-0 border-t pt-4">
                  <p className="text-sm font-medium">{s.name}</p>
                  <SkillMdView text={s.files.find((f) => f.path === "SKILL.md")?.content ?? ""} />
                  <p className="text-xs text-muted-foreground">{s.files.length} files</p>
                </div>
              ))}
            </section>
          )}
          {!!plugin.package.mcp.length && (
            <section className="flex min-w-0 flex-col gap-3" aria-label="Connections">
              <h4 className="text-sm font-medium">Connections</h4>
              {plugin.package.mcp.map((c) => {
                const installed = plugin.connections.find((x) => x.name === c.name);
                return (
                  <div key={c.name} className="flex min-w-0 flex-col gap-2 border-t py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{c.name}</span>
                      <Badge>
                        {installed?.status === "ready"
                          ? "Connected"
                          : installed?.status === "needs_auth"
                            ? "Needs sign-in"
                            : installed?.status === "error"
                              ? "Error"
                              : "Pending"}
                      </Badge>
                    </div>
                    <p className="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">{c.url}</p>
                    {!!c.skills.length && <p className="m-0 text-sm">Read first: {c.skills.join(", ")}</p>}
                    {installed?.error && <p className="m-0 text-sm text-destructive">{installed.error}</p>}
                    <div className="flex flex-wrap gap-2">
                      {installed?.connectorId && (
                        <Button variant="outline" size="sm" onClick={() => setConnection(installed.connectorId)}>
                          Connection settings
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void act(() => api.retryPlugin(plugin.id))}
                      >
                        Retry setup
                      </Button>
                    </div>
                  </div>
                );
              })}
            </section>
          )}
          {!!plugin.revisions.length && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="plugin-history">Revision history</FieldLabel>
                <NativeSelect
                  id="plugin-history"
                  value={history?.selectedRevision ?? ""}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (value) void act(async () => setHistory((await api.getPlugin(plugin.id, value)).plugin));
                    else setHistory(null);
                  }}
                >
                  <option value="">Choose a revision</option>
                  {plugin.revisions.map((r) => (
                    <option key={r.revision} value={r.revision}>
                      Revision {r.revision} · {r.author} · {new Date(r.createdAt).toLocaleString()}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {history && (
                <>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                    {JSON.stringify(history.package, null, 2)}
                  </pre>
                  {!plugin.builtIn && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.updatePlugin(plugin.id, {
                            package: history.package,
                            expectedRevision: plugin.revision,
                          });
                          setHistory(null);
                        })
                      }
                    >
                      Restore as new revision
                    </Button>
                  )}
                </>
              )}
            </FieldGroup>
          )}
          {!plugin.builtIn && (
            <Button variant="destructive" className="w-fit" disabled={busy} onClick={() => setRemoving(true)}>
              Remove plugin
            </Button>
          )}
          {removing && (
            <ConfirmDialog
              title={`Remove ${plugin.name}?`}
              description={<p>Remove its skills and connections. Triggers using its skills will need updating.</p>}
              confirmLabel="Remove plugin"
              onCancel={() => setRemoving(false)}
              onConfirm={() =>
                void act(async () => {
                  await api.deletePlugin(plugin.id);
                  setRemoving(false);
                  back();
                })
              }
              busy={busy}
            />
          )}
        </>
      )}
    </PageShell>
  );
}

function PluginEditor({
  initial,
  existing,
  busy,
  error,
  onSave,
  onCancel,
}: {
  initial: PluginPackage;
  existing: boolean;
  busy: boolean;
  error: string | null;
  onSave: (pkg: PluginPackage) => void;
  onCancel: () => void;
}) {
  const [pkg, setPkg] = useState(() => structuredClone(initial));
  const skill = (index: number, field: "name" | "content", value: string) =>
    setPkg((p) => ({
      ...p,
      skills: p.skills.map((s, i) =>
        i !== index
          ? s
          : field === "name"
            ? { ...s, name: value }
            : { ...s, files: s.files.map((f) => (f.path === "SKILL.md" ? { ...f, content: value } : f)) },
      ),
    }));
  const connection = (index: number, changes: Partial<PluginPackage["mcp"][number]>) =>
    setPkg((p) => ({ ...p, mcp: p.mcp.map((c, i) => (i === index ? { ...c, ...changes } : c)) }));
  return (
    <PageShell title={existing ? "Edit plugin" : "New plugin"} onBack={onCancel}>
      <form
        className="flex min-w-0 flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(pkg);
        }}
      >
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="plugin-name">Name</FieldLabel>
            <Input
              id="plugin-name"
              required
              disabled={existing || busy}
              placeholder="weekly-report"
              value={pkg.name}
              onChange={(e) => setPkg({ ...pkg, name: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="plugin-description">Description</FieldLabel>
            <Textarea
              id="plugin-description"
              required
              disabled={busy}
              value={pkg.description}
              onChange={(e) => setPkg({ ...pkg, description: e.target.value })}
            />
          </Field>
        </FieldGroup>
        <section className="flex min-w-0 flex-col gap-4" aria-label="Plugin skills">
          <h4 className="m-0 text-sm font-medium">Skills</h4>
          {pkg.skills.map((s, i) => (
            <FieldGroup key={s.name} className="border-t pt-4">
              <Field>
                <FieldLabel htmlFor={`skill-name-${i}`}>Skill name</FieldLabel>
                <Input
                  id={`skill-name-${i}`}
                  value={s.name}
                  required
                  onChange={(e) => skill(i, "name", e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`skill-content-${i}`}>SKILL.md</FieldLabel>
                <Textarea
                  id={`skill-content-${i}`}
                  value={s.files.find((f) => f.path === "SKILL.md")?.content ?? ""}
                  className="min-h-48"
                  required
                  onChange={(e) => skill(i, "content", e.target.value)}
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit"
                onClick={() =>
                  setPkg({
                    ...pkg,
                    skills: pkg.skills.filter((_, n) => n !== i),
                    mcp: pkg.mcp.map((c) => ({ ...c, skills: c.skills.filter((name) => name !== s.name) })),
                  })
                }
              >
                Remove skill
              </Button>
            </FieldGroup>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              const name = `skill-${pkg.skills.length + 1}`;
              setPkg({
                ...pkg,
                skills: [
                  ...pkg.skills,
                  {
                    name,
                    files: [
                      {
                        path: "SKILL.md",
                        encoding: "text",
                        content: `---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\nWrite the instructions here.\n`,
                      },
                    ],
                  },
                ],
              });
            }}
          >
            Add skill
          </Button>
        </section>
        <section className="flex min-w-0 flex-col gap-4" aria-label="Plugin connections">
          <h4 className="m-0 text-sm font-medium">MCP connections</h4>
          {pkg.mcp.map((c, i) => (
            <FieldGroup key={c.name} className="border-t pt-4">
              <Field>
                <FieldLabel htmlFor={`connection-name-${i}`}>Connection name</FieldLabel>
                <Input
                  id={`connection-name-${i}`}
                  value={c.name}
                  required
                  onChange={(e) => connection(i, { name: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`connection-url-${i}`}>Server URL</FieldLabel>
                <Input
                  id={`connection-url-${i}`}
                  value={c.url}
                  type="url"
                  required
                  placeholder="https://example.com/mcp"
                  onChange={(e) => connection(i, { url: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`connection-auth-${i}`}>Authentication</FieldLabel>
                <NativeSelect
                  id={`connection-auth-${i}`}
                  value={c.auth}
                  onChange={(e) => connection(i, { auth: e.target.value as typeof c.auth })}
                >
                  <option value="none">None</option>
                  <option value="oauth">Sign in with OAuth</option>
                  <option value="token">API token</option>
                </NativeSelect>
              </Field>
              {!!pkg.skills.length && (
                <Field>
                  <FieldLabel>Skills to read first</FieldLabel>
                  <div className="flex flex-wrap gap-3">
                    {pkg.skills.map((s) => (
                      <label key={s.name} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={c.skills.includes(s.name)}
                          onChange={(e) =>
                            connection(i, {
                              skills: e.target.checked ? [...c.skills, s.name] : c.skills.filter((n) => n !== s.name),
                            })
                          }
                        />
                        {s.name}
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit"
                onClick={() => setPkg({ ...pkg, mcp: pkg.mcp.filter((_, n) => n !== i) })}
              >
                Remove connection
              </Button>
            </FieldGroup>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() =>
              setPkg({
                ...pkg,
                mcp: [...pkg.mcp, { name: `connection-${pkg.mcp.length + 1}`, url: "", auth: "none", skills: [] }],
              })
            }
          >
            Add connection
          </Button>
        </section>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save plugin"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </PageShell>
  );
}
