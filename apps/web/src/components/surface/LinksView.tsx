import { Icon } from "../Icon.tsx";
import { hostOf, safeUrl, UiFrame } from "./shared.tsx";
import type { LinksProps } from "./types.ts";
import { UiImage } from "./UiImage.tsx";

/** Sources and link previews: title, site, two lines of description, an optional thumbnail. No favicon is fetched. */
export function LinksView({ props }: { props: LinksProps }) {
  return (
    <UiFrame kind="links" title={props.title}>
      <ul className="ui-rows ui-links">
        {props.links.map((l, i) => {
          const href = safeUrl(l.url);
          return (
            <li key={i} className="ui-row">
              {l.image && <UiImage url={l.image} className="ui-thumb" />}
              <div className="ui-row-main">
                {href ? (
                  <a className="ui-link-title" href={href} target="_blank" rel="noopener noreferrer nofollow">
                    {l.title}
                    <Icon name="external" size={13} />
                  </a>
                ) : (
                  <p className="ui-row-title">{l.title}</p>
                )}
                <p className="ui-site">{l.site || hostOf(l.url)}</p>
                {l.description && <p className="ui-desc">{l.description}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </UiFrame>
  );
}
