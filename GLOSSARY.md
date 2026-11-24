# Rei レイ

Rei is an inspectable AI agent platform with searchable conversation history and editable memory.

**Dodai · 土台** (`dodai`):
The shared service layer: the gateway, the web reader, and storage (Garage and Qdrant). Deployed independently from Rei through `containers/compose.dodai.yaml`.

## Language

**Session**:
Rei's record of one chat: its title, agent, role and permissions. Every session has exactly one conversation behind it.
_Avoid_: Chat (UI word only), thread

**Conversation**:
The durable transcript and live state behind one session, owned by the agent runtime rather than by Rei.
_Avoid_: Messages, chat history

**Tree**:
A session together with the sessions forked from it, which share one durable store.
_Avoid_: Fork family, branch

**Transcript**:
The ordered entries of a conversation: user input, model answers, tool results, reports, compactions and resets. It is the only canonical record of what was said.
_Avoid_: Message list, history (when the canonical record is meant)

**Caller**:
A named client of the gateway: an id, the scopes it may use, a budget and a token. Rei is the caller `rei`; any other service that uses the gateway is an outside caller.
_Avoid_: Client, tenant, consumer, API user

**Caller token**:
The secret a caller presents to the gateway. Rei's is set in the environment; an outside caller's is made by the gateway and shown once.
_Avoid_: Stand-in token (Rei's only, and only historically), API key (that is a provider's)

**Budget**:
The number of calls a caller may have in flight at once: one cap per model provider, one for search and one for embeddings. A cap of 0 turns that off for the caller.
_Avoid_: Quota, rate limit (an upstream's), usage limit (a subscription's)

**Run**:
One answer cycle of a conversation, started by a submission and ending in an answer or a run failure.
_Avoid_: Turn, job

**Run failure**:
The recorded reason a run ended without an answer, such as an interruption, a turn limit or nothing to answer.
_Avoid_: Parked run, stuck run

**Imported chat**:
A session made from a conversation held in another assistant, with origin `import`. Its runs are written already completed: no model ran, and they get no memory review, generated title or notification. The source and source id it came from make importing it again a no-op.
_Avoid_: Migrated chat, archive

**Overlay**:
Rei-owned live state shown against a transcript item, such as an approval or browser takeover for a tool call, or a memory chip on a tool result. It changes in place and is never model-visible.
_Avoid_: Card message, special message

**History indexing**:
The process that keeps searchable representations of conversation history consistent with the transcripts Rei currently holds, including recovery, rebuilding, and removal of deleted sessions.
_Avoid_: Memory profile editing

**Memory review**:
A private check of newly completed conversation for durable, useful information to keep in shared User Memory or the agent's own Agent Memory. Finding nothing worth keeping is a successful review.
_Avoid_: Extraction (when it implies every review must save something), session memory

**Review window**:
A fixed group of newly eligible completed runs from one session considered by one memory review. Earlier conversation provides context, while the window identifies the new user evidence being reviewed.
_Avoid_: Batch (when the source boundary matters), agent-wide collection

**Knowledge**:
The shared, long-term pages that the user and every agent browse, read and write: the durable layer above conversation history, where lasting learnings, research, plans and decisions are kept. Agents consult it when they need it; unlike Memory, it does not ride along in every chat.
_Avoid_: Notes, wiki, knowledge base

