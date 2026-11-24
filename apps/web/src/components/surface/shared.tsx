import type { ReactNode } from "react";

/** The model wrote these; only http(s) addresses become links (the server checked, this is the second lock). */
export function safeUrl(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export type ViewKind = "table" | "timeline" | "map" | "chart" | "gallery" | "links" | "progress" | "steps" | "form";

/** The box every component sits in: a titled section. */
export function UiFrame({
  kind,
  title,
  children,
}: {
  kind: ViewKind;
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className={`ui-block ui-${kind}`} aria-label={title || kind} data-component={kind}>
      {title && <h4 className="ui-title">{title}</h4>}
      {children}
    </section>
  );
}

export function ExternalLink({
  href,
  children,
  className = "card-link",
}: {
  href: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  const safe = safeUrl(href);
  if (!safe) return <>{children}</>;
  return (
    <a className={className} href={safe} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}
