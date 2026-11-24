// The static map (no map library): Web Mercator maths, laid out on OpenStreetMap's 256-px tiles.
export const TILE = 256;
export const MAX_ZOOM = 19;
const MAX_LAT = 85.0511287798;

export interface Pt {
  x: number;
  y: number;
}

/** A position on the whole world's pixel grid at `zoom` (0,0 is the top left; the world is 256 * 2^zoom wide). */
export function project(lat: number, lon: number, zoom: number): Pt {
  const scale = TILE * 2 ** zoom;
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const sin = Math.sin((la * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
}

export interface Place {
  lat: number;
  lon: number;
}

export interface MapTile {
  z: number;
  x: number;
  y: number;
  /** Pixel offset of the tile's top left inside the box. */
  left: number;
  top: number;
}
export interface MapLayout {
  zoom: number;
  /** The tiles that cover the box (rows outside the world are left out; columns wrap around). */
  tiles: MapTile[];
  /** One per place, in order, positioned inside the box (may lie outside it only when the places can't fit at any zoom). */
  markers: { left: number; top: number }[];
}

/** The largest zoom (never above `maxZoom`) at which every place fits in the box with `pad` pixels to spare. */
export function fitZoom(places: Place[], width: number, height: number, pad = 22, maxZoom = 16): number {
  if (places.length <= 1 || places.every((p) => p.lat === places[0]!.lat && p.lon === places[0]!.lon)) return 14;
  const w = Math.max(1, width - 2 * pad);
  const h = Math.max(1, height - 2 * pad);
  for (let z = maxZoom; z > 0; z--) {
    const pts = places.map((p) => project(p.lat, p.lon, z));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    if (Math.max(...xs) - Math.min(...xs) <= w && Math.max(...ys) - Math.min(...ys) <= h) return z;
  }
  return 0;
}

/** Zoom, tiles and marker positions for a box of `width` x `height` pixels fitted to `places`. */
export function layoutMap(
  places: Place[],
  width: number,
  height: number,
  opts: { pad?: number; maxZoom?: number } = {},
): MapLayout {
  const zoom = fitZoom(places, width, height, opts.pad, opts.maxZoom);
  const pts = places.map((p) => project(p.lat, p.lon, zoom));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const centre: Pt = pts.length
    ? { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
    : { x: 0, y: 0 };
  const originX = centre.x - width / 2;
  const originY = centre.y - height / 2;
  const n = 2 ** zoom;
  const tiles: MapTile[] = [];
  for (let ty = Math.floor(originY / TILE); ty <= Math.floor((originY + height) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(originX / TILE); tx <= Math.floor((originX + width) / TILE); tx++) {
      tiles.push({
        z: zoom,
        x: ((tx % n) + n) % n,
        y: ty,
        left: Math.round(tx * TILE - originX),
        top: Math.round(ty * TILE - originY),
      });
    }
  }
  return { zoom, tiles, markers: pts.map((p) => ({ left: p.x - originX, top: p.y - originY })) };
}

/** OpenStreetMap's own tile server; the PWA loads tiles straight from it (no referrer sent). */
export const tileUrl = (t: Pick<MapTile, "z" | "x" | "y">) => `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`;

const fix = (n: number) => n.toFixed(5);
/** A plain link to the place on openstreetmap.org. */
export function osmLink(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/?mlat=${fix(lat)}&mlon=${fix(lon)}#map=16/${fix(lat)}/${fix(lon)}`;
}
