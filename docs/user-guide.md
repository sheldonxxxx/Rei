# Use Rei レイ

## Start a conversation

Open Rei and select an agent in the sidebar. Its home chat is the place to give ongoing work and coordinate workers. Use **New chat** for a separate conversation. To remove an agent, open the home chat's options menu and choose **Delete agent**; this deletes the agent with its chats, triggers, permissions and memory. The default agent can't be deleted, so the item is not shown for it. Messages can include text, files, and references to other chats or connectors through the composer's attachment/context menu.

To start over in any agent's Home chat, including the default agent's, choose **Chat options → Clear Home chat** and confirm. Rei permanently deletes the old chat's messages and opens a fresh Home chat for the same agent. Saved memories are kept. You can choose whether to delete chats branched from the old Home chat.

Type `/` at the start of the composer to see Rei's commands and the skills your agent can use, or type `@` anywhere to mention a connector, chat or page. Keep typing to narrow the list, then press **Tab** to complete the highlighted name (`/rev` + Tab picks `review`). Pick a skill to attach it to your next message as a chip (up to five; remove one with its ×), then write your message and send. The skill applies to that message only. `/compact` summarizes older messages to free up context; add guidance after it (for example `/compact keep the decisions`) to say what the summary must keep. It only runs when the chat is idle, and while it runs you can't send, but your draft stays. Rei says so if there was nothing to compact.

You can send while a reply is still running. By default your message **steers** that reply: it joins it after the current step (a tool call, say), so the agent can change course, and the answer then shows under your message. Until it joins, the message is marked **Steering**. Turn this off in **Settings → Runtime → Runs → Messages during a reply** to have such messages wait and get their own reply instead (marked **Queued**). **Alt+Enter** does the other of the two for one message. Stop cancels messages that are still waiting, either kind. Messages from workers, triggers and other agents always wait.

If you need to change a message, use **Edit** or **Retry**. Rei opens the revised conversation as a branch so you can return to the original. You can also branch from an assistant reply.

To bring in chats you had in ChatGPT, run `./rei import chatgpt <export-folder> --agent <agent-id>` with an unzipped ChatGPT data export. Each chat arrives with its title, dates and star, and you can carry on in it. See [Importing past conversations](importing.md).

## Choose how much to see

In **Chat options** or **Settings → General**, turn **Show details** on for Detail mode or off for Simple mode. Simple mode keeps the conversation compact. Detail mode exposes the steps behind replies, including model calls, tool arguments and results, permissions, and timing. Open **Inspect** to investigate how an answer was produced.

The composer's context indicator shows the latest model call's reported usage and capacity when available. It is a snapshot of that call; an unsent draft is not included. **Settings → Usage** shows recorded model usage by period, purpose, model, and agent.

The first time you open Rei, your browser's time zone is saved as yours. The assistant is told today's date and your time zone, so "today" and clock times follow you. To change it, use **Settings → General → Time zone**.

## Configure model providers

Open **Settings → Providers** to connect OpenAI with a ChatGPT sign-in or API key, or a custom OpenAI-compatible Chat Completions endpoint. A custom endpoint needs its base URL and at least one model ID; its API key is optional. Rei accepts HTTPS endpoints and limits plain HTTP to localhost. Provider credentials stay in the gateway and are never shown again in the web app. You can edit a connection to change its name, endpoint, model IDs, or key; leave the key field blank to keep the saved key.

For ChatGPT sign-in, choose **Continue with ChatGPT** and complete the OpenAI flow. If the browser cannot reach Rei's local callback, copy the full redirect URL shown after sign-in and paste it into the **Redirect URL** field, then choose **Finish sign-in**. Rei verifies the callback and exchanges the authorization code on the gateway.

Use **Settings → Models** to set the default model for agent chats, the fast model used for background tasks, and the maximum timeouts for chat model calls. An agent's own model selection overrides the default chat model. Change an agent or default model that uses a connection before removing it; Rei prevents removal while a model setting still refers to that connection.

## Create and configure agents

Use **New agent** in the sidebar. Give the agent a name and instructions describing its work, then choose its model, thinking effort, and permissions. An agent can use the server's default model or an explicit model available to your account.

Each agent has a shared workspace. Its chats and workers can use the same files. Deleting a chat preserves that workspace; deleting the agent removes its workspace. Save deliverables in the Library when you want them to remain available independently of an agent.

Only the home chat coordinates workers. Worker reports return there, so you can inspect progress and continue the conversation.

## Work with files

