// The compose files name published images, and the build overlays a checkout loads after them build those images from
// source (containers/compose.build.yaml, containers/compose.dodai.build.yaml). A service that runs a Rei image without an
// overlay entry would be pulled in a checkout instead of built, so every one must have it, and the overlays must name
// nothing else.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const containers = fileURLToPath(new URL("../../containers/", import.meta.url));
const read = (name) => parse(readFileSync(join(containers, name), "utf8"), { merge: true });
const REI_IMAGE = /^\$\{REI_IMAGES:-ghcr\.io\/sheldonxxxx\}\/rei-([a-z]+):\$\{REI_VERSION:-dev\}$/;

const projects = [
  { base: "compose.yaml", overlay: "compose.build.yaml" },
  { base: "compose.dodai.yaml", overlay: "compose.dodai.build.yaml" },
];

/** The Rei image each service of a base file runs (by name, e.g. control), for the services that run one. */
function reiServices(base) {
  return Object.entries(base.services).flatMap(([service, spec]) => {
    const match = REI_IMAGE.exec(spec.image ?? "");
    return match ? [[service, match[1]]] : [];
  });
}

describe("compose build overlays", () => {
  for (const { base: baseName, overlay: overlayName } of projects) {
    describe(baseName, () => {
      const base = read(baseName);
      const overlay = read(overlayName);
      const rei = reiServices(base);

      it("has no build entries and names published images", () => {
        for (const [service, spec] of Object.entries(base.services)) expect(spec.build, service).toBeUndefined();
        expect(rei.length).toBeGreaterThan(0);
      });

      it(`gives every Rei-built service an entry in ${overlayName}, tagged <REI_PROJECT or rei>/<name>:dev`, () => {
        for (const [service, name] of rei) {
          expect(overlay.services[service], `${service} is missing from ${overlayName}`).toBeDefined();
          expect(overlay.services[service].image).toBe(`\${REI_PROJECT:-rei}/${name}:dev`);
        }
      });

      it("builds every Rei image it names from a Dockerfile that exists", () => {
        for (const name of new Set(rei.map(([, n]) => n))) {
          const builders = rei.filter(([, n]) => n === name).map(([service]) => overlay.services[service]);
          const builds = builders.filter((spec) => spec.build);
          expect(builds.length, `nothing in ${overlayName} builds ${name}`).toBeGreaterThan(0);
          for (const { build } of builds) {
            const context = join(containers, build.context);
            expect(existsSync(join(context, build.dockerfile ?? "Dockerfile")), `${name}: ${build.dockerfile}`).toBe(
              true,
            );
          }
        }
      });

      it("overrides nothing but those services' image and build", () => {
        const names = new Map(rei);
        for (const [service, spec] of Object.entries(overlay.services)) {
          expect(names.has(service), `${service} in ${overlayName} runs no Rei image in ${baseName}`).toBe(true);
          expect(
            Object.keys(spec).every((key) => key === "image" || key === "build"),
            service,
          ).toBe(true);
        }
      });
    });
  }

  it("names the same images the release workflow publishes", () => {
    const names = new Set(projects.flatMap(({ base }) => reiServices(read(base)).map(([, name]) => name)));
    const release = parse(readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"));
    const published = release.jobs["images-build"].strategy.matrix.image;
    expect([...names].sort()).toEqual([...published].sort());
  });
});
