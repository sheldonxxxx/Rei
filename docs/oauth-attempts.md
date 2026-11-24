# OAuth attempts

A ChatGPT OAuth attempt belongs to the gateway. Leaving provider settings stops the browser observer, not the attempt; returning reads the existing pending attempt and resumes observation. Explicit cancellation and the ten-minute expiry invalidate the attempt.

## Ownership

`useOpenAiOAuth` owns browser attempt state, popup startup, single-request status polling, callback submission, cancellation, and stale-response suppression. Its interface presents attempt state and commands rather than timers or setters. Provider editing, instructions, callback input, provider-list refresh, and error presentation remain in `ProvidersPage`. Settings and onboarding use the same module. Provider-list refresh ignores obsolete responses after unmount or transport replacement and uses the latest onboarding callback.

The popup is opened synchronously inside the user's gesture. If startup fails or the view leaves before its URL arrives, the blank popup closes. A popup already navigated to sign-in remains open when leaving settings. If popups are blocked, the existing sign-in link and callback-paste flow remain available.

Status requests run sequentially, including across replaced attempts. A response from before cancellation, callback submission, an API change, or unmount cannot restore an old URL or pending state, display an obsolete error, or trigger a completion refresh. As before, observing a pending attempt become non-pending refreshes the provider list; the protocol does not distinguish success, external cancellation, and expiry. The module does not invent a success signal.

## Gateway cancellation

`FileProviderManager` reserves an attempt before awaiting saved credentials, preventing concurrent starts. Attempt identity guards protect asynchronous startup, token exchange, verification, queued credential persistence, and terminal state changes. Only one callback exchange can run for an attempt at a time.

Each attempt has an abort controller. Cancellation/expiry aborts token and signing-key requests and passes the same signal into the existing credential store. The store checks it under its lock immediately before the synchronous durable write. A canceled attempt waiting for network or the credential lock cannot later save its credential or replace a newer attempt's state/error. A credential already durably committed before cancellation is not rolled back.

Gateway credential ownership, PKCE/state/nonce checks, issued-client reuse, verified identity tokens, callback URLs, scopes, authentication, and saved provider formats remain unchanged. Cancellation does not remove an existing provider connection or its credentials.

## Verification

Gateway tests pause startup, exchange, and credential persistence to exercise supersession, duplicate callbacks, cancellation, and expiry. Browser module tests use controlled status promises, timers, and popup behavior. View tests retain instructions, editing, and model-scan coverage and verify callback completion refreshes provider metadata and notifies onboarding. Live-browser evidence distinguishes real gateway start/resume/cancel checks from simulated successful callbacks and real-account authorization.

## Live-browser evidence (2026-11-07, local Docker stack)

Real gateway, in the in-app browser: the instructions dialog's Continue started an attempt (pending, `auth.openai.com` URL, popup opened synchronously); a full page reload kept the attempt pending and reopening the provider editor resumed it with the sign-in link and Finish sign-in; Cancel cleared it (status not pending) and left the existing OpenAI connection intact. Not performed: simulated successful callback and real-account authorization, which need a real ChatGPT login.
