# Codex images

Rei can generate and edit images using a separate Codex sign-in. The existing gateway makes direct requests to the Codex Images endpoints on `chatgpt.com` and refreshes the Codex credential on demand. The image route is available on the gateway’s Rei-only listener. The regular OpenAI connection continues to serve chat and search.

## Sign in

The feature is on with the gateway. If you previously used the optional image worker, remove `codex-images` from `COMPOSE_PROFILES` and, if its container is still present, stop and remove it (default name `rei-codex-images-1`). The gateway connection requires its own sign-in.

Sign in from the web app: open **Settings → Providers → Images**, choose **Sign in to Codex Images**, then enter the code shown on the OpenAI device page that opens. Rei finishes sign-in once you approve it. Device-code login must be allowed for your ChatGPT account (ChatGPT → Settings → Security). **Sign out** removes the saved credential.

To sign in from a terminal instead, run the gateway CLI from the Rei checkout and follow its device-code prompt:

```sh
docker compose --env-file containers/.env --env-file containers/.secrets/secrets.env \
  -f containers/compose.dodai.yaml exec gateway node src/cli.ts codex-images login
```

Ask the agent to generate an image, or attach an image and ask for an edit. You can also name a saved Library image. Edits accept up to five PNG, JPEG, WebP, or GIF references totaling at most 20 MiB. The built-in `image_generate` tool runs automatically in Standard and YOLO. Strict asks for one-time approval. The completed image appears in the reply and is saved to the Library.

## Usage

**Settings → Usage** has an **Images** section: requests, how many succeeded or failed, generated and edited counts, average time, and failures by reason (rate limited, another image already in progress, sign-in needed, other). Rei keeps daily counters only, never prompts or images, and counts start from the version that added them. Image requests count toward your Codex limits, which OpenAI does not report per request, so there are no token figures.

## Sign out

To remove the saved image credential, use **Sign out** on the Images tab or the Compose command above with `codex-images logout`. Use `codex-images status` to check whether the gateway has a saved image credential. Without a credential the image tool reports that sign-in is needed.