**Page**:
One item in Knowledge: a title, an optional description, a Markdown body, and any number of child pages. A page with children and no body acts as a folder; there is no separate folder type.
_Avoid_: Note (that word belongs to an agent's private Memory notes), document, folder

**Page description**:
A one-line summary of a page, written by whoever created or curated it, that lets an agent pick a branch of Knowledge without opening the page.
_Avoid_: Summary, abstract

**Page tag**:
A freely assigned, shared label that groups pages across Knowledge. Tags are flat: a slash in a tag does not create a hierarchy.
_Avoid_: Category, folder

**Inbox**:
A top-level page that the user or an agent can deliberately choose as the place for something not yet filed. Nothing is ever placed there automatically.
_Avoid_: Default folder, unsorted

**OAuth attempt**:
One ChatGPT sign-in in progress, from starting authorization through completion, explicit cancellation, or expiry. Leaving and reopening Rei’s provider settings can resume the same attempt.
_Avoid_: Provider connection (the saved result of a successful attempt)

**Compaction**:
The replacement of older transcript entries, in what the model is shown, by a summary so a conversation fits its context. It leaves a compaction entry in the transcript and deletes nothing. It starts automatically or by manual compaction.
_Avoid_: Truncation, trimming, clearing

**Manual compaction**:
A compaction the user asks for with the `/compact` slash command, optionally with guidance on what the summary must keep. It is not a message and starts no run. Asking for it is not the same as it having happened: it is finished only once a compaction entry is placed in the transcript, and it can also end with nothing to compact, superseded, or failed.
_Avoid_: Summarize, compact message

**Slash command**:
A built-in Rei action typed at the start of the composer after `/`, which runs instead of sending a message. In v1 the only one is `/compact`. A skill is never a slash command.
_Avoid_: Command (alone), action, shortcut

**Trace**:
The user-facing record of what an agent did in a run — its steps, model calls and tool calls — shown in detail mode and removed only with its session.
_Avoid_: Log, debug log

**Service log**:
The operational record a Rei service writes for whoever runs it. It carries ids, counts and codes only, never conversation content, and is never shown in the app.
_Avoid_: Trace, audit log

### Motion

**Motion**:
How things become present in the interface. It exists to make the order of a run legible — a step before its result, an answer before its activity fold — not to decorate the surface.
_Avoid_: Animation, effects, transitions (when the whole system is meant)

**Arrival**:
The moment an item becomes visible in the interface. What was already on screen when a region first painted has arrived; it does not arrive again.
_Avoid_: Appear, fade in, load

**Stagger**:
The ordering of sibling arrivals so a run of items reads in sequence rather than all at once. It is always bounded: past a few items the rest arrive together.
_Avoid_: Delay, cascade

**Motion budget**:
The caps every arrival obeys: how long it may take, how far it may travel, and how much ordering may accumulate before the rest arrives at once. Leaving is always faster than arriving.
_Avoid_: Animation speed, duration

### Surfaces

**Surface**:
A live piece of interface an agent places in one session, built from components, that can change in place and keeps every revision. It always carries plain text that says everything it shows, for clients that cannot draw it. A fork receives a frozen copy as it stood at the fork point; only the original changes.
_Avoid_: Widget, generative UI, card (card is a component), rich message

**Component**:
One kind of building block in the catalog, such as a chart, a form or a timeline. A component exists only inside a surface; it is never a message on its own.
_Avoid_: Block, element, ui block

**Catalog**:
The set of components every client agrees to draw, each with its own rules and limits. An agent can only build a surface from what the catalog holds.
_Avoid_: Component library, registry, design system

**Revision**:
One numbered change to a surface, recording who made it — the agent, or a named feed — and what changed. A surface's revisions are its history; only the latest one accepts actions.
_Avoid_: Version, update, patch

**Feed**:
A Rei-owned source bound to a surface that writes the surface's data while it runs, such as a worker session reporting its progress. A feed never changes what the surface is made of, only the data it shows.
_Avoid_: Producer, stream, subscription

**Surface state**:
Where a surface stands: live while a feed is attached, idle when none is, removed once the agent takes it away, and frozen when it is a fork's copy. Only live and idle surfaces accept actions.
_Avoid_: Status (alone), lifecycle

### Capabilities

**Capability**:
Something an agent can discover and use: a tool or a skill. Plugins and connectors hold or provide capabilities but are not capabilities themselves.
_Avoid_: Ability, feature, integration

**Tool**:
An operation an agent can call with structured input. Every call is decided by Rei's policy, however the tool was found.
_Avoid_: Function, action

**Built-in tool**:
A tool Rei itself provides.
_Avoid_: Native tool, first-party tool

**Connector tool**:
A tool a connector provides live.
_Avoid_: MCP tool (in product language), plugin tool

**Core tool**:
A tool the model is always offered.
_Avoid_: Listed tool, default tool

**Deferred tool**:
A tool the model is not offered until it is found through search.
_Avoid_: Hidden tool, lazy tool

**Tool group**:
A set of related built-in tools, such as the browser tools or the memory tools, that are always core or deferred together.
_Avoid_: Toolset, tool category

**Loaded tool**:
A deferred tool the model is now offered in one conversation, because a search found it or named it. It stays loaded on that branch of the conversation while its source still exists.
_Avoid_: Activated tool, enabled tool

**Code mode**:
A behaviour setting, off by default, that offers the model `codemode` as one more core tool. With it on, the model can write a script that calls its tools in a sandbox instead of calling them one model turn at a time. It adds an option and removes no direct tool.
_Avoid_: Programmatic tool calling, scripting mode

**Script**:
The short JavaScript program the model passes to `codemode`. It runs in a sandbox that can call only tools, ends with its printed output going back to the model, and resumes after a restart without repeating finished calls. It has one Trace step and one chat row.
_Avoid_: Code (alone), macro, workflow

**Nested call**:
A tool call a script makes with `tools.<name>(args)`. It gets the policy decision, approval, taint and Trace step of a direct call and is linked to its script's step. A nested call that needs approval parks while its script waits.
_Avoid_: Sub-call, inner call, script call

**Skill**:
Instructions, workflow guidance and supporting files for one kind of task. Reading a skill grants no permission.
_Avoid_: Prompt, recipe, playbook

**Selected skill**:
A skill the user chose from the `/` list for their next message only, alongside any others chosen for the same message: each is shown as a removable chip, sent with that message, and fixed to the skill's version as of the draft's latest refresh. It adds the skill's instructions to that message's run and grants no permission.
_Avoid_: Slash skill, invoked skill, skill command

**Connector**:
A configured live integration, with its sign-in, that provides connector tools.
_Avoid_: Connection, MCP server, integration

**Plugin**:
A named, versioned package of skills and connector declarations that are installed, updated, enabled and removed together. A skill or connector does not have to belong to one; one that doesn't is standalone.
_Avoid_: Extension, app, bundle

### Companion and devices

**Home chat**:
The one pinned session every agent has, where the user hands it ongoing work and where its worker and trigger reports come back.
_Avoid_: Dot (UI word only), main chat, inbox chat

**Companion agent**:
The single agent whose home chat the always-available surfaces — widgets, quick send, share-in and notifications that open a chat — talk to. It is the default agent unless the user picks another.
_Avoid_: Assistant (that is the default agent's seeded name), primary agent

**Client**:
A kind of Rei app the user signs in with, such as the web app or a native phone or desktop app. Every client speaks the same published contract.
_Avoid_: Frontend, platform, surface

**Device**:
One signed-in installation of a client, with its own label, credential and last-seen time, that the user can rename or revoke. Two browsers on one computer are two devices.
_Avoid_: Auth session, login, push subscription

**Delivery channel**:
A route by which a notification leaves Rei for the user, such as Web Push or a native push service.
_Avoid_: Notifier, transport, push provider

### Outside events

**Event source**:
A named sender of events: an id, a display name, a secret and a status. Rei does not know or care what a sender is; it only checks that a request is signed with the source's secret.
_Avoid_: Webhook, integration, client

**Event**:
One signed message from an event source saying that something happened: a type and a reference, never free text. The agent looks the reference up through a connector it already has.
_Avoid_: Notification, payload, webhook call

**Event trigger**:
A trigger that starts when events of chosen types arrive from one event source, instead of on a schedule. Events that arrive while its run is going gather into one waiting run.
_Avoid_: Webhook trigger, listener
