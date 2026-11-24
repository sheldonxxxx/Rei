// Shared by the generators: converts SVG primitives to path data.
export const n = (value) => String(Math.round(Number(value) * 1000) / 1000);

export function shapePath(tag, a) {
  switch (tag) {
    case "path":
      return a.d;
    case "line":
      return `M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`;
    case "polyline":
    case "polygon": {
      const points = a.points
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      let d = `M${n(points[0])} ${n(points[1])}`;
      for (let i = 2; i < points.length; i += 2) d += `L${n(points[i])} ${n(points[i + 1])}`;
      return tag === "polygon" ? `${d}Z` : d;
    }
    case "circle": {
      const [cx, cy, r] = [Number(a.cx), Number(a.cy), Number(a.r)];
      return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`;
    }
    case "ellipse": {
      const [cx, cy, rx, ry] = [Number(a.cx), Number(a.cy), Number(a.rx), Number(a.ry)];
      return `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0Z`;
    }
    case "rect": {
      const [x, y, w, h] = [Number(a.x ?? 0), Number(a.y ?? 0), Number(a.width), Number(a.height)];
      const rx = Math.min(Number(a.rx ?? a.ry ?? 0), w / 2);
      const ry = Math.min(Number(a.ry ?? a.rx ?? 0), h / 2);
      if (!rx && !ry) return `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`;
      return (
        `M${n(x + rx)} ${n(y)}h${n(w - 2 * rx)}a${n(rx)} ${n(ry)} 0 0 1 ${n(rx)} ${n(ry)}v${n(h - 2 * ry)}` +
        `a${n(rx)} ${n(ry)} 0 0 1 ${n(-rx)} ${n(ry)}h${n(-(w - 2 * rx))}a${n(rx)} ${n(ry)} 0 0 1 ${n(-rx)} ${n(-ry)}` +
        `v${n(-(h - 2 * ry))}a${n(rx)} ${n(ry)} 0 0 1 ${n(rx)} ${n(-ry)}Z`
      );
    }
    default:
      throw new Error(`Unsupported SVG element <${tag}>`);
  }
}
