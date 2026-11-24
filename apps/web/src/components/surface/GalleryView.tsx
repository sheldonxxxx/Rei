import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/primitives/dialog.tsx";
import { Icon } from "../Icon.tsx";
import { Tip } from "../Tip.tsx";
import { ExternalLink, UiFrame } from "./shared.tsx";
import type { GalleryProps } from "./types.ts";
import { UiImage } from "./UiImage.tsx";

export function GalleryView({ props }: { props: GalleryProps }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <UiFrame kind="gallery" title={props.title}>
      <ul className="ui-grid-imgs">
        {props.images.map((im, i) => (
          <li key={i}>
            <figure className="ui-figure">
              <UiImage
                url={im.url}
                alt={im.caption ?? `Image ${i + 1}`}
                className="ui-tile-img"
                onOpen={() => setOpen(i)}
              />
              {im.caption && <figcaption>{im.caption}</figcaption>}
            </figure>
          </li>
        ))}
      </ul>
      {open !== null && <Lightbox images={props.images} index={open} onMove={setOpen} onClose={() => setOpen(null)} />}
    </UiFrame>
  );
}

function Lightbox({
  images,
  index,
  onMove,
  onClose,
}: {
  images: GalleryProps["images"];
  index: number;
  onMove: (i: number) => void;
  onClose: () => void;
}) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  const im = images[index]!;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") onMove((index + 1) % images.length);
      else if (e.key === "ArrowLeft") onMove((index - 1 + images.length) % images.length);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, images.length, onMove]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="xl"
        showCloseButton={false}
        aria-describedby={undefined}
        className="lightbox gap-3"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          if (e.target instanceof HTMLElement) e.target.focus();
        }}
      >
        <div className="lightbox-bar flex items-center justify-between gap-3">
          <DialogTitle className="lightbox-count text-sm">
            Image {index + 1} of {images.length}
          </DialogTitle>
          <Tip label="Close" shortcut="Esc">
            <Button
              ref={closeBtn}
              type="button"
              variant="secondary"
              size="icon-sm"
              aria-label="Close image"
              onClick={onClose}
            >
              <Icon name="close" size={16} />
            </Button>
          </Tip>
        </div>
        <div className="lightbox-stage flex min-h-0 items-center gap-1.5">
          {images.length > 1 && (
            <Tip label="Previous" side="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="lightbox-nav shrink-0 max-md:size-8"
                aria-label="Previous image"
                onClick={() => onMove((index - 1 + images.length) % images.length)}
              >
                <Icon name="back" />
              </Button>
            </Tip>
          )}
          <UiImage key={im.url} url={im.url} alt={im.caption ?? `Image ${index + 1}`} className="lightbox-img" />
          {images.length > 1 && (
            <Tip label="Next" side="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="lightbox-nav shrink-0 max-md:size-8"
                aria-label="Next image"
                onClick={() => onMove((index + 1) % images.length)}
              >
                <Icon name="forward" />
              </Button>
            </Tip>
          )}
        </div>
        {(im.caption || im.link) && (
          <p className="lightbox-caption m-0 text-center text-sm">
            {im.caption}
            {im.link && (
              <>
                {" "}
                <ExternalLink href={im.link}>
                  Open source
                  <Icon name="external" size={14} />
                </ExternalLink>
              </>
            )}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
