# Install Rei レイ

## Requirements

- A checkout of this repository on the machine where Docker runs.
- Node.js 24 or newer, npm, Docker, and Docker Compose v2.
- Internet access to download dependencies, container images, and any model selected through oMLX.
- Disk space for the images, optional oMLX model weights, conversations, and saved files. Setup checks available space; allow additional room as your Library grows.
- A supported model account for real AI replies, connected in the web app under **Settings → Providers**.
- An authenticator app is optional, for two-factor sign-in.

On macOS, run the CLI in the environment with access to your Docker daemon. An Apple Silicon Mac can host the optional oMLX service outside a Linux guest.

## Start the services

From the repository root:

```sh
./rei setup
```

Setup guides you through checking your computer and preparing Rei. It uses Clack in a supported terminal, keeps successful technical checks and build logs out of the way, and shows guidance when something needs attention. At the end, open the printed address to create your account. Run `./rei` without a command to list the commands.

Models, Memory (embeddings), web search and passwords are configured in the web app after setup. Included web search works without extra keys. Brave, Tavily, an external SearXNG and every provider key are set in **Settings → Providers → Web search**, never from the CLI or a file.

For a plain text interface, use `./rei setup --basic`. The basic interface is also used automatically for limited terminals (`TERM=dumb`), CI, non-interactive or JSON commands, or when Clack has not been installed yet. Run `npm ci` to install the guided interface. `--non-interactive` never asks questions. See `./rei setup --help` for command-specific options.

Setup asks no questions and never downloads a model. If a step fails, follow the printed fix and run setup again. Repeating setup preserves the current configuration.

After setup, control the services with `./rei start`, `./rei stop`, and `./rei restart`. These commands use the current Compose configuration; stopping Rei preserves its containers, data volumes, and secrets. The gateway runs as a separate Compose project so that other services can use it (see [Gateway callers](gateway-callers.md)): `start` starts it first, while `stop` and `restart` leave it running unless you add `--all`.

To rebuild the web app and all Rei-built Compose images from the current checkout, then recreate the services, run:

```sh
./rei redeploy
```

Redeploy reuses Docker's build cache, so unchanged layers are not rebuilt and it is usually faster than a full rebuild; `./rei redeploy --no-cache` forces every layer to build again. It causes a short interruption but keeps Docker data volumes and `containers/.secrets/` intact. Run `./rei status` afterwards to check the services.

