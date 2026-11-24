// A first name for a device, from what its browser or app says about itself; the user can rename it.
import type { ClientKind } from "@rei/protocol";

const KIND_NAMES: Record<ClientKind, string> = {
  web: "Browser",
  ios: "iPhone or iPad",
  android: "Android device",
  macos: "Mac",
  windows: "Windows PC",
  linux: "Linux computer",
  cli: "Command line",
};

export function deviceLabel(userAgent: string | undefined, kind: ClientKind = "web"): string {
  if (kind !== "web") return KIND_NAMES[kind];
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return os ? `${browser} on ${os}` : browser;
}
