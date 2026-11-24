import { APP_NAME } from "../lib/brand.ts";

export function ReiWordmark() {
  return (
    <span className="inline-flex shrink-0 items-center gap-2.5 text-xl font-semibold leading-none tracking-tight">
      <img src="/rei-icon-192.png" width={32} height={32} alt="" className="rounded-[20%]" />
      <span>{APP_NAME}</span>
    </span>
  );
}