The default address is [http://127.0.0.1:8787](http://127.0.0.1:8787). To choose another local port, set this in `containers/.env` before setup:

```dotenv
REI_PUBLISH=127.0.0.1:8788
```

A new installation starts with an empty database. A later release upgrades it in place on its first start, from at least the previous minor release; Rei refuses a database that is too old or was written by a newer release, and changes nothing (see [Database upgrades](versioning.md#database-upgrades)). Take a backup before upgrading ([Backup and recovery](storage.md#backup-and-recovery)).

## Create your account

1. Open the address printed by setup.
2. Enter the one-time setup code and choose a password of at least 12 characters.
3. Complete setup to sign in.

To enable two-factor authentication later, open **Settings → General → Two-factor authentication**, enter your current password, scan the QR code (or enter its key), and confirm a six-digit code. Setup expires after ten minutes; sign-in stays password-only until confirmation.

Later sign-ins use your password, plus an authenticator code only if you enabled two-factor authentication, or a passkey if you added one under **Settings → General → Passkeys** (it needs no password or code, and works on `localhost` or over HTTPS). To show the setup code again, run `./rei setup-code`. If it cannot find the code, read the control service log:

```sh
docker compose -f containers/compose.yaml logs control
```

Service logs are JSON lines with ids and codes, never message text. [Service logs](logging.md) covers levels, `REI_LOG_LEVEL`, following one run by `stepId`, and how long Docker keeps them.

## Connect a local chat model

In the web app, open **Settings → Providers** and choose **Custom OpenAI-compatible endpoint**. For oMLX running on the same Mac as Docker, use `http://host.docker.internal:18000/v1` when Rei runs in local Docker (adjust the port to match oMLX). Enter the oMLX API key, then click **Scan models**. Review the returned model IDs and keep the chat models you want to offer; a server's model list can also include speech and embedding models. Save the connection, then choose the chat and background defaults in **Settings → Models**.

Custom providers use Chat Completions. Scanning requests the endpoint's `/models` list through Rei's gateway. When editing a saved connection, a blank API-key field keeps its key for scans against the same URL. Credentials are never returned to the browser. HTTPS is supported for remote providers; plain HTTP is limited to localhost and the `host.docker.internal` container-to-host bridge.

## Set up Memory

Memory can find past conversations by meaning. Keyword search remains available when you skip embeddings or a provider is unavailable. Rei does not bundle or download an embedding model. The provider is set in **Settings → Providers → Embeddings** in the web app, or in the Memory step of first-time setup. **Settings → Memory** manages saved facts and instructions.

- **oMLX:** available on Apple Silicon; runs on the Mac and uses authenticated inference. Install it either as the official DMG app (open it once and finish its first-run setup, which installs the `~/.omlx/bin/omlx` command) or with Homebrew (`brew tap jundot/omlx && brew install omlx`). Start oMLX yourself; Rei connects to the service that is answering.
- **Custom OpenAI-compatible API:** an endpoint you configure with an explicit model profile. This can also connect to an oMLX service running elsewhere.
- **Off:** keyword-only search, without downloading an embedding model.

Choose the provider and run **Test connection** in the web app; **Save** becomes available once the test passes. See [embedding providers](embedding-providers.md) for endpoint and profile details (any http or https origin and port, with a plain-HTTP warning) and for what happens when both oMLX installation routes are present. At the key prompt, use an oMLX inference key rather than the admin key. Remote providers receive conversation text selected for indexing.

## Optional Codex image tools

For a local installation, [enable the Codex Images worker](codex-images.md) to let agents generate and edit images using a separate Codex sign-in.

## Verify and operate

```sh
./rei status
./rei doctor
./rei setup-code
./rei reset-password
```

`status` shows the containers and whether the app answers and has an account. `doctor` checks services, networking, storage, the sandbox and the app, and never changes anything. Provider connections are tested in the web app.

The CLI manages Rei レイ (`containers/compose.yaml`) and Dodai · 土台 (`containers/compose.dodai.yaml`). It starts Dodai first. Stopping or restarting Rei leaves Dodai running for other callers; add `--all` to include it:

```sh
./rei stop
./rei start
./rei restart
```

Keep the configured data volumes and `containers/.secrets/` when stopping the app. They contain account data, saved work, and service credentials. For a backup, stop the stack and copy its data volumes and secrets together.

Chat history and Library records live in SQLite; the file bytes themselves live in the Garage volume, and the history search indexes in the Qdrant volume; both belong to Dodai, so they keep running when you stop Rei, and outside callers' buckets are in the same Garage volume. Back them up together and restore them in that order — see [docs/storage.md](storage.md) for the commands, and for what each service's loss means. Qdrant is the one part that may be missing after a restore: search catches up from SQLite.

## The agent browser's idle time

The `browser` container stays up, but Chromium inside it runs only while something is connected: the first browser call starts it (a few seconds), and it stops after a minute with no client. Two settings, in the same environment Compose reads (for example `containers/.env`), tune this; apply them with `./rei start`:

- `REI_BROWSER_IDLE_MS` (control plane, default `3600000`, one hour): a browser window nobody has used for this long is closed, and the agent is told the page is gone. A run, an open takeover or someone watching the live view keeps a window open. `0` turns idle closing off, so windows stay until another chat needs the slot, the chat is deleted or the browser restarts. The cap on open windows is `REI_BROWSER_WINDOWS` (default 3).
- `BROWSER_IDLE_STOP_S` (`browser` container, default `60`): seconds with no connection before Chromium is stopped. Rei disconnects as soon as its last window closes.

## Reach Rei from your other devices

Rei listens on the host's loopback address (`REI_PUBLISH`, default `127.0.0.1:8787`). Phones and other computers reach it through something in front of it that serves HTTPS: Tailscale, or your own reverse proxy. Rei has no relay service, and nothing about it is exposed to the internet unless you expose it.

Two settings go with either path. Put them in the environment Compose reads (for example `containers/.env`), then run `./rei start` (it recreates the containers that changed; `restart` does not re-read the environment):

- `REI_PUBLIC_URL`: Rei's public address, such as `https://rei.example.ts.net`. It sets the expected WebAuthn origin and lets the browser live view accept that address when a proxy rewrites the Host header. Startup stops if the value is not an `http(s)` URL.
- `REI_COOKIE_SECURE=1`: marks the sign-in cookie Secure. Rei already does this for requests that arrive with `X-Forwarded-Proto: https`; the setting makes it unconditional.

### With Tailscale

[Tailscale Serve](https://tailscale.com/kb/1312/serve) gives the host an HTTPS address on your tailnet and proxies it to the loopback port. The stack does not change and no sidecar is needed. Only devices signed in to your tailnet can reach it.

1. Install Tailscale on the host and sign in. In the admin console, turn on MagicDNS and HTTPS certificates.
2. Serve the loopback port over HTTPS, in the background:

   ```sh
   tailscale serve --bg 8787
   ```

   `tailscale serve status` prints the address, `https://<machine>.<tailnet>.ts.net`. Keep `REI_PUBLISH` at `127.0.0.1:8787`.
3. Set `REI_PUBLIC_URL=https://<machine>.<tailnet>.ts.net` and `REI_COOKIE_SECURE=1`, then `./rei start`.
4. On the phone, install Tailscale, sign in to the same tailnet, and open the address. Sign in with your password and authenticator code. To get notifications on an iPhone, add the page to the Home Screen first and turn notifications on from the app.

`tailscale serve reset` stops serving. Do not use `tailscale funnel`, which publishes the address to the internet.

### With your own reverse proxy

Use this path when Rei should answer at your own domain, such as `https://rei.example.com`. The proxy terminates HTTPS and forwards to `127.0.0.1:8787` on the same host. Whatever proxy you use, it must:

- **Forward the original host and scheme.** Send `X-Forwarded-Proto` (so the sign-in cookie is marked Secure) and `X-Forwarded-Host` with the port if it is not 443. The browser live view compares the page's origin with these, host and port both, and refuses the connection when they differ.
- **Pass the event streams through unbuffered.** `/api/stream` and `/api/sessions/<id>/stream` are Server-Sent Events. Rei marks them `X-Accel-Buffering: no` and sends a keep-alive every 15 seconds, so any read timeout over that is enough.
- **Allow the WebSocket upgrade** on `/api/sessions/<id>/browser/live` (the browser live view). Rei pings it every 25 seconds.
- **Accept request bodies of at least 1.1 GB, and stream them.** Each file is uploaded in its own request, and a file may be up to 1 GiB (plus a little for the form around it). Rei reads the body as it arrives and refuses one over the limit early, so let the proxy pass it through rather than buffer it to disk first.
- **Give an upload time to arrive.** Rei allows a request up to an hour to arrive in full (about 300 KB/s for 1 GiB). A proxy timeout that limits the whole request, rather than the gap between two reads, must be at least as long as your slowest expected upload.
- **Use a certificate the phone trusts.** Notifications need a secure page. A self-signed or private-CA certificate signs in, but iOS and Android will not register for push from it.

Then set `REI_PUBLIC_URL` to the proxy's address and `REI_COOKIE_SECURE=1`, and run `./rei start`. Keep `REI_PUBLISH` at `127.0.0.1:8787` while the proxy runs on the same host. If the proxy runs on another machine, set `REI_PUBLISH` to an interface it can reach (for example `192.168.1.20:8787`). That port then serves plain HTTP on your network, so firewall it to the proxy's address.

A proxy that runs in a container cannot reach the host's `127.0.0.1`. Run it with host networking, or publish Rei on an address the container can reach.

#### Caddy

Caddy gets and renews a certificate for the name by itself, as long as the name resolves to the host and ports 80 and 443 reach it. It sends `X-Forwarded-Proto` and `X-Forwarded-Host`, upgrades WebSockets, flushes event streams, and sets no body limit, so a short site block is enough:

```caddyfile
# /etc/caddy/Caddyfile
rei.example.com {
	reverse_proxy 127.0.0.1:8787 {
		# Stream every response as it arrives (Caddy already does this for event streams).
		flush_interval -1
	}
}
```

Reload with `sudo systemctl reload caddy` (or `caddy reload --config /etc/caddy/Caddyfile`). Leave out `encode`: compressing an event stream holds events back.

#### nginx

nginx needs the WebSocket upgrade, the forwarded headers, and the body limit spelled out. The certificate paths below are the ones Certbot writes. Use your own if you get the certificate another way.

```nginx
# /etc/nginx/conf.d/rei.conf

# "Connection: upgrade" only when the client asks for a WebSocket.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name rei.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name rei.example.com;

    ssl_certificate     /etc/letsencrypt/live/rei.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rei.example.com/privkey.pem;

    # One file per upload request, up to 1 GiB plus the form around it.
    client_max_body_size 1100m;
    # Pass uploads to Rei as they arrive instead of spooling them to disk first. nginx's body timeouts count the gap
    # between two reads, not the whole upload, so their defaults suit a slow upload that keeps moving.
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        # $http_host keeps a non-standard port; the live view compares host and port.
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-Host  $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

        # The browser live view.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Rei sends "X-Accel-Buffering: no" on its streams, so nginx passes them unbuffered.
        # Keep-alives arrive every 15 s (streams) and 25 s (live view), inside this timeout.
        proxy_read_timeout 120s;
    }
}
```

Check with `sudo nginx -t`, then `sudo systemctl reload nginx`. The `http2 on;` line needs nginx 1.25.1 or newer. On older versions, delete it and write `listen 443 ssl http2;` instead.

#### Check the proxy

1. `curl -fsS https://rei.example.com/api/health` answers JSON.
2. Sign in from the phone. Reload the page. If you are asked to sign in again, the cookie was not kept: check `X-Forwarded-Proto` and `REI_COOKIE_SECURE`.
3. Send a message in a chat. The reply should appear word by word. If it only appears all at once at the end, something in front of Rei buffers the stream (a CDN or a second proxy, or `encode` in Caddy).
4. Open a chat where the agent used the browser and open the live view. If it shows **Can't watch**, the forwarded host or port does not match the address in the address bar, or `REI_PUBLIC_URL` names a different address.
5. Turn on notifications in Settings and press **Send a test**.

Numeric control-plane environment settings must be non-negative safe integers; blank values use their defaults. `REI_PORT` accepts 0–65535 (0 selects an ephemeral port for tests), and `REI_EXEC_PORT` accepts 1–65535. Invalid values stop startup with the setting's name in the error. The guard restricting `REI_EXEC=local` to faux model mode still applies.

## Troubleshooting

- **Port occupied:** choose another `REI_PUBLISH` port, then rerun setup.
- **Model unavailable:** check the connection under **Settings → Providers** in the web app, then choose an available model in **Settings → Models**.
- **Search unavailable:** configure an optional provider under **Settings → Providers → Web search** in the web app. Web search and Memory have separate configurations.
- **Memory unavailable:** test the connection under **Settings → Providers → Embeddings**. Keyword-only recall remains available.
- **Files or search failing after a redeploy:** run `./rei doctor` (it checks that the control plane reaches the object store and the search index in Dodai, and that the storage volumes exist), then `containers/smoke-storage.sh`. If `./rei start` says a storage volume is missing, run `./rei setup`: it creates the external volumes.
- **Account password lost:** run `./rei reset-password` from the host terminal. An enabled authenticator remains required, and registered passkeys keep working.
- **Database refused at start:** `docker compose … logs control` shows why. A database written by a newer release needs that release again; one older than the previous minor release needs the releases in between first ([Database upgrades](versioning.md#database-upgrades)). Either way, a backup taken before the upgrade restores the old state ([Backup and recovery](storage.md#backup-and-recovery)).

### Web search defaults

Rei uses keyless Exa by default and does not bundle SearXNG. In the web app, choose **Exa · no API key (default)** or **Exa · API key**. Keyless mode ignores any saved Exa credential; the API-key option keeps the credential in the gateway and reuses it when the field is blank. Brave, Tavily, and explicitly configured external SearXNG remain optional.

Existing saved bundled SearXNG defaults migrate to keyless Exa. The retired container and its networks are removed on a normal Compose redeploy with `--remove-orphans`; existing application volumes and secrets are preserved.

### Android passkeys

Android passkeys use the same relying-party domain as Rei on the web. Set `REI_PUBLIC_URL` to the HTTPS origin that Android users connect to. Use a DNS hostname with a trusted TLS certificate. Android's credential provider must be able to reach the domain's Digital Asset Links file.

1. Run `apksigner verify --print-certs /path/to/rei.apk` and take the SHA-256 digest of the signer certificate for that APK. Obtain the digest for each signature you expect to use, including debug signatures on test installations.
2. Serve the following statement at `https://your-rei-host/.well-known/assetlinks.json` with an `application/json` content type and HTTP 200. Configure your HTTPS proxy or static host to serve this path directly, without login or redirects. Replace the placeholder with the certificate's colon-delimited SHA-256 fingerprint and add additional fingerprints for other allowed builds.

   ```json
   [
     {
       "relation": ["delegate_permission/common.get_login_creds"],
       "target": {
         "namespace": "android_app",
         "package_name": "dev.rei.android",
         "sha256_cert_fingerprints": ["<SHA-256 fingerprint of the APK signer>"]
       }
     }
   ]
   ```

3. Convert each of the same certificate digests to its Android signing origin. This command accepts the fingerprint with or without colons.

   ```sh
   python3 -c 'import base64, sys; print("android:apk-key-hash:" + base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1].replace(":", ""))).decode().rstrip("="))' '<SHA-256 fingerprint>'
   ```

4. Set `REI_ANDROID_PASSKEY_ORIGINS` to the resulting origins, comma-separated. Use the same signer certificates in both the environment variable and the Digital Asset Links file. Restart Rei. Only include signing certificates you control or trust to produce your Rei APK.
5. Sign in on Android with your password and authenticator code if enabled. Open **Settings → Passkeys**, add a passkey from the device, then sign out and try **Sign in with a passkey** to verify the complete setup.

App and web passkeys share the relying-party domain. Rei accepts an Android ceremony only when the signed app origin matches one of the configured signing origins. A server with no Android passkey origins still supports normal web passkeys and Android password sign-in. Loopback HTTP with `adb reverse` is suitable for password and chat development. Android passkeys require the HTTPS association.

[Android Credential Manager prerequisites](https://developer.android.com/identity/credential-manager/prerequisites) · [Android passkey server origin verification](https://developer.android.com/identity/passkeys/create-passkeys)
