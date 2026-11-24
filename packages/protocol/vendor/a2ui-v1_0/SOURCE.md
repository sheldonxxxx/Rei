# A2UI v1.0 schemas (vendored)

Copied unchanged from [a2ui-project/a2ui](https://github.com/a2ui-project/a2ui) at commit
`58379ad4c7b23289992acea44e99126374e41063` (`specification/v1_0/`), under the Apache License 2.0 in `LICENSE`.

- `agent_to_renderer.json`, `renderer_to_agent.json`, `common_types.json`, `catalog_definition.json`,
  `renderer_capabilities.json`: the protocol.
- `basic_catalog.json`: the basic catalog; Rei's catalog (`../../catalog/rei-catalog-1.json`) copies its layout and
  input components and functions unchanged.
- `example_login_form.json`: an official example, used by the conformance test.

The server validates every surface message against these files (`apps/server/src/surfaces/validate.ts`), with Rei's
catalog registered as `https://a2ui.org/specification/v1_0/catalog.json`. To move to a newer A2UI version, vendor its
files beside these, regenerate the catalog and run the conformance tests (`apps/server/test/surfaces-conformance.test.ts`).
