import type { IconName } from "../Icon.tsx";
import { Icon } from "../Icon.tsx";
import { UiFrame } from "./shared.tsx";
import type { TimelineItem, TimelineKind, TimelineProps } from "./types.ts";

const KIND_ICON: Record<TimelineKind, IconName> = {
  flight: "flight",
  train: "train",
  bus: "bus",
  car: "car",
  hotel: "hotel",
  meal: "meal",
  activity: "activity",
  meeting: "meeting",
  other: "pin",
};

/** "Tue, 3 Nov" in the viewer's locale; the date is a calendar day, so it is built locally (no time-zone shift). */
export function dateHeading(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Consecutive items with the same date go under one heading; an item without a date stays with the one before it. */
export function groupByDate(items: TimelineItem[]): { date: string | undefined; items: TimelineItem[] }[] {
  const groups: { date: string | undefined; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && (item.date === undefined || item.date === last.date)) last.items.push(item);
    else groups.push({ date: item.date, items: [item] });
  }
  return groups;
}

export function TimelineView({ props }: { props: TimelineProps }) {
  return (
    <UiFrame kind="timeline" title={props.title}>
      {groupByDate(props.items).map((g, gi) => (
        <div key={gi} className="ui-day">
          {g.date && <h5 className="ui-day-h">{dateHeading(g.date)}</h5>}
          <ol className="ui-steps">
            {g.items.map((it, i) => (
              <li key={i} className="ui-step" data-kind={it.kind ?? "other"}>
                <span className="ui-step-icon" aria-hidden="true">
                  <Icon name={KIND_ICON[it.kind ?? "other"]} size={16} />
                </span>
                <div className="ui-step-main">
                  <p className="ui-step-title">
                    {it.time && <span className="ui-time">{it.time}</span>}
                    <span>{it.title}</span>
                    {it.kind && it.kind !== "other" && <span className="sr-only"> ({it.kind})</span>}
                  </p>
                  {it.detail && <p className="ui-sub">{it.detail}</p>}
                  {it.location && (
                    <p className="ui-loc">
                      <Icon name="mapPin" size={13} />
                      <span>{it.location}</span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </UiFrame>
  );
}
