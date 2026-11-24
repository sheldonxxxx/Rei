# Sandbox network

Each agent has a sandbox network mode for connections made by sandbox commands. The egress proxy handles these connections on ports 80 and 443.

| Mode | Sandbox command access |
| --- | --- |
| **Block** (`block`, default) | Denies all destinations. |
| **Whitelist** (`whitelist`) | Allows only listed destinations. A local-network hostname needs both a name entry and an address entry. |
| **Any** (`any`) | Allows public and local-network destinations. |

The sandbox proxy makes its decision without prompting, regardless of the chat's approval profile or data labels. Loopback, link-local and the stack's own subnets are refused in every mode.

### Local-network addresses need both the name and the address

In Whitelist mode, an address on the user's local network (`10.x`, `172.16–31.x`, `192.168.x`, `100.64/10`, IPv6 unique-local) is reached only when the whitelist names **both**:

1. **The site**, by host name or wildcard (`nas.lan`, `*.corp.lan`). This is what the request is for.
2. **The address**, by an IP address (`10.0.0.5`) or a network (`10.0.0.0/8`) that covers the address the name resolves to.

Rules that follow from this:

- A whitelisted name that resolves to a local address is allowed only if an IP or network entry covers that address. If none does, the connection is refused.
- An IP address is its own name. An IP or network entry that covers the address you connect to is enough, so `10.0.0.0/8` opens `10.0.0.5`.
- A network entry does not open a name. `10.0.0.0/8` does not open `nas.lan`, even when `nas.lan` resolves into that network. Only a `nas.lan` entry does.
- A name that is not on the whitelist gets no local-network address, and the sandbox proxy denies the connection before DNS resolution.

Example: to reach `wiki.lan` on `10.0.0.42`, add both `wiki.lan` and `10.0.0.0/8` (or `10.0.0.42`) to the whitelist. Any mode reaches the local network without any of this.

The browser has its own network policy. The dedicated `web_fetch` tool can read public pages through the shared reader. It uses the sandbox network mode to scope local-network access.

## The whitelist

Whitelist agents reach the whitelist without asking. It is one list for the whole installation, edited in **Settings → Permissions → Sandbox network**.

- An entry is a host name (`pypi.org`), a wildcard for subdomains (`*.github.com`, which does not match the bare domain), an IP address (`192.168.1.5`), or a network (`10.0.0.0/8`). Entries are lowercased, a trailing dot is dropped, and duplicates are removed.
- To reach a local-network address, list both its host name and its address (an IP address or a network). A name entry alone does not open the address, and an address entry alone does not open the name. See [Local-network addresses need both the name and the address](#local-network-addresses-need-both-the-name-and-the-address).
- The list holds at most 200 entries. An entry that is not valid refuses the whole save, and the saved list stays as it was.
- The out-of-the-box list is the package registries and repository hosts: `pypi.org`, `files.pythonhosted.org`, `registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`, `codeload.github.com`. **Restore defaults** brings it back.
- Changes apply to the next request an agent makes; no restart is needed.

Storage: the list is a JSON array under the `sandbox_whitelist` key of the `meta` table. Without a saved list, the defaults apply.

## Where it is set

- **Per agent:** agent settings, **Sandbox network** (**Block**, **Whitelist** or **Any**). New agents start at **Block**.
- **Whitelist:** **Settings → Permissions → Sandbox network**.
- **API:** `PATCH /api/agents/:id` takes `networkMode`. `GET /api/settings/sandbox-network` returns `{ whitelist, defaults }`. `PUT /api/settings/sandbox-network` takes `{ whitelist: string[] }` to replace the list, or `{ reset: true }` to restore the defaults. A bad list answers `400 bad_request`.

The agent tells the model which mode applies in its sandbox note, so a refused command is reported to the user rather than retried.

## How a decision is made

1. The proxy sends the destination hostname and port to the control plane before resolving the name.
2. The control plane returns allow or deny. An allow includes the scope of local-network addresses the destination may reach.
3. After an allow, the proxy resolves the name and checks each resolved address against that scope and the reserved-address rules.

## Migration

Schema version 20 upgrades version 18 and 19 databases in place. It maps `off` and `ask` to `block`, `restricted` and `whitelist` to `whitelist`, and `full` and `any_site` to `any`. Pending sandbox network approvals expire during the upgrade. The saved whitelist is preserved.

## Not included

- Package caches (uv, npm) live in the `exec-cache` volume mounted at the sandbox's `~/.cache`, so a reinstall after a restart reuses them; they are still separate from the agent's workspace (`exec-workspace`), and `docker compose down -v` removes them.
- The whitelist is one list for the whole installation. Every Whitelist agent reaches every whitelisted site.