Attach files from your device or choose **Library** in the composer's context menu. Uploads are saved in the Library, including successful uploads from drafts you do not send. A message can include up to 10 files, at most 1 GiB each and 2 GiB in total. Previews are limited to 100 MiB; larger files can still be downloaded.

Open **Library** to search files, organize folders, mark favorites, inspect versions, or open a file to download the original, see its info and history, or move it to Trash. Messages reference an exact version, so a later revision does not silently change the file used in an earlier conversation.

Ask Rei to save finished work to the Library. Published results appear as file cards in the reply. Temporary workspace files and tool output become saved deliverables only when published.

Document previews depend on the format. If a direct Office preview fails, **Compatibility preview** can create a temporary PDF using a chat with an execution sandbox. Download the original when you need the source document.

## Review permissions and browser requests

Choose **Strict**, **Standard**, or **YOLO** in the composer. Standard handles Knowledge and Library reads, public web research, reversible edits, and memory updates automatically. Triggers use the same levels: choose one under **Permissions for its runs** in a trigger's settings. See [Chat permissions](chat-permissions.md) for the full table and grant scopes.

Rei shows an approval request when a tool action needs your decision. Read the proposed action, destination, and permission duration before approving it. Reject it if the request does not match the work you intended.

When an agent requests several connector reads in one step, Rei can show them on one card. Open **Arguments** to review each request. Use **Allow all once** or choose **Allow once** or **Deny** for each request and select **Apply decisions**. The original run continues with the results of the allowed reads. The card shows both your decision and each call's outcome.

Configure connectors in **Settings → Capabilities → Connectors**. Add one from the list of known apps or by its address; a connector you add there stands on its own, without a plugin. Each row says who owns the connector ("Standalone" or its plugin) and which agents may use it; choose an agent's usable connectors in that agent's settings. New connectors start with **Always Ask**. Choose **Read-only**, **Read and write** or **YOLO** only when that level of access suits the connector and your work. A changed connector or tool definition can require a fresh approval.

For an MCP server that takes an API token, set **Token header name** under **Use a token instead** if it expects a custom header such as `X-Api-Key`. Leave the header name blank for bearer authentication. You can change the header on a saved connector without re-entering its token.

Rei checks connectors in **Error** every 15 seconds and returns them to **Connected** once it can list their tools. If an agent calls a previously discovered tool during an outage, Rei tries to reconnect immediately. A recovered call still uses the current tool definition and the connector's approval settings. A connector that requires sign-in needs your attention in Settings.

When Rei requests a browser takeover, open it, complete the requested interaction, and return control so the agent can continue. Detail mode lets you inspect the surrounding steps.

Ask Rei to upload a Library file or a file it generated in its sandbox. Each upload selects one file up to 25 MiB. In YOLO, Rei selects the file without asking. In other profiles, review the filename, size, source, and destination on the one-time approval. The site may start uploading as soon as Rei selects the file.

Rei can select a file through an HTML file input, a button that opens a file chooser, or a site's native Open File picker. A native picker gives the site a handle to a temporary copy in its browser storage. Edits the site makes to that copy do not change the Library version or sandbox file.

In Detail mode, `browser_wait` shows what the agent waited for and what changed, even after a timeout. `browser_scroll` can load more of a feed, and `browser_hover` can reveal a menu or tooltip. `browser_check` sets a checkbox or switch to the requested state. For radio buttons, the agent can choose another option in the group. `browser_type` can type character by character to trigger autocomplete.

A ref such as `p3e12` belongs to a particular page or iframe document. After that document changes, Rei asks for a fresh snapshot before using its controls. When a banner covers a control, the error identifies the covering element so the agent can look for its dismiss button.

Each agent has a **Sandbox network** setting. **Block** disables network access from sandbox commands. **Whitelist** allows only listed destinations. To reach a local-network hostname, add both the name and its IP address or network. **Any** allows public and local-network destinations without approval. Edit the whitelist in **Settings → Permissions → Sandbox network**. The package registries and GitHub are on it by default. See [sandbox network](sandbox-network.md) for details.

## Manage memory and skills

Open **Settings → Memory** to see saved facts and instructions. Add or edit a line, review suggested changes, or undo an edit. To remove something from memory, delete its line. To remove a conversation from searchable history, delete the chat: deleting a chat is the only way to erase what was said in it.

