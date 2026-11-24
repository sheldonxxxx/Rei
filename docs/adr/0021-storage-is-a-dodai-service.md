# Storage is a Dodai service

Status: accepted (2026-11-16). Supersedes the "Moving Garage and Qdrant to the Dodai project" item in [ADR 0018](0018-the-gateway-serves-several-callers.md).

Garage (files) and Qdrant (vectors) lived in Rei's compose project, with Rei as the only caller. A second caller that needs file storage would have had to join Rei's networks or run its own store.

## Decisions

- **Both services move to Dodai's project.** Garage and Qdrant are services of `containers/compose.dodai.yaml` next to the gateway and the reader, so they keep running while Rei is stopped. Their data lives in six external volumes with fixed names (`${REI_PROJECT:-rei}_garage-meta`, `_garage-data`, `_qdrant-data`, plus the gateway's and reader's own data and the Qdrant snapshots). `init.sh` creates them; Compose never removes them, so `down -v` cannot delete data. The names are fixed so the volumes keep their contents when the services change project.
- **Callers get Garage directly, not Qdrant.** A caller receives a bucket and a key named `caller-<id>` with read and write access only, never `owner` or `createBucket`, over a separate network, `rei-storage-shared`, that carries S3 only. Revoking deletes the key; purging removes the bucket only once it is empty and its caller is revoked. Qdrant sits on `rei-storage` with Garage and Rei's control plane and nothing else; a caller's vector data is derived and can be rebuilt, so isolating it is a later step.
- **Rei's own key loses `createBucket`**, so it cannot create buckets that look like a caller's. The restriction persists across Garage restarts.
- **Admin goes through `garage json-api` inside the container.** The CLI runs the command over Garage's local RPC, which now binds to loopback inside the container. No admin token exists on the host, and the admin API listens only on the `rei-storage` address.
- **The two storage networks are refused to egress.** The egress proxy and the reader refuse both subnets, so an agent or a fetched page cannot reach the stores.
- **Names are part of the contract.** The volume names, the networks `rei-storage` and `rei-storage-shared`, and the aliases `rei-garage` and `rei-qdrant` are what callers and existing installs depend on, so they are not renamed.
- **The later Qdrant step must work with exact collection names.** Qdrant's JWT access lists match collection names exactly, with no prefixes, and only a global manage token can create a collection. Giving callers Qdrant therefore means collections created for them, under names fixed in advance.

## Consequences

- A second caller gets a private bucket for the price of `./rei callers add <id> --storage`. `containers/smoke-storage/run.sh` proves the isolation with a temporary caller, using plain SigV4 over the network.
- Rei needs Dodai running to use storage; `./rei start` brings it up first and refuses to run when a storage volume is missing (`./rei setup` creates them).
- OrbStack routes between bridge networks, so any container on the host, even one on the default bridge alone, reaches container addresses on the internal networks. There, the credentials (the S3 key, Garage's admin token, Qdrant's API key) are the boundary, not the network. This is the host's behavior and also applies to Rei's existing internal networks; the checks therefore probe from a container on `rei-storage-shared` alone, and the S3 key is what protects a bucket.
- Jobs of a caller can no longer share a Qdrant collection with Rei until the Qdrant step is built.
