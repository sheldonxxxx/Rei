# Chat permissions

Choose **Strict**, **Standard**, or **YOLO** from the composer. Set the starting level for an agent's new chats in **Settings → Permissions**. Standard is the default.

The same three levels and the same table apply to every kind of session: a chat, a worker and a trigger's run. The same level with the same chat state always gets the same decision.

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

## Workers and triggers

Worker chats start with their parent's level, including YOLO, and cannot choose another. Each worker has its own chat-scoped grants.

A trigger's runs use the level saved with the trigger (**Permissions for its runs** on the Triggers page), and the table above decides each call. A Standard trigger that read private data can still search and fetch public pages without asking, as a Standard chat can. A new trigger starts on its agent's default level, including YOLO. Creating or changing a trigger asks once in Strict and Standard, so an agent cannot put a trigger on YOLO, or raise one to YOLO, without your approval. The card shows the level the runs will have and, for a change, the level before. Under chat YOLO the change applies at once.

Two things stay specific to triggers:

- **For this trigger.** When a run asks, the card can also offer **For this trigger**. Approving it adds the call to the trigger's allow list, so later runs make it without asking. An allow entry never covers trigger changes, irreversible actions or sign-ins. After the run has read outside content and private data, a send matches only an entry that names its destination. Remove entries on the Triggers page.
- **Nobody is watching.** A direct call that asks leaves the run waiting with its card until you answer. A call made by a script fails at once instead (see below).

## Older levels

Earlier versions had a fourth level, **Relaxed**. Chats, agent defaults and triggers saved as Relaxed now run as Standard, and a client or tool that still sends Relaxed gets Standard. Trigger runs used to follow stricter rules than chats at the same level. A Standard trigger now makes reversible external edits, edits memory after reading outside content, and researches the public web after reading private data without asking. A trigger that was Relaxed now asks for every send after reading outside content and private data. Check the levels on the Triggers page after upgrading.

## Calls inside a script

With [Code mode](code-mode.md) on, the model can run a script that calls tools. Every call the script makes gets the decision the same call would get directly, from the table above and the chat's grants. The script itself (`codemode`) never asks.

A call that asks gets a card under the script's row that says "Asked by a script". Approving runs that call once and the script goes on; denying rejects the call in the script with the denial text. The script waits meanwhile, and the wait counts toward its 10-minute deadline. When the deadline passes or the run is stopped first, the card is withdrawn and says "The script that asked for this ended". Grants (just this once, this destination for this chat, all web for this chat) work as they do for a direct call. Calls the script already made are not repeated, also across a restart. Reading the web or a connector in a script taints the chat the same way a direct read does, and the script's output is fenced as outside content.

In a worker chat, the parent chat also shows pending approval cards. In a trigger session, a call that asks is blocked at once with its approval number, and the script fails instead of waiting. Tools only the model may call (surfaces, sessions, triggers, skills, plugins) are not available to scripts at all.
