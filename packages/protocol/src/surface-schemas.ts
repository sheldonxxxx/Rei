// The JSON Schema documents surfaces are checked against: the vendored official A2UI v1.0 schemas and Rei's catalog,
// by the URI each `$ref` names. Kept out of the main entry so clients that only draw surfaces do not bundle them.

import reiCatalog from "../catalog/rei-catalog-1.json" with { type: "json" };
import agentToRenderer from "../vendor/a2ui-v1_0/agent_to_renderer.json" with { type: "json" };
import basicCatalog from "../vendor/a2ui-v1_0/basic_catalog.json" with { type: "json" };
import catalogDefinition from "../vendor/a2ui-v1_0/catalog_definition.json" with { type: "json" };
import commonTypes from "../vendor/a2ui-v1_0/common_types.json" with { type: "json" };
import exampleLoginForm from "../vendor/a2ui-v1_0/example_login_form.json" with { type: "json" };
import rendererToAgent from "../vendor/a2ui-v1_0/renderer_to_agent.json" with { type: "json" };

export const A2UI_BASE = "https://a2ui.org/specification/v1_0/";

export const a2uiSchemas = {
  agentToRenderer,
  rendererToAgent,
  commonTypes,
  catalogDefinition,
  basicCatalog,
  exampleLoginForm,
} as const;

/** Rei's catalog in A2UI catalog-definition format. */
export const reiCatalog1 = reiCatalog;
