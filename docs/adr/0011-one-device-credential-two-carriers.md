# Every sign-in is a device; cookie and bearer carry the same credential

Each sign-in, from a browser or a native app, creates a device: a named, revocable record with a last-seen time, owning that device's push channels and presence. The browser carries the device's credential as the `rei_session` cookie, guarded by the `x-rei` CSRF header. Native clients carry the same credential as a bearer token, which needs no CSRF header. There is one credential model, not separate web sessions and API keys.

## Considered Options

- **Native clients reuse the cookie through a cookie jar:** rejected. It ties native clients to browser CSRF rules and still leaves no way to see or revoke a device.
- **Separate long-lived API keys for native clients:** rejected. It is a second credential system with its own lifetime, revocation and UI.
