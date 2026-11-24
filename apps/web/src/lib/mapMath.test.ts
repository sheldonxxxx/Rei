import { describe, expect, it } from "vitest";
import { fitZoom, layoutMap, osmLink, project, TILE, tileUrl } from "./mapMath.ts";

describe("project", () => {
  it("puts 0,0 in the middle of the world and the antimeridian at the edges", () => {
    expect(project(0, 0, 0)).toEqual({ x: 128, y: 128 });
    expect(project(0, -180, 1).x).toBe(0);
    expect(project(0, 180, 1).x).toBe(512);
  });
  it("doubles with each zoom and clamps the poles", () => {
    const a = project(35.68, 139.76, 5);
    const b = project(35.68, 139.76, 6);
    expect(b.x).toBeCloseTo(a.x * 2, 6);
    expect(b.y).toBeCloseTo(a.y * 2, 6);
    expect(Number.isFinite(project(90, 0, 3).y)).toBe(true);
  });
  it("matches a known tile: Tokyo at zoom 10 is tile 909/403", () => {
    const p = project(35.6762, 139.6503, 10);
    expect(Math.floor(p.x / TILE)).toBe(909);
    expect(Math.floor(p.y / TILE)).toBe(403);
  });
});

describe("fitZoom and layoutMap", () => {
  const tokyo = { lat: 35.6762, lon: 139.6503 };
  const osaka = { lat: 34.6937, lon: 135.5023 };

  it("uses a street-level default for one place", () => {
    expect(fitZoom([tokyo], 320, 240)).toBe(14);
  });

  it("picks the largest zoom at which every place fits with padding", () => {
    const z = fitZoom([tokyo, osaka], 320, 240, 34);
    expect(z).toBeGreaterThan(3);
    const fits = (zoom: number) => {
      const a = project(tokyo.lat, tokyo.lon, zoom);
      const b = project(osaka.lat, osaka.lon, zoom);
      return Math.abs(a.x - b.x) <= 320 - 68 && Math.abs(a.y - b.y) <= 240 - 68;
    };
    expect(fits(z)).toBe(true);
    expect(fits(z + 1)).toBe(false);
  });

  it("centres the places in the box, so markers sit inside it", () => {
    const l = layoutMap([tokyo, osaka], 320, 240);
    for (const m of l.markers) {
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.left).toBeLessThanOrEqual(320);
      expect(m.top).toBeGreaterThanOrEqual(0);
      expect(m.top).toBeLessThanOrEqual(240);
    }
    const mid = (l.markers[0]!.left + l.markers[1]!.left) / 2;
    expect(mid).toBeCloseTo(160, 5);
  });

  it("covers the whole box with tiles whose offsets line up", () => {
    const l = layoutMap([tokyo, osaka], 320, 240);
    expect(l.tiles.length).toBeGreaterThan(0);
    const minLeft = Math.min(...l.tiles.map((t) => t.left));
    const maxLeft = Math.max(...l.tiles.map((t) => t.left));
    const minTop = Math.min(...l.tiles.map((t) => t.top));
    const maxTop = Math.max(...l.tiles.map((t) => t.top));
    expect(minLeft).toBeLessThanOrEqual(0);
    expect(maxLeft + TILE).toBeGreaterThanOrEqual(320);
    expect(minTop).toBeLessThanOrEqual(0);
    expect(maxTop + TILE).toBeGreaterThanOrEqual(240);
    for (const t of l.tiles) expect(t.x).toBeLessThan(2 ** t.z);
  });

  it("wraps tile columns across the antimeridian and drops rows outside the world", () => {
    const l = layoutMap(
      [
        { lat: 0, lon: 179.9 },
        { lat: 0, lon: -179.9 },
      ],
      320,
      240,
      { maxZoom: 3 },
    );
    for (const t of l.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThan(2 ** t.z);
    }
  });

  it("handles identical places and an empty list", () => {
    expect(layoutMap([tokyo, tokyo], 320, 240).zoom).toBe(14);
    expect(layoutMap([], 320, 240).markers).toEqual([]);
  });

  it("builds tile and map links", () => {
    expect(tileUrl({ z: 3, x: 4, y: 5 })).toBe("https://tile.openstreetmap.org/3/4/5.png");
    expect(osmLink(35.1, 139.2)).toBe(
      "https://www.openstreetmap.org/?mlat=35.10000&mlon=139.20000#map=16/35.10000/139.20000",
    );
  });
});
