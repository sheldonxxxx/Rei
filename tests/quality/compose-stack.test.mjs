// The compose files derive every fixed subnet and address from REI_NET and every name another project depends on from
// REI_PROJECT, so a second stack can run beside the first (docs/installation.md, "A second stack on one machine"). With
// neither set they must render exactly the first stack's configuration: the subnets, addresses and network names other
// projects and existing installations depend on. This interpolates the files the way compose does (a pure check, so it
// needs no docker) and reads the result.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const containers = fileURLToPath(new URL("../../containers/", import.meta.url));

/** Compose's interpolation of ${VAR}, ${VAR:-default}, ${VAR-default} and ${VAR:?message}, innermost first. */
function interpolate(text, env) {
  const one = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)([-?])([^${}]*))?\}/;
  let out = text;
  for (let m = one.exec(out); m; m = one.exec(out)) {
    const [whole, name, colon, op, arg] = m;
    const value = env[name];
    const unset = value === undefined || (colon === ":" && value === "");
    let replacement = value ?? "";
    if (op === "-" && unset) replacement = arg;
    if (op === "?" && unset) throw new Error(`${name}: ${arg}`);
    out = out.slice(0, m.index) + replacement + out.slice(m.index + whole.length);
  }
  return out;
}

const SECRETS = Object.fromEntries(
  [
    "REI_STANDIN",
    "REI_EVENTS_KEY",
    "GARAGE_RPC_SECRET",
    "GARAGE_ADMIN_TOKEN",
    "GARAGE_DEFAULT_BUCKET",
    "GARAGE_DEFAULT_ACCESS_KEY",
    "GARAGE_DEFAULT_SECRET_KEY",
    "QDRANT__SERVICE__API_KEY",
  ].map((name) => [name, "x"]),
);
const render = (name, env = {}) =>
  parse(interpolate(readFileSync(join(containers, name), "utf8"), { ...SECRETS, ...env }), { merge: true });

/** The first stack's configuration, as it was before REI_NET and REI_PROJECT existed. */
const FIRST = {
  rei: {
    subnets: {
      internal: ["10.89.231.0/24", "10.89.231.128/25"],
      "browser-net": ["10.89.232.0/24", "10.89.232.128/25"],
    },
    external: { "gateway-admin": "rei-gateway-admin", storage: "rei-storage" },
    addresses: {
      "control internal": "10.89.231.10",
      "control browser-net": "10.89.232.10",
      "egress browser-net": "10.89.232.3",
      "browser browser-net": "10.89.232.2",
    },
    environment: {
      "control REI_HOST": "10.89.231.10",
      "egress EGRESS_BROWSER_LISTEN": "10.89.232.3:3129",
      "egress EGRESS_REFUSE_CIDRS":
        "10.89.231.0/24,10.89.232.0/24,10.89.234.0/24,10.89.235.0/24,10.89.236.0/24,10.89.237.0/24,10.89.238.0/24",
      "browser BROWSER_PROXY": "http://10.89.232.3:3129",
    },
  },
  dodai: {
    names: {
      "gateway-admin": "rei-gateway-admin",
      "gateway-shared": "rei-gateway-shared",
      "reader-internal": "rei-reader-internal",
      storage: "rei-storage",
      "storage-shared": "rei-storage-shared",
    },
    subnets: {
      "gateway-admin": ["10.89.235.0/24", "10.89.235.128/25"],
      "gateway-shared": ["10.89.234.0/24", "10.89.234.128/25"],
      "reader-internal": ["10.89.236.0/24", "10.89.236.128/25"],
      storage: ["10.89.237.0/24", "10.89.237.128/25"],
      "storage-shared": ["10.89.238.0/24", "10.89.238.128/25"],
    },
    addresses: {
      "gateway gateway-admin": "10.89.235.2",
      "gateway gateway-shared": "10.89.234.2",
      "reader reader-internal": "10.89.236.2",
      "garage storage": "10.89.237.2",
      "qdrant storage": "10.89.237.3",
    },
    environment: {
      "gateway GATEWAY_HOST": "10.89.235.2,127.0.0.1",
      "gateway GATEWAY_SHARED_LISTEN": "10.89.234.2:8781",
      "reader READER_HOST": "10.89.236.2",
      "reader READER_REFUSE_CIDRS":
        "10.89.231.0/24,10.89.232.0/24,10.89.233.0/24,10.89.234.0/24,10.89.235.0/24,10.89.236.0/24,10.89.237.0/24,10.89.238.0/24",
    },
  },
};

