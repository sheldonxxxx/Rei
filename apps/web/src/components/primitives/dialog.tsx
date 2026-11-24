import { cn } from "cn";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";
import { Button } from "@/components/primitives/button";
import { Tip } from "@/components/Tip.tsx";

/** Below 768px a dialog is a sheet at the bottom of the screen: full width, square bottom corners, clear of the home bar. */
export const DIALOG_SHEET =
  "max-md:top-auto max-md:bottom-0 max-md:left-0 max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:pb-[calc(1.5rem+var(--safe-b))] max-md:data-open:slide-in-from-bottom-10 max-md:data-open:zoom-in-100 max-md:data-closed:slide-out-to-bottom-10 max-md:data-closed:zoom-out-100";

/** Width from 768px up: a confirmation, a form or a list, a wide viewer, the file preview. */
export const DIALOG_SIZES = {
  default: "md:max-w-md",
  lg: "md:max-w-xl",
  xl: "md:max-w-4xl",
  full: "md:max-w-[min(1100px,calc(100%-3rem))]",
} as const;

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-40 bg-black/30 duration-(--motion-base) supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  onCloseAutoFocus,
  fallbackFocus,
  children,
  showCloseButton = true,
  size = "default",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  fallbackFocus?: React.RefObject<HTMLElement | null>;
  size?: keyof typeof DIALOG_SIZES;
}) {
  // These dialogs are conditionally mounted, often without a Radix Trigger. Keep their actual opener for focus return.
  const [opener] = React.useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const target = opener?.isConnected ? opener : fallbackFocus?.current;
          if (!event.defaultPrevented && target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
        aria-modal="true"
        className={cn(
          "fixed top-1/2 left-1/2 z-[41] grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 overflow-y-auto rounded-4xl bg-popover p-6 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/5 duration-(--motion-slow) ease-(--motion-ease-in) data-closed:duration-(--motion-exit) data-closed:ease-(--motion-ease-exit) outline-none dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          DIALOG_SIZES[size],
          DIALOG_SHEET,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <Tip label="Close" side="bottom">
            <DialogPrimitive.Close data-slot="dialog-close" asChild>
              <Button variant="ghost" className="absolute top-4 right-4 bg-secondary" size="icon-sm">
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </DialogPrimitive.Close>
          </Tip>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-row justify-end gap-2 max-md:*:flex-1", className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading text-base leading-snug font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
