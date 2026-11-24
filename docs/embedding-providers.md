# Rei レイ embedding providers

Configure embeddings in **Settings → Providers → Embeddings**, or the **Memory** step of first-time setup. The same form is available in both places. The terminal CLI does not manage providers, and `./rei doctor` does not check them.

## Connect a service

Rei supports a running oMLX service or an OpenAI-compatible embeddings API. Rei does not bundle or install the provider runtime. Start oMLX using its own application and make the desired embedding model available there.

1. Choose **oMLX** or **OpenAI-compatible API**.
2. Enter the service origin, optionally ending in `/v1`. For a service on this Docker host, use `http://host.docker.internal:PORT`, with the port your provider serves. `localhost` inside a container refers to that container.
3. Enter the model ID exposed by the API and its inference API key, if required. Prefer an inference key rather than an administrator credential.
4. Choose **Test connection**. Rei sends the values on the form to the gateway, checks inference, and detects dimensions without saving anything. **Save** becomes available only after the test passes on those exact values; changing any field requires testing again. Model discovery is not required.
5. oMLX uses the validated EmbeddingGemma preset below, and its dimensions must match that preset.

Custom APIs use plain text and a conservative 512-token clipping limit. **Advanced** offers document/search templates and a token-limit override. Keep exactly one `${t}` in the document template and one `${q}` in the search template.

Choose **Off · keyword search** to disable embeddings. Keyword search remains available. Saving applies immediately; no container restart is needed. The connection and credentials survive restarts. Existing environment configuration remains a fallback until a connection is saved from the web.

## Vector semantics

The oMLX preset is `mlx-community/embeddinggemma-2-6bit`, revision `a61f0b6dcee35cf68475e91b8b28ed830057d7c4`, affine 6-bit group-64 BF16, 768 dimensions, mean pooling, and a conservative 2048-token context. Its document template is `title: none | text: ${t}` and query template is `task: search result | query: ${q}`. The served API model ID may be an alias; enter that alias in the model field.

For automatically configured APIs, checkpoint revision, quantization and pooling are not discoverable through the standard embeddings response. Rei records provider-managed identity markers (including pooling: `provider`). Endpoint, model, dimensions and templates separate incompatible indexes. Existing explicit profiles remain supported. Matching dimensions alone does not make vectors compatible. If a provider silently replaces a model at the same endpoint with the same dimensions, use Memory's rebuild action.

When vector semantics change, the worker builds a compatible index and retains retired vector sets. Keyword search remains available while indexing or if the provider fails.

## Credentials and transport

The gateway stores credentials in its private secret store. Browser reads never return saved keys. A blank key retains the saved credential for the same URL; changing the URL clears it, so enter a key for the new service. The control database stores only the non-secret connection and profile. Earlier versions also read a key file the CLI wrote; the gateway no longer reads it, so enter the key once in the web app.

The server sends inference through authenticated gateway routes. Only `/embedding/v1/models` and `/embedding/v1/embeddings` are forwarded, to the configured origin and model. Redirects, arbitrary forwarding headers and provider admin routes are not exposed. HTTP sends indexed text and credentials without encryption; use HTTPS where appropriate. A remote service receives the text being indexed.

**Test connection** in the web app checks discovery, inference and dimensions for the values on the form. A successful local test does not establish checkpoint provenance or a remote provider's privacy policy.

## Web search

Configure **Settings → Providers → Web search** in the web app; the CLI and `containers/.secrets/` have no search settings. Choose keyless Exa, Exa with an API key, Brave, Tavily, an external SearXNG instance, or Off. Existing provider combinations can be retained with **Keep current providers**. Keys are write-only and blank input retains the saved key. SearXNG requires its URL and optionally authentication. Changes apply immediately and persist in the gateway.
