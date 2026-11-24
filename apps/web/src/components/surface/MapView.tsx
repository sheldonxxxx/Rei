import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { layoutMap, osmLink, tileUrl } from "../../lib/mapMath.ts";
import { Icon } from "../Icon.tsx";
import { Tip } from "../Tip.tsx";
import { UiFrame } from "./shared.tsx";
import type { MapProps } from "./types.ts";

const HEIGHT = 240;
const FALLBACK_WIDTH = 320;

/** A static map: OpenStreetMap tiles (loaded straight from OSM) fitted to the places, numbered markers, and the places listed below. */
export function MapView({ props }: { props: MapProps }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && setWidth(Math.round(el.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => layoutMap(props.places, width, HEIGHT), [props.places, width]);
  return (
    <UiFrame kind="map" title={props.title}>
      <div ref={box} className="ui-map" style={{ height: HEIGHT }}>
        {layout.tiles.map((t) => (
          <img
            key={`${t.z}/${t.x}/${t.y}/${t.left}`}
            className="ui-tile"
            src={tileUrl(t)}
            alt=""
            width={256}
            height={256}
            draggable={false}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            style={{ left: t.left, top: t.top }}
          />
        ))}
        {layout.markers.map((m, i) => (
          <Tip key={i} label={`Place ${i + 1}: ${props.places[i]!.name}`}>
            <Button
              variant="ghost"
              key={i}
              type="button"
              className="ui-marker"
              data-active={active === i ? "true" : undefined}
              style={{ left: m.left, top: m.top }}
              aria-label={`Place ${i + 1}: ${props.places[i]!.name}`}
              aria-pressed={active === i}
              onClick={() => setActive((a) => (a === i ? null : i))}
            >
              {i + 1}
            </Button>
          </Tip>
        ))}
        <a
          className="ui-attrib"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
        >
          © OpenStreetMap contributors
        </a>
      </div>
      <ol className="ui-places">
        {props.places.map((p, i) => (
          <li key={i} className="ui-place" data-active={active === i ? "true" : undefined}>
            <span className="ui-pin" aria-hidden="true">
              {i + 1}
            </span>
            <div className="ui-place-main">
              <p className="ui-row-title">{p.name}</p>
              {p.note && <p className="ui-sub">{p.note}</p>}
              <a className="card-link" href={osmLink(p.lat, p.lon)} target="_blank" rel="noopener noreferrer">
                Open in Maps
                <Icon name="external" size={14} />
                <span className="sr-only"> ({p.name})</span>
              </a>
            </div>
          </li>
        ))}
      </ol>
    </UiFrame>
  );
}
