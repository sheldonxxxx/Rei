import { DEFAULT_SEARCH_MODEL } from "@rei/protocol";
import type { SubscriptionSearch } from "../core/search/codex-subscription.ts";
import { ProviderError, parseJson, readLimited, throwForStatus } from "../core/search/common.ts";
import type { TokenSource } from "../core/types.ts";
import type { FileCredentialStore } from "./credstore.ts";

/** Discover an account-advertised model rather than assuming subscription entitlement from a model name. */
export function subscriptionSearch(
  store: FileCredentialStore,
  tokens: TokenSource,
  addSecret: (value: string) => void,
): SubscriptionSearch {
  return {
    configured: async () => (await store.read("openai"))?.type === "oauth",
    async access(signal, requestedModel = DEFAULT_SEARCH_MODEL) {
      const denied = () =>
        new ProviderError(
          "failed",
          "subscription_required",
          "Connect OpenAI using Sign in with ChatGPT to use subscription search.",
        );
      if ((await store.read("openai"))?.type !== "oauth") throw denied();
      let token: string;
      try {
        token = await tokens.accessToken();
      } catch {
        throw new ProviderError(
          "failed",
          "subscription_auth_failed",
          "ChatGPT authentication could not be refreshed. Sign in again.",
        );
      }
      if ((await store.read("openai"))?.type !== "oauth") throw denied();
      addSecret(token);
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${token}` },
        signal,
        redirect: "error",
      });
      throwForStatus(response, "ChatGPT model discovery");
      const body = parseJson(await readLimited(response), "ChatGPT model discovery") as {
        models?: { slug?: unknown; supported_in_api?: unknown; web_search_tool_type?: unknown }[];
      };
      // Only the subscription catalog explicitly advertises native web-search support.
      const model = Array.isArray(body?.models)
        ? body.models.find(
            (entry) =>
              entry.slug === requestedModel &&
              entry.supported_in_api === true &&
              typeof entry.web_search_tool_type === "string" &&
              entry.web_search_tool_type !== "none" &&
              typeof entry.slug === "string" &&
              /^[a-zA-Z0-9._-]{1,100}$/.test(entry.slug),
          )?.slug
        : undefined;
      if (typeof model !== "string")
        throw new ProviderError(
          "failed",
          "subscription_model_unavailable",
          "The selected search model is not available with web search on this ChatGPT account. Choose another search model in Settings.",
        );
      return { token, model };
    },
  };
}
