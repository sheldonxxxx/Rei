# Push goes straight from the owner's server; there is no relay

Rei stays private: loopback, LAN, or a private network the owner sets up, such as Tailscale or their own HTTPS proxy. Rei never exposes itself or depends on a hosted Rei service. Native push is therefore sent directly by the owner's own gateway to APNs and FCM, using credentials the owner configures, as more delivery channels in the existing notification outbox next to Web Push. Payloads carry ids and a short preview, which can be hidden, never full conversation content.

## Considered Options

- **A Rei-hosted push relay holding app credentials:** rejected for now. It is a hosted product with its own uptime and security surface, and it would contradict "Rei never depends on a Rei service".
- **UnifiedPush/ntfy only:** rejected. It has no iOS story.

## Consequences

Whoever builds and signs a native app must provide its APNs key or Firebase project to the server. A store-distributed app shared by many owners would need a relay; that is the condition for revisiting this decision.
