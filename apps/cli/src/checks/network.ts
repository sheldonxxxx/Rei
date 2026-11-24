// Network isolation (D30), seen from inside: the control plane has no way to the internet, the gateway and the egress proxy do.
// (exec is covered by smoke-exec.sh.) The probe prints one word, so a container that cannot run it is told apart from one that is cut off.

import type { Ctx } from "../ctx.ts";
import { composeFor, ps, running } from "../ctx.ts";
import type { CheckResult, Row } from "../format.ts";
import { fail, ok, row, skip, warn } from "../format.ts";

const PROBE =
  'fetch("https://example.com",{method:"HEAD",signal:AbortSignal.timeout(5000)}).then(()=>console.log("reached"),()=>console.log("blocked"))';

async function probe(ctx: Ctx, service: string): Promise<"reached" | "blocked" | "unknown"> {
  const r = await composeFor(ctx, service).exec(service, ["node", "-e", PROBE], { timeoutMs: 20_000 });
  const word = r.stdout.trim();
  return r.code === 0 && (word === "reached" || word === "blocked") ? word : "unknown";
}

export async function networkRows(ctx: Ctx): Promise<Row[]> {
  const up = await ps(ctx).catch(() => []);
  const one = async (service: string, wantOut: boolean): Promise<Row> => {
    const id = `network:${service}`;
    const title = `network: ${service}`;
    if (!running(up, service)) return row(id, title, skip(`${service} not running`));
    const seen = await probe(ctx, service);
    let result: CheckResult;
    if (seen === "unknown")
      result = warn(
        "could not run the probe in the container",
        `see ${composeFor(ctx, service).command(`logs ${service}`)}`,
      );
    else if (!wantOut)
      result =
        seen === "blocked"
          ? ok("no route to the internet, as designed")
          : fail(
              "reached the internet, which it must not",
              `check the networks of ${service} in containers/compose.yaml (it should be on internal networks only)`,
            );
    else
      result =
        seen === "reached"
          ? ok("reaches the internet")
          : warn(
              "cannot reach the internet (offline?)",
              `check this machine's connection; ${service} needs it for ${service === "gateway" ? "the model and web search" : "the hosts you approve"}`,
            );
    return row(id, title, result);
  };
  return Promise.all([one("control", false), one("gateway", true), one("egress", true)]);
}
