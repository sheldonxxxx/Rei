# Plugins are optional packages; skills and connectors stand alone

A plugin is an optional, versioned package above skills and connectors, not the container every capability must live in. A skill or connector may have no owning plugin: users and agents create standalone skills and configure standalone connectors without writing a manifest, and a packaged component belongs to exactly one plugin. Installing or enabling a plugin never authorizes anything; agent visibility, approvals and connector revalidation stay with Rei's policy. Agents search for skills and tools; plugin identity is supporting metadata on results, not a result type.

This reverses the Nov 7 2026 change that wrapped every standalone skill and connector in a one-component plugin and merged Settings → Skills and Connectors into the plugins page. The automatic wrapping is removed rather than undone: the change ships on a fresh stack, so there are no auto-created plugins to unwrap.

## Considered Options

- **Everything is a plugin, with one-component plugins hidden in the UI:** rejected. It avoids a migration but keeps a package layer the user never asked for, adds a step for "I just want a skill", and makes ownership and uninstall rules apply to things nobody installed.

## Consequences

Ownership is nullable. Removing or disabling a plugin affects only the components it owns; it never deletes a standalone connector. Settings gains a Capabilities area with Plugins, Skills and Connectors views that show each component's owner and state.
