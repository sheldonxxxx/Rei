# Chat permissions

Choose **Strict**, **Standard**, or **YOLO** from the composer. Set the starting level for an agent's new chats in **Settings → Permissions**. Standard is the default.

| Action | Strict | Standard | YOLO |
| --- | --- | --- | --- |
| Read Knowledge or Library, work in the sandbox, save a draft | Automatic | Automatic | Automatic |
| Search the web or fetch public pages, including after reading private data | Ask | Automatic | Automatic |
| Make reversible external edits through a built-in tool | Ask | Automatic | Automatic |
| Type into a website from a chat that has read private data | Ask | Ask | Automatic |
| Send or publish through a built-in tool that declares a send | Ask | Ask | Automatic |
| Edit memory | Ask after reading outside content | Automatic | Automatic |
| Create, edit, or delete a trigger | Ask once | Ask once | Automatic |
| Run a built-in action classified as irreversible | Ask once | Ask once | Automatic |
| Call a connector | Connector policy | Connector policy | Connector policy |
| Enter a password or verification code | User takeover | User takeover | User takeover |

In Standard, Rei can read a Knowledge brief and a Library file, look up public sources, and save a comparison without stopping for approval. Search queries and page URLs can include details from the chat or the documents it uses.

## Approval scope

A public research card offers **Just this once**, **This destination for this chat**, and **All web for this chat**. A destination grant covers one operation and site or the web search service. An all-web grant covers the dedicated search and fetch tools, including redirects to public sites. On Android, the broader options appear under **More options**. The grant applies only to that chat. Revoke it in **Settings → Permissions**. Fresh copies already stored in Rei are internal reads. [Web reading](web-reading.md) explains local-network access and redirects.

For browser typing, Rei uses the chat's private-data flag. Knowledge and Library reads and connectors that hold private data can set this flag. It describes what the chat has seen. A typing card offers **Just this once** or **This site for this chat** for the origin that owns the target field, including an embedded frame. Rei verifies the destination before typing. Mixed browser batches that include other actions use their own approval. Browsers can submit or publish through generic page interactions, so the table's send and irreversible rows apply to built-in effects Rei can identify.

Connector calls use **Always Ask**, **Read-only**, **Read and write** (reads and reversible writes run automatically; sends, deletes and tools marked destructive still ask), or the connector's explicitly confirmed **YOLO** setting. Sandbox commands use the agent's [network setting](sandbox-network.md).

## Existing and unattended chats

Worker chats use the same permission rules as their parent and start with the parent's selected level, including YOLO. Each worker has its own chat-scoped grants. Existing Relaxed chats and agent defaults are treated as Standard. Older clients can submit Relaxed as an alias for Standard in chat settings. Creating a trigger under chat YOLO applies the change immediately. Trigger runs use their own saved permission rules and levels, including Relaxed where applicable.

## Calls inside a script

With [Code mode](code-mode.md) on, the model can run a script that calls tools. Every call the script makes gets the decision the same call would get directly, from the table above and the chat's grants. The script itself (`codemode`) never asks.

A call that asks gets a card under the script's row that says "Asked by a script". Approving runs that call once and the script goes on; denying rejects the call in the script with the denial text. The script waits meanwhile, and the wait counts toward its 10-minute deadline. When the deadline passes or the run is stopped first, the card is withdrawn and says "The script that asked for this ended". Grants (just this once, this destination for this chat, all web for this chat) work as they do for a direct call. Calls the script already made are not repeated, also across a restart. Reading the web or a connector in a script taints the chat the same way a direct read does, and the script's output is fenced as outside content.

In a worker chat, the parent chat also shows pending approval cards. In a trigger session, a call that asks is blocked at once with its approval number, and the script fails instead of waiting. Tools only the model may call (surfaces, sessions, triggers, skills, plugins) are not available to scripts at all.
