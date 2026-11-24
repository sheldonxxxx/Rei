# Importing past conversations

You can bring chats you had in another assistant into Rei レイ. Each one becomes an ordinary chat of the agent you pick: it keeps its title, its dates and its star, its questions and answers become searchable, and you can carry on talking in it. No model runs during an import.

ChatGPT data exports are supported today, through the CLI. The server side takes a neutral transcript, so another source needs only a new reader in the CLI.

## Import a ChatGPT export

1. In ChatGPT, ask for a data export (Settings → Data controls → Export data) and unzip the file you receive.
2. Run the import from the repository root, where the export is:

```sh
./rei import chatgpt ~/Downloads/chatgpt-export            # lists the agents, then stops
./rei import chatgpt ~/Downloads/chatgpt-export --agent <agent-id> --dry-run
./rei import chatgpt ~/Downloads/chatgpt-export --agent <agent-id>
```

| Option           | Meaning                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `--agent <id>`   | The agent the chats belong to. Without it the command lists the agents and stops.            |
| `--server <url>` | Where Rei answers. The default is this machine's Rei (`REI_PUBLISH`, else `127.0.0.1:8787`). |
| `--token <tok>`  | A device token to use, or set `REI_TOKEN`. Without one you are asked for your password.      |
| `--only <ids>`   | Only these chats: ChatGPT conversation ids, comma separated.                                 |
| `--limit <n>`    | At most this many chats.                                                                     |
| `--dry-run`      | Read and convert the export and print what would be imported. Nothing is sent.               |

Without a token the command signs in with your password (and authenticator code, when two-factor sign-in is on) as a new device named `rei import`, and signs that device out when it ends. A token you pass is left signed in.

The command reads one `conversations-NNN.json` file at a time and sends one chat at a time, printing a line for each. It ends with a summary: chats imported, already there, failed and empty, and the files it could not carry. It exits with `1` when a chat failed. Run it again to retry: chats imported before are skipped.

The CLI talks to Rei over HTTP, so the export can sit on a different machine from Rei. A reverse proxy in front of Rei must accept request bodies as large as the biggest chat (a few MB for a long one) and the biggest file (1 GiB), and give an upload long enough to arrive: see [installation.md](installation.md#with-your-own-reverse-proxy). The CLI streams each file from disk, so it does not hold a file in memory either.

## What comes along

| In the export                                    | In Rei                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Title, created and last-updated time             | The chat's title and dates. The chat sorts among your others by when it was last updated. |
| Starred chat                                     | Pinned chat                                                                               |
| Archived chat                                    | An ordinary chat (Rei has no archive)                                                     |
| Your messages and the replies                    | One run per question and its answer, searchable in history                                |
| Edited questions and regenerated answers         | Only the version the chat ended on                                                        |
| The model's thinking                             | Shown under the answer in detail mode only (see below)                                    |
| Voice messages                                   | Their transcripts                                                                         |
| Citations                                        | Their links, where the export has them; otherwise the citation marks are removed          |
| Files you attached                               | The files, when the export holds them; otherwise a placeholder card                       |
| Canvas, code runs, generated images, web results | Not in the export, so not shown. A notice at the top of the chat says so.                 |

Replies that ChatGPT split over several messages (thinking, then a tool call, then text) become one answer. A chat with no messages is skipped.

## How an imported chat behaves

- **A notice opens the chat.** It says the chat was imported and what was left out.
- **Runs.** Each question and the answer to it is one completed run in the ledger, so the run list and history paging work as in any chat. A question with no answer gets an empty run; a reply before any question opens the chat with a short notice of its own.
- **Thinking is display-only.** It is stored beside the answer, not in it. The model never sees it when you continue the chat, history search does not index it, and the web shows it only in detail mode, folded under the answer.
- **History search, not memory.** Questions and answers are indexed for history search at once. Imported runs are not memory-reviewed, get no generated title and send no notifications. Runs you add after the import are reviewed like any other.
- **Continuing.** Send a message and the agent answers with the imported questions and answers as its earlier context. A long chat may be compacted on the first new run, as any long chat would be.
- **Files.** An uploaded file is attached to the question it came with and can be opened and downloaded. It is not added to the Library. A file that the export lacks, that is over 1 GiB, or whose upload failed shows as a dashed card with its name, type and why it is missing. The model sees a line naming each attached file.

## Doing it again

Every import is recorded by its source and source id (`session_imports`). Importing the same chat again returns the chat already there instead of a copy. Delete an imported chat and the record goes with it, so the next import brings the chat back.

If Rei stops halfway through writing a chat, the half-written chat stays in the list. The next import of that chat deletes it and writes the chat again. You can also delete it yourself.

## The API

The CLI uses three endpoints. They need a signed-in device (`Authorization: Bearer <token>` with `x-rei-client: cli/1`, or the web cookie) and are in the [client contract](contract.md).

| Endpoint                     | Does                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /api/imports/files`    | Uploads one file (multipart, field `file`) for a later import. Answers its attachment id.            |
| `POST /api/imports/lookup`   | Given `source` and up to 1,000 `sourceIds`, answers which are already imported, with their sessions. |
| `POST /api/imports/sessions` | Imports one transcript into an agent. Answers the session and whether it was created.                |

A transcript is `{ source, sourceId, title, createdAt, updatedAt, starred?, notice?, turns }`, with times in Unix milliseconds. Each turn is `{ role: "user" | "assistant", at, text, model?, thinking?, attachments? }`. An attachment is `{ name, mediaType, size }` plus either the `attachmentId` from an upload or `unavailable` with the reason to show. `source` is a short lowercase name such as `chatgpt`.

Limits: 20,000 turns per chat, 1,000,000 characters per turn, 1,000 thinking blocks and 100 attachments per turn, 1 GiB per file. An uploaded file must be used by exactly one import; one left unused is swept after a day.

Errors: `400 unknown_agent`, `400 attachment_unavailable` (an attachment id that is not a fresh import upload), and `409 import_in_progress` when the same chat is being imported at that moment.
