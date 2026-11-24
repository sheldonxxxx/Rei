# Storage and retrieval

Rei keeps three kinds of persistent data, and they are deliberately stored in three different places.

| Data                                                                                                  | Where                                                       | Why there                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Accounts, chats, sessions, Library records, the memory profile, the object ledger, the indexing queue | SQLite (`control-data:/data/app.sqlite`)                    | One authoritative store, transactional, and the only thing that decides what a user may see.                              |
| File bytes (Library files, chat attachments, agent deliverables)                                      | Garage (S3) — bucket `rei-files`                            | Immutable objects, real deletion, files up to 1 GiB without filling a container filesystem, and no growth of the control image's disk. |
| Keyword and vector indexes for history search                                                         | Qdrant — `rei_history_lexical_v1`, `rei_history_dense_v<n>` | BM25 and ANN over the same passages, with filters applied before ranking. Derived data: SQLite can rebuild it.            |
| Trace payloads (the model requests and responses in a chat's trace)                                   | local folder `control-data:/data/blobs`                     | They are not user files and they do not belong in the object store; deleting the chat removes them.                       |

Nothing in this design asks two stores to agree. SQLite commits a decision; the services are brought to match it, and can be.

## Network posture

Garage and Qdrant are services of Dodai (`containers/compose.dodai.yaml`, project `dodai`), not of Rei's own project, so they keep running while Rei is stopped. Dodai puts them on two networks, both `internal: true` (no route out) with no published port:

| Network (name)                                      | Subnet           | Members                                                     |
| --------------------------------------------------- | ---------------- | ----------------------------------------------------------- |
| `rei-storage`                                       | `10.89.237.0/24` | Garage (`.2`), Qdrant (`.3`), Rei's control plane           |
| `rei-storage-shared`                                | `10.89.238.0/24` | Garage and outside callers that were given storage          |

Rei's control plane reaches them as `rei-garage:3900` and `rei-qdrant:6333` over `rei-storage`. Garage's admin API (`3903`) listens on its `rei-storage` address only and its RPC port (`3901`) on loopback, so neither is ever on the callers' network. **Qdrant is on `rei-storage` only**: callers get Garage, not Qdrant. The gateway, the sandbox, the browser and the edge proxy cannot open a socket to either, and the egress proxy and the page reader refuse both subnets — `containers/smoke-storage.sh` proves it on a running stack. The gateway stays a model gateway: file bytes and index queries never pass through it, and the gateway and reader never depend on storage.

An outside caller that needs object storage is signed up with `./rei callers add <id> --storage` and gets its own bucket and its own Garage key, which can use only that bucket. See [Gateway callers](gateway-callers.md#storage). Callers on `rei-storage-shared` can reach each other's S3 port, as they can on `rei-gateway-shared`; the key is what keeps a bucket private.

Each service requires its own credential: Garage an S3 access key and secret (SigV4 on every request), Qdrant an API key. An unauthenticated request to Qdrant gets 401; unsigned S3 requests get 403.

## Configuration

The control plane reads these from its environment (`containers/compose.yaml` sets them; `containers/init.sh` generates the secrets):

| Setting                                                  | Meaning                                |
| -------------------------------------------------------- | -------------------------------------- |
| `REI_GARAGE_ENDPOINT`                                    | e.g. `http://rei-garage:3900`          |
| `REI_GARAGE_BUCKET`                                      | e.g. `rei-files`                       |
| `GARAGE_DEFAULT_ACCESS_KEY`, `GARAGE_DEFAULT_SECRET_KEY` | from `secrets.env`, read once at start |
| `REI_GARAGE_REGION`                                      | default `garage`                       |
| `REI_GARAGE_TIMEOUT_MS`                                  | per-request timeout, default 15000     |
| `REI_QDRANT_URL`                                         | e.g. `http://rei-qdrant:6333`          |
| `QDRANT__SERVICE__API_KEY`                               | from `secrets.env`                     |
| `REI_QDRANT_TIMEOUT_MS`                                  | per-request timeout, default 15000     |

Startup refuses to guess: in real model mode, a missing or malformed value stops the control plane with the setting's name in the message. Faux model mode (tests, offline development) needs neither, and falls back to a folder of objects under the data directory and Rei's own index inside SQLite — and so does a process that says so out loud with `REI_ALLOW_FOLDER_FILES=1`, which is how the end-to-end harness (`tests/e2e`) runs the real control plane against a fake model gateway. Compose never sets that variable, so an installed Rei cannot drift onto the folder by accident.

The deployment's credentials live in one file, `containers/.secrets/secrets.env` (mode `0600`, gitignored): Rei's own token for the gateway (`REI_STANDIN`; other services get their own, see [Gateway callers](gateway-callers.md)), Garage's RPC secret, admin token and S3 key (`GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_DEFAULT_ACCESS_KEY`, `GARAGE_DEFAULT_SECRET_KEY`) and Qdrant's API key (`QDRANT__SERVICE__API_KEY`), under the names those services read. The two compose files (`containers/compose.yaml` and `containers/compose.dodai.yaml`) interpolate it into each service's own environment, so a service is given only the variables it uses: the gateway gets `REI_STANDIN`; Qdrant its API key; Garage its RPC secret, admin token and S3 key; the control plane that token and the two keys it is the client of. Because of the interpolation every compose call needs `--env-file containers/.env --env-file containers/.secrets/secrets.env` (or `COMPOSE_ENV_FILES`); `./rei` and the smoke scripts pass them. Model credentials and web search keys are not in this file: they are saved in the gateway from the web app. Garage's own config, which no longer holds a secret, is `containers/garage/garage.toml`. The file is generated once by `containers/init.sh` and never regenerated over an existing installation, because regenerating the keys orphans the data that was written with them; an installation made with the older one-file-per-value layout is migrated in place, keeping the same values. `REI_GARAGE_ACCESS_KEY_FILE`, `REI_GARAGE_SECRET_KEY_FILE` and `REI_QDRANT_API_KEY_FILE` still work for a deployment that mounts a key as a file.

## A fresh installation, and which databases are upgraded

A fresh installation creates the current schema. A database from the previous minor release onwards is upgraded in place on the first start (versions 18 and 19, from before the first release, are upgraded too: version 20 renames each agent's sandbox network mode; see [sandbox network](sandbox-network.md)). An older database, or one written by a newer Rei, is refused untouched with a message that names the way back. The policy is in [Database upgrades](versioning.md#database-upgrades).

To start over on the development machine (this destroys every chat, file and profile in that stack, **and every outside caller's bucket**):

```sh
./rei stop --all && docker volume rm rei_control-data rei_garage-meta rei_garage-data rei_qdrant-data rei_qdrant-snapshots
```

Dodai's volumes (`rei_garage-meta`, `rei_garage-data`, `rei_qdrant-data`, `rei_qdrant-snapshots`, and the gateway's and reader's) are _external_: compose never creates or removes them, so `docker compose down -v` of either project leaves them in place, and they outlive both projects. `containers/init.sh` creates them, and only an explicit `docker volume rm` deletes them.

## How an upload works

A file can be up to 1 GiB, so no step holds a whole upload in memory. `AttachmentService.upload` writes down what is about to exist, then puts the bytes, then makes them visible:

1. read the multipart request as a stream (`apps/server/src/http/multipart.ts`) and stage the file on disk in the upload spool, `<data dir>/uploads` (in the stack, the `control-data` volume, not the small `/tmp` tmpfs). The size limit is enforced as bytes arrive: a request whose Content-Length is over it is refused before its body is read, and one without is refused as soon as it passes the limit. The spool hashes the per-attachment envelope and the bytes (SHA-256) as it writes, so no two uploads can be confused by deduplication;
2. insert `storage_objects` — the ledger row, `state = 'pending'`, keyed `files/v1/<object id>/<sha256>`;
3. insert the `attachments` row that names that object (this is what owns the object);
4. stream the staged file to `PutObject` with its length and known hash (a retry reads the staged file again), then `HeadObject`: an upload is only reported once the service confirms the object is there with the size it promised. The put goes over `node:http` with backpressure, so memory stays flat however fast Garage reads (fetch kept every chunk of a streamed body). A body that does not match what it promised (Garage's `400 InvalidDigest`, or a staged file shorter or longer than its recorded size) is an integrity error and is not retried;
5. mark the ledger row `ready` and import the version into the Library, in one SQLite transaction, then remove the staged file. Staged files a crash left behind are removed at start.

A file's name never reaches the object key, and a key never contains a path: `GET`/`HEAD`/`DELETE` reject any key Rei did not mint. Downloads and previews are streamed from the store. A streamed read is verified against the hash the key carries as it goes, and its last chunk is held back until the hash matches, so a reader never receives a whole object that fails the check; a mismatch is an integrity error, not a silent wrong answer. A byte range is served without re-hashing the whole object — it is a slice, and the caller knows it. Only bounded reads load bytes into memory (at most 100 MiB, and smaller limits where a path says so: see [library.md](library.md)).

`PutObject` gets a deadline that grows with the file (`REI_GARAGE_TIMEOUT_MS` plus one second per 8 MiB), so a 1 GiB put is not cut off by the 15-second default.

If any step fails, the bytes become unwanted immediately: the ledger row goes to `delete_pending` and the background sweeper deletes the object when it can. `pending → ready → delete_pending → deleted` is the whole state machine, in `apps/server/src/storage/registry.ts`.

Objects are only deleted when SQLite says nothing owns them. An object is owned while an `attachments` row names it, which is why a Library file survives the chat that uploaded it, and why a file pinned in another chat keeps its bytes after the Library file is purged. A row still `pending` or `ready` after the orphan grace period, with no attachment naming it, is reclaimed at startup and by the scheduled attachment sweep before pending deletions are drained: that is the crash-and-restart case, where Garage took the bytes and SQLite never committed.

## How search is indexed

Every change to `history_entries` queues one row in `retrieval_outbox`, in the same transaction as the change. `RetrievalSyncer` works that queue off into Qdrant with its own backoff, and the embedding worker writes dense vectors into the collection named after the vector set (`rei_history_dense_v<n>`). A rebuild fills a new generation while the active one keeps serving; promotion is one SQLite write, because the collection is _named after_ the vector set — there is no alias to keep in step, and a query can only ever ask for the generation SQLite says is active.

Tool point IDs include the session ID as well as the Pi counter and chunk number. Existing installations remove the old unscoped tool points once and queue their replacement, clearing tool-vector coverage for re-embedding. Message point IDs stay unchanged. Outbox completion and retry match the processed revision, so an in-flight upsert cannot discard a newer delete. Dense writes recheck visibility after upload and durably queue cleanup if a purge overtook them.

Two rules make the whole thing safe to run late, twice, or after a crash:

- a point is only ever written from what SQLite says is searchable _right now_, so a queued upsert for text whose chat was deleted in the meantime becomes a delete;
- every hit is re-read from SQLite before it can be shown, so a point that briefly reappears during a race can never be returned.

Keyword search runs on Qdrant's BM25 over **Rei's own tokens** (`memory/keyword.ts`: lowercase words, plus overlapping CJK bigrams and every single CJK character). The documents and the query are both split by Rei, because Qdrant's tokenizer sees a run of Chinese as one word — a query in Chinese would find nothing. That is why the results behave as they did when FTS5 answered them.

When no retrieval service is configured (faux mode), or when the service refuses a search, keyword search runs on Rei's FTS5 index inside SQLite, which is still maintained. Vector search has no local copy in that case, so the keyword ranking answers alone and the status says why.

## Diagnostics

- `./rei doctor` reports garage and qdrant as Dodai services, whether the control plane can reach `rei-garage:3900` and `rei-qdrant:6333` (the failure mode of a stack recreated without the storage network), that the six external volumes exist and that Dodai did not create them, that no Garage or Qdrant is left in Rei's own project, and that `rei-storage-shared` exists.
- `containers/smoke-storage.sh` checks the isolation from every other container, then runs **Rei's own Garage and Qdrant clients** against the live services from a container on `rei-storage`: object round trip, range read, integrity refusal, list, delete, and BM25/dense/filtered queries including Chinese. It creates its own objects and collections and deletes what it made. It ends with `containers/smoke-storage/run.sh`, which makes a temporary caller with storage and proves its key is its own: it can use only its bucket, Rei's key cannot read it, the callers' network reaches S3 and nothing else, the agent's egress paths refuse both subnets, and rotate and revoke take effect.
- `GET /api/diagnostics/storage` (signed in) reports the ledger counts, the last failed deletion, the search service's own status, and how many entries the queue still owes. It contains no object key, no filename and no credential.
- The memory status (`GET /api/memory/index`) carries `indexing: { pending, lastError }`: how far behind the search service is. A backlog is a delay in ranking, never a loss of history — the entries are in SQLite.

## Backup and recovery

Back up **SQLite and Garage together**, while Rei and Garage are stopped. Qdrant is the only part that may be stale or missing: an empty Qdrant means search catches up, an empty Garage means files are gone.

**Backup and recovery of storage belong to Dodai.** Stopping Rei no longer stops Garage, and outside callers may be writing to it. Stop the callers that write first, then stop Rei and Garage and archive the volumes. The gateway and reader can stay up.

```sh
./rei stop
docker compose --env-file containers/.env --env-file containers/.secrets/secrets.env -f containers/compose.dodai.yaml stop garage qdrant
docker run --rm -v rei_control-data:/data -v "$PWD/backups:/out" alpine tar czf /out/control-data.tgz -C /data .
docker run --rm -v rei_garage-meta:/m -v rei_garage-data:/d -v "$PWD/backups:/out" alpine sh -c \
  'tar czf /out/garage.tgz -C /m . && tar czf /out/garage-data.tgz -C /d .'
tar czf backups/secrets.tgz containers/.secrets   # secrets.env holds the keys: without it the volumes are unreadable
./rei start
```

A Garage restore is all or nothing: it rolls back **every caller's bucket** together with Rei's. There is no per-bucket restore. Callers' keys live in Garage's metadata, so they come back with it.

Restore in the same order, into a stopped stack: `secrets.tgz` back to `containers/.secrets` (then `chmod 600 .secrets/secrets.env`), the control and Garage volume archives back into their volumes, then `./rei start` and check `./rei doctor` plus `containers/smoke-storage.sh`. Qdrant needs nothing; on first start Rei detects missing collections before creating them, queues all existing visible history for lexical indexing, and clears dense coverage for the missing generations. The embedding worker refills the active and building generations when their configured provider is available; a retired generation refills if it is selected again. This work is recorded in SQLite before collection creation, so interrupted initialization can be retried. Collection and payload-index initialization uses the sync retry loop, including when Qdrant was unavailable at startup.

The two failures worth knowing apart:

- **SQLite lost, Garage intact.** Chat history, the Library records and the ledger are gone; the bytes are still in the bucket, but nothing in Rei can name them. Restore the SQLite archive; that is the only recovery.
- **Garage lost, SQLite intact.** The Library and attachments are unreadable and Rei says so per file (integrity/unavailable, never an empty file). Restore the Garage volumes. If they are gone too, the files are gone; nothing in SQLite can reconstruct them.

`garage/admin-token` and `garage.toml` are also in the secrets archive. `qdrant-snapshots` is a convenience: a snapshot speeds a restore of the index, and losing one costs a re-index, nothing else. If a caller is ever given Qdrant, its collections are derived data like Rei's: the backup above covers Garage, and Qdrant only as a convenience.