**Background memory review** is off by default. Set one global cadence under Memory settings (default 5, range 2–100); each chat counts its own completed replies. Rei privately forks the conversation at the review boundary and uses that reply's model to interpret your new messages. It can save durable information, update or remove unprotected memory, or finish with **No changes**. Earlier context helps interpretation; only new direct user messages support new memory. Counting starts when enabled, with no historical backfill or inactivity trigger. Reviews add model-token cost. Agents' normal memory tools work independently of this setting.

Open **Background Activity**, or **Memory → View review history**, for status, source links, attempts, model usage and memory diffs. Applied changes create one **Memory updated** chip at the source reply; open it for details and Undo. Failed windows remain visible and can be retried. Each automatic chat title is a **Chat title** task there too: if a title was not created, open the task to see why (for example the model call failed) and press Retry. Private review context is cleaned after each attempt. Deleting the source chat cancels work and removes its sensitive activity details.

Memory is distinct from the current conversation. An agent's saved notes help future work, while conversation recall retrieves earlier messages when useful. The embedding provider in **Settings → Providers → Embeddings** chooses how Rei retrieves past conversations; **Settings → Memory** manages saved facts and instructions.

Skills are the reusable instructions and supporting files an assistant reads before it works. Open **Settings → Capabilities → Skills** to create a skill (a name, a description and its instructions), import one, or edit one. A skill you make there, or one an agent saves for you, stands on its own. You can choose which agents may use a skill. The included browser skill is read-only and maintained with Rei.

Plugins are optional packages of skills and connectors that are shared or installed together: open **Settings → Capabilities → Plugins** to import, create or edit one, turn it off, or choose its agents. A plugin's skills are named `plugin/skill`. Turning a plugin off or removing it affects only what it brought; your standalone skills and connectors stay. You can also ask an agent to create a plugin.

## Schedule work and notifications

Use **Settings → Triggers** to configure recurring or one-time work, its agent, timing, reporting, and chat-list visibility. Triggers default to **Never** reporting to the home chat and **Show in chat list** for user-facing outputs like a daily report; triggers set to report to the home chat (**Every run** or **Only when something changed**) default to **Hide in chat list** so you can follow updates in the home chat (and reveal hidden runs with the sidebar filter when needed). Check the next run and time zone, then pause or edit the trigger when your needs change. Reports arrive in chat and can be inspected like other agent work.

To have one agent manage another's work, enable **Manage triggers for other agents** in the agent settings of the managing agent. Then ask it to create a trigger and name the agent that should run it, or to change, pause, resume or delete one that another agent already has. The chat's permissions govern approval, and the approval card shows which agent runs the trigger. Creating, changing and deleting ask for approval except in YOLO; pausing and resuming do not ask, including from a trigger's own run. A trigger belongs to the agent that runs it, uses that agent's model and skills, and stays with it when another agent changes it. Turning off the switch stops further changes to other agents' triggers, including calls still waiting for approval; triggers already made or changed stay as they are.

A trigger can also start when another service on your network says something happened, instead of on a schedule. Make a source with `./rei sources add <id>`, give its secret to the sender, then ask an agent to start a trigger on events from it, or choose **When an event arrives** in the trigger's settings. Events that arrive while a run is going gather into one waiting run. The Triggers page lists the sources and shows the events each run was started for. [Events](events.md) has the sender's contract.

In **Settings → Notifications**, use the notification controls to enable notifications on that device, choose which categories that device receives (approvals, browser help, replies — including scheduled tasks set to **Never** report to the home chat — scheduled task results, scheduled task problems, and backup problems), and choose whether previews show what happened. On devices that require it, add Rei to the Home Screen before enabling browser notifications. Delivery depends on browser permissions and your device's notification settings.

For installation checks and service problems, see [the installation guide](installation.md#troubleshooting).

## Optional passkeys

Under **Settings → General → Passkeys**, choose **Add a passkey**, enter your current password, optionally name the passkey, and approve the prompt from your browser: the device's screen lock, a phone, or a security key. The sign-in page then offers **Sign in with a passkey**. A passkey replaces both the password and the authenticator code, because it already checks that it is you. Your password still works.

A passkey belongs to the address you opened Rei at (for example `localhost` or your `REI_PUBLIC_URL` host). If that address changes, sign in with your password and add the passkey again. Remove a passkey with the trash button next to it.

## Optional two-factor authentication

Under **Settings → General**, choose **Set up authenticator**. Enter your current password, scan the QR code or enter the key in an authenticator app, then confirm a six-digit code. Rei requires authenticator codes only after confirmation. You can cancel setup without changing sign-in.

To turn it off, choose **Disable two-factor authentication** and enter your current password and a fresh authenticator code. Your next sign-in will use only your password.
