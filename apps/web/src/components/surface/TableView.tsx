import { useId, useMemo, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Icon } from "../Icon.tsx";
import { Tip } from "../Tip.tsx";
import { UiFrame } from "./shared.tsx";
import type { TableProps } from "./types.ts";

const COLLAPSED_ROWS = 10;
type Cell = string | number | null | undefined;
type Sort = { key: string; dir: 1 | -1 } | null;

const compare = (a: Cell, b: Cell): number => {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};

/**
 * Rows under named columns. With `sortable`, `filterable` or `pageSize` the reader sorts, filters and pages locally; the
 * agent is never asked. Without a page size, long tables collapse to ten rows with "Show all".
 */
export function TableView({ props }: { props: TableProps }) {
  const [all, setAll] = useState(false);
  const [sort, setSort] = useState<Sort>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const bodyId = useId();
  const { columns, rows } = props;

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const kept = q
      ? rows.filter((r) =>
          columns.some((c) =>
            String(r[c.key] ?? "")
              .toLowerCase()
              .includes(q),
          ),
        )
      : rows;
    if (!sort) return kept;
    return [...kept].sort((a, b) => compare(a[sort.key], b[sort.key]) * sort.dir);
  }, [rows, columns, filter, sort]);

  const pageSize = props.pageSize;
  const pages = pageSize ? Math.max(1, Math.ceil(visible.length / pageSize)) : 1;
  const current = Math.min(page, pages - 1);
  const shown = pageSize
    ? visible.slice(current * pageSize, (current + 1) * pageSize)
    : all
      ? visible
      : visible.slice(0, COLLAPSED_ROWS);

  // A column of numbers lines up at the end unless the agent said otherwise.
  const align = (c: TableProps["columns"][number]): "left" | "center" | "right" => {
    if (c.align === "center") return "center";
    if (c.align === "end") return "right";
    if (c.align === "start") return "left";
    return rows.some((r) => r[c.key] !== undefined && r[c.key] !== null) &&
      rows.every((r) => r[c.key] === undefined || r[c.key] === null || typeof r[c.key] === "number")
      ? "right"
      : "left";
  };
  const sortBy = (key: string) => {
    setSort((s) => (s?.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));
    setPage(0);
  };

  return (
    <UiFrame kind="table" title={props.title}>
      {props.filterable && (
        <div className="ui-table-tools">
          <Icon name="search" size={14} />
          <Input
            type="search"
            className="h-8"
            value={filter}
            placeholder="Filter rows"
            aria-label={props.title ? `Filter ${props.title}` : "Filter rows"}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
          />
          {filter && (
            <span className="ui-sub" role="status">
              {visible.length} of {rows.length}
            </span>
          )}
        </div>
      )}
      <div
        className="ui-table-wrap"
        tabIndex={0}
        role="region"
        aria-label={props.title ? `${props.title}, table` : "Table"}
      >
        <table id={bodyId}>
          <thead>
            <tr>
              {columns.map((c) => {
                const dir = sort?.key === c.key ? sort.dir : 0;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={{ textAlign: align(c) }}
                    aria-sort={dir === 1 ? "ascending" : dir === -1 ? "descending" : undefined}
                  >
                    {props.sortable ? (
                      <button type="button" className="ui-sort" onClick={() => sortBy(c.key)}>
                        {c.label}
                        <Icon
                          name="chevron"
                          size={12}
                          className={dir === 0 ? "opacity-30" : dir === -1 ? "rotate-180" : ""}
                        />
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: align(c) }}>
                    {r[c.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="ui-sub">
                  No rows match.
                </td>
              </tr>
            )}
          </tbody>
          {props.caption && <caption>{props.caption}</caption>}
        </table>
      </div>
      {pageSize && pages > 1 ? (
        <div className="ui-pager">
          <Tip label="Previous page">
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Previous page"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <Icon name="back" size={14} />
            </Button>
          </Tip>
          <span className="ui-sub" aria-live="polite">
            Page {current + 1} of {pages}
          </span>
          <Tip label="Next page">
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Next page"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              <Icon name="forward" size={14} />
            </Button>
          </Tip>
        </div>
      ) : (
        !pageSize &&
        visible.length > COLLAPSED_ROWS && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="more-btn"
            aria-expanded={all}
            aria-controls={bodyId}
            onClick={() => setAll((a) => !a)}
          >
            {all ? "Show fewer" : `Show all ${visible.length}`}
          </Button>
        )
      )}
    </UiFrame>
  );
}
