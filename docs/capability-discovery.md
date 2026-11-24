# Capability discovery

A chat starts with its **core tools**. Everything else it can use (the browser, plugins and triggers tool groups, and every tool of the user's connectors) is **deferred**: registered with Pi, but offered to the model only after `search_capabilities` loads it. ADR 0005 covers plugins being optional.

## What the model sees

- **The Capabilities index** is one prompt section. It lists the deferred groups, the connectors this agent may use (with their state when one needs sign-in or is failing), and up to 30 of the agent's skills, most used first. The same capabilities always render the same text, so the prompt cache holds between changes. Its worst case is held under 1,200 tokens by `test/capabilities-index.test.ts`.
- **`search_capabilities`** takes a short description of the task (`query`), exact names (`load`), or both:
  - A matching built-in tool loads its whole group.
  - Connector tools load one by one: at most five per search, with the rest listed as "also relevant".
  - A query that only names a connector ("GitHub") returns that connector's directory, one line per tool, and loads nothing.
  - A name in `load` that is not a tool or group is explained, not just reported as not found. A connector's name ("DeepWiki") returns its directory. A tool's own MCP name (`search_notes`) gives its full name. A connector tool that is no longer available says why: its connector was removed, needs sign-in, is not working, no longer lists the tool, or is not allowed for this agent. This works for names the server listed since it started.
  - Matching skills are suggested for `use_skill`.
- **Connector tools** are named `<connector>__<tool>`. Each one is a Pi tool with its own schema and policy. Loading a tool grants nothing: every call still goes through approvals, the binding check and the gateway.
- **An @-mentioned connector** adds its directory to the message (see `composer-context.md`). Nothing is loaded.
- Loaded tools stay offered for the rest of the branch, including after compaction and in forks.

## Standalone skills and connectors

Plugins are optional packages (ADR 0005). A skill or connector added on its own (`POST /api/skills`, `save_skill`, `POST /api/connectors`, the connector marketplace) is **standalone**: no plugin owns it and none is made for it.

- `GET /api/skills` and `GET /api/connectors` return each item's `plugin`: its owner `{ id, name, enabled }`, or `null` when it is standalone. Built-in skills have none.
- A standalone skill has its bare name (`research`); a plugin's skill is `plugin/skill` (`notes/research`). The exact name always wins. A bare name reaches a plugin skill only when nothing has that exact name and one visible plugin skill has it. `save_skill` uses exact names only, so a bare name saves a standalone skill.
- Removing or disabling a plugin touches only what it owns. A standalone connector is never removed with a plugin.
- A standalone skill is shown to the agents on its own agents list; a standalone connector follows each agent's connector setting.

## Choosing a skill for one message

Besides the model finding skills with `use_skill`, the user can choose skills for their next message with `/` in the composer. The server resolves each chip to an exact skill id and version, checks that the session's agent can use it now (including its plugin), and puts its instructions in that message's model input; see `composer-context.md`. This grants no tool or approval, and an admitted message keeps the version it was sent with even if the skill is edited, disabled or removed afterwards. `read_skill_file` accepts `id` and `version` to read that pinned version's files.

## Changes in an open conversation

Adding, removing, refreshing or signing in to a connector, enabling or disabling a plugin, and changing an agent's connector access all re-register that tree's connector tools in place. The change lands between model requests and the tree does not reopen:

- A removed tool stops being offered, and a call to it settles as "not available".
- A changed tool stays loaded under its new definition. A call bound to the old definition is refused before it runs.
- A tool that comes back is offered again without a new search.
- An approval left pending on a removed or changed tool settles without running, with the reason in the tool result.

## In the Trace (detail mode)

- **A `search_capabilities` step** has a Discovery panel. It shows the query, the ranked candidates with the share of query terms each matched and its score, and what was loaded and why (its group matched, it ranked for the query, or it was named in `load`). It also lists the "also relevant" tools, any directory returned, and the suggested skills.
- **A model call** shows the tools it was offered, recorded per call from Pi's context so every provider reads the same. It also shows the change since the chat's previous model call. Each newly offered tool links to the search step that loaded it. An addition with no search behind it came from a capability change.
- **A `capabilities.changed` step** appears on a run that was going when connector tools changed. It lists the connectors and the tools added, removed or changed for that chat's agent. A chat with no run going sees the change in its next model call's tools.
- **Simple mode** keeps the one-line activity label.
- **The context-usage breakdown** separates the Capabilities index, core tool definitions and loaded tool definitions (`context-usage.md`).
