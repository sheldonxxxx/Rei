# Rei レイ documentation

## Start here

- [Install Rei](installation.md): requirements, setup, upgrades, backup and restore.
- [Use Rei](user-guide.md): the main workflows.
- [Architecture](architecture.md): the services and how they fit together.

## Features

| Topic                          | Doc                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agents, home chats and workers | [agent-runtime.md](agent-runtime.md), [home-chat-context.md](home-chat-context.md)                                                                     |
| Conversations and transcripts  | [conversation-view.md](conversation-view.md), [session-history-pagination.md](session-history-pagination.md)                                           |
| Importing past conversations   | [importing.md](importing.md)                                                                                                                           |
| Tools, skills and connectors   | [capability-discovery.md](capability-discovery.md), [tool-activity.md](tool-activity.md), [code-mode.md](code-mode.md)                                 |
| Composer                       | [composer-context.md](composer-context.md), [context-usage.md](context-usage.md)                                                                       |
| Memory and history search      | [history-indexing.md](history-indexing.md), [memory-search-relevance.md](memory-search-relevance.md), [embedding-providers.md](embedding-providers.md) |
| Knowledge pages                | [knowledge.md](knowledge.md)                                                                                                                           |
| Files                          | [library.md](library.md), [file-previews.md](file-previews.md)                                                                                         |
| Web reading                    | [web-reading.md](web-reading.md), [search.md](search.md)                                                                                               |
| Triggers                       | [trigger-report-delivery.md](trigger-report-delivery.md)                                                                                               |
| Model sign-in                  | [oauth-attempts.md](oauth-attempts.md)                                                                                                                 |
| Rendering                      | [rendering.md](rendering.md), [motion.md](motion.md), [surfaces.md](surfaces.md)                                                                       |

## Internals

- [Storage and retrieval](storage.md)
- [Sandbox network](sandbox-network.md)
- [Service logs](logging.md)
- [Gateway callers](gateway-callers.md): letting another service use the gateway's models, search, embeddings and web reading
- [The shared web reader](reader.md): the service that fetches and extracts pages for every caller
- [Events](events.md): letting another service start triggers with a signed message
- [Client contract](contract.md)
- [Versioning](versioning.md)
- [Local code quality](code-quality.md)

## Decisions and evidence

- [`adr/`](adr/): architecture decision records.