const subnets = (doc) =>
  Object.fromEntries(
    Object.entries(doc.networks)
      .filter(([, spec]) => spec?.ipam)
      .map(([name, spec]) => [name, [spec.ipam.config[0].subnet, spec.ipam.config[0].ip_range]]),
  );
const addresses = (doc) =>
  Object.fromEntries(
    Object.entries(doc.services).flatMap(([service, spec]) =>
      Array.isArray(spec.networks)
        ? []
        : Object.entries(spec.networks ?? {})
            .filter(([, net]) => net?.ipv4_address)
            .map(([net, { ipv4_address }]) => [`${service} ${net}`, ipv4_address]),
    ),
  );
const environment = (doc, wanted) =>
  Object.fromEntries(
    Object.keys(wanted).map((key) => {
      const [service, name] = key.split(" ");
      return [key, doc.services[service].environment[name]];
    }),
  );
const names = (doc) =>
  Object.fromEntries(
    Object.entries(doc.networks)
      .filter(([, spec]) => spec?.name)
      .map(([key, spec]) => [key, spec.name]),
  );

describe("the compose files with REI_NET and REI_PROJECT unset", () => {
  const rei = render("compose.yaml");
  const dodai = render("compose.dodai.yaml");

  it("keep Rei's subnets, addresses, external network names and address settings", () => {
    expect(subnets(rei)).toEqual(FIRST.rei.subnets);
    expect(names(rei)).toEqual(FIRST.rei.external);
    expect(addresses(rei)).toEqual(FIRST.rei.addresses);
    expect(environment(rei, FIRST.rei.environment)).toEqual(FIRST.rei.environment);
    expect(rei.name).toBe("rei");
  });

  it("keep Dodai's network names, subnets, addresses and address settings", () => {
    expect(names(dodai)).toEqual(FIRST.dodai.names);
    expect(subnets(dodai)).toEqual(FIRST.dodai.subnets);
    expect(addresses(dodai)).toEqual(FIRST.dodai.addresses);
    expect(environment(dodai, FIRST.dodai.environment)).toEqual(FIRST.dodai.environment);
    expect(dodai.services.reader.healthcheck.test.at(-1)).toContain("http://10.89.236.2:8790/healthz");
    expect(dodai.name).toBe("dodai");
  });

  it("keep the build overlays' image names", () => {
    expect(render("compose.build.yaml").services.control.image).toBe("rei/control:dev");
    expect(render("compose.dodai.build.yaml").services.gateway.image).toBe("rei/gateway:dev");
  });
});

describe("the compose files for a second stack", () => {
  const env = { REI_PROJECT: "rei-test", REI_NET: "10.90" };
  const files = ["compose.yaml", "compose.dodai.yaml", "compose.build.yaml", "compose.dodai.build.yaml"];

  it("leave nothing on the first stack's subnets or names", () => {
    for (const file of files) {
      const text = JSON.stringify(render(file, env));
      expect(text, file).not.toContain("10.89.");
      expect(text, file).not.toMatch(/"rei-(gateway-admin|gateway-shared|reader-internal|storage|storage-shared)"/);
      expect(text, file).not.toMatch(/"rei\/[a-z]+:dev"/);
    }
  });

  it("move every subnet, address and name with the two variables", () => {
    const rei = render("compose.yaml", env);
    const dodai = render("compose.dodai.yaml", env);
    expect(subnets(dodai)["storage-shared"]).toEqual(["10.90.238.0/24", "10.90.238.128/25"]);
    expect(addresses(rei)["control internal"]).toBe("10.90.231.10");
    expect(rei.services.control.environment.REI_HOST).toBe("10.90.231.10");
    expect(names(rei)).toEqual({ "gateway-admin": "rei-test-gateway-admin", storage: "rei-test-storage" });
    expect(names(dodai)["gateway-shared"]).toBe("rei-test-gateway-shared");
    expect(dodai.volumes["gateway-data"].name).toBe("rei-test_gateway-data");
    expect(render("compose.build.yaml", env).services.browser.image).toBe("rei-test/browser:dev");
  });
});

describe("the interpolation used here", () => {
  // Compose's own syntax, written as plain strings on purpose.
  const D = "$";
  it("follows compose's rules for defaults, nesting and required variables", () => {
    expect(interpolate(`${D}{A:-x}|${D}{A-y}|${D}{B:-${D}{C:-z}}`, { A: "" })).toBe("x||z");
    expect(interpolate(`${D}{A}`, { A: "1" })).toBe("1");
    expect(() => interpolate(`${D}{A:?run init}`, {})).toThrow("A: run init");
  });
});
