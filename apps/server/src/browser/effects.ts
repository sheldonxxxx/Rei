// What the model may not do in the browser. Clicks, key presses and form submits are not judged: the user lets the
// agent into a site (and signs in to it, or does not), and trusts it there. The one hard rule is about secrets: passwords,
// one-time codes and card numbers are typed by the user in a takeover, never by the model. A session that holds private
// data is a different guard (opening a page and typing are decided as sends there); it lives in tools.ts.
import type { ElementInfo } from "./driver.ts";

/**
 * Why browser_type refuses a field: passwords, one-time codes and card numbers are for the user to type (a takeover),
 * never the model.
 */
export function fieldRefusal(el: ElementInfo): string | undefined {
  const ac = (el.autocomplete ?? "").toLowerCase();
  const secret =
    el.type === "password" || /one-time-code|current-password|new-password/.test(ac) || /(^|\s)cc-/.test(ac);
  return secret ? "Never type passwords, codes or card numbers: call browser_takeover so the user does it." : undefined;
}
