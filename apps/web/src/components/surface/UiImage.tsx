import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Icon } from "../Icon.tsx";
import { Tip } from "../Tip.tsx";

interface Props {
  url: string;
  alt?: string;
  className?: string;
  /** Makes the picture a button (a gallery's thumbnails open the lightbox). */
  onOpen?: () => void;
  openLabel?: string;
}

/** Only https addresses are drawn: an http image would be mixed content (and the page's policy only allows https). */
export const isShowableImage = (url: string) => /^https:\/\//i.test(url);

/**
 * An image a component shows: a plain <img> loaded straight from its https address, lazily, without a referrer. An http
 * address, or one that fails to load, shows a neutral box instead.
 */
export function UiImage({ url, alt = "", className = "", onOpen, openLabel }: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (failed || !isShowableImage(url)) {
    return (
      <div className={`ui-img ${className}`} data-state="error">
        <div
          className="ui-img-broken"
          role="img"
          aria-label={alt ? `Image not available: ${alt}` : "Image not available"}
        >
          <Icon name="image" size={18} />
        </div>
      </div>
    );
  }
  const img = (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
  return (
    <div className={`ui-img ${className}`} data-state="ok">
      {onOpen ? (
        <Tip label={openLabel ?? (alt ? `Open image: ${alt}` : "Open image")}>
          <Button
            variant="ghost"
            type="button"
            className="ui-img-btn block h-full w-full min-h-0 rounded-none border-0 bg-transparent p-0 hover:bg-transparent"
            aria-label={openLabel ?? (alt ? `Open image: ${alt}` : "Open image")}
            onClick={onOpen}
          >
            {img}
          </Button>
        </Tip>
      ) : (
        img
      )}
    </div>
  );
}
