// The resolved props the catalog views draw: Rei catalog 1 components after their bindings are looked up.

export interface TableProps {
  title?: string | undefined;
  columns: { key: string; label: string; align?: "start" | "center" | "end" | undefined }[];
  rows: Record<string, string | number | null>[];
  caption?: string | undefined;
  sortable?: boolean | undefined;
  filterable?: boolean | undefined;
  pageSize?: number | undefined;
}

export type TimelineKind = "flight" | "train" | "bus" | "car" | "hotel" | "meal" | "activity" | "meeting" | "other";
export interface TimelineItem {
  date?: string;
  time?: string;
  title: string;
  detail?: string;
  location?: string;
  kind?: TimelineKind;
}
export interface TimelineProps {
  title?: string | undefined;
  items: TimelineItem[];
}

export interface MapPlace {
  name: string;
  lat: number;
  lon: number;
  note?: string;
}
export interface MapProps {
  title?: string | undefined;
  places: MapPlace[];
}

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}
export interface ChartProps {
  title?: string | undefined;
  variant: "bar" | "line" | "pie";
  labels: string[];
  series: ChartSeries[];
  unit?: string | undefined;
}

export interface GalleryProps {
  title?: string | undefined;
  images: { url: string; caption?: string; link?: string }[];
}

export interface LinksProps {
  title?: string | undefined;
  links: { url: string; title: string; description?: string; site?: string; image?: string }[];
}
