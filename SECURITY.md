# Security policy

## Reporting a vulnerability

Please report security problems **privately** through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, discussion or pull request for a suspected vulnerability.

Include what you found, the version or commit, how to reproduce it, and what an attacker could do with it. Do not include real credentials, tokens or personal data; use test values.

Rei is maintained by one person in their spare time. Expect an acknowledgement within a few days. A fix and an advisory follow once the problem is understood; you will be credited if you want to be.

## Supported versions

Rei is in early development (v0.0.x). Only the latest release and the current `main` branch receive security fixes. Older releases are not patched; upgrade instead.

| Version               | Supported |
| --------------------- | --------- |
| `main` and the latest release | Yes |
| Anything older        | No        |

## Scope and deployment

Rei is meant to run on your own machine, bound to loopback, and be reached from other devices only through a front end you control (for example Tailscale or your own HTTPS proxy). Exposing it directly to the internet is outside its supported design. See the [installation guide](docs/installation.md) before putting it on a network.

In scope: the control plane (`apps/server`), the gateway, the web reader, the egress proxy, the sandboxed execution and browser containers, the web app, the CLI and the Android client. A weakness in a third-party dependency is best reported to that project; tell us too if Rei's usage makes it exploitable.
