import { AGENT_BOT_AVATARS } from "@rei/protocol";
import type { ReactNode } from "react";

export type BotId = (typeof AGENT_BOT_AVATARS)[number] extends `bot:${infer I}` ? I : never;

export const BOT_NAMES: Record<BotId, string> = {
  sprout: "Bonsai",
  round: "River Stone",
  antenna: "Lantern",
  cat: "Lucky Cat",
  ghost: "Paper Crane",
  astro: "Moon Rabbit",
};

/** The id after `bot:`; an id this app doesn't draw gets the first bot. */
export function botIdOf(value: string): BotId {
  const id = value.replace(/^bot:/, "");
  return id in BOT_NAMES ? (id as BotId) : (AGENT_BOT_AVATARS[0].slice(4) as BotId);
}

// Stored avatar IDs stay stable across revisions of the artwork.
const ART: Record<BotId, ReactNode> = {
  sprout: (
    <>
      <path d="M29 34c7-7 2-11 9-19M33 25l-9-7" className="bot-line bot-strong" />
      <path d="M25 15c0-5 4-8 9-8 3 0 6 2 7 4 6-1 10 2 10 6s-4 6-9 6H27c-6 0-10-1-10-4s4-5 8-4Z" className="bot-main" />
      <path d="M11 27c0-3 4-6 9-6s8 2 9 5c5 0 8 2 8 5s-4 4-8 4H16c-4 0-7-2-7-4 0-2 1-3 2-4Z" className="bot-shade" />
      <path d="m16 38 4 13a6 6 0 0 0 6 5h12a6 6 0 0 0 6-5l4-13Z" className="bot-paper bot-edge" />
      <rect x="14" y="34" width="36" height="6" rx="3" className="bot-shade" />
      <g className="bot-eyes">
        <ellipse className="bot-eye" cx="27" cy="46" rx="1.7" ry="2.2" />
        <ellipse className="bot-eye" cx="37" cy="46" rx="1.7" ry="2.2" />
      </g>
      <path d="M30 50q2 2 4 0" className="bot-line" />
    </>
  ),
  round: (
    <>
      <path d="M21 43c6-3 21-4 29 0 8 4 6 12-3 13l-28 1c-10 0-13-7-8-11 2-2 6-3 10-3Z" className="bot-shade" />
      <path
        d="M25 14c9-2 18 1 22 8 6 8 5 17-1 21-7 5-24 4-31 0-7-4-7-11-3-18 3-6 8-10 13-11Z"
        className="bot-main bot-edge"
      />
      <path d="M17 26c2-4 6-7 10-8M41 23l3 3" className="bot-line bot-light" />
      <g className="bot-eyes">
        <ellipse className="bot-eye" cx="23" cy="33" rx="1.9" ry="2.5" />
        <ellipse className="bot-eye" cx="38" cy="32" rx="1.9" ry="2.5" />
      </g>
      <path d="M28 38q3 2 6-1" className="bot-line" />
    </>
  ),
  antenna: (
    <>
      <path d="M25 15v-3a7 7 0 0 1 14 0v3M32 51v7" className="bot-line bot-strong" />
      <rect x="23" y="13" width="18" height="41" rx="3" className="bot-shade" />
      <path d="M24 18h16c9 1 13 7 13 16s-5 16-13 17H24c-8-1-13-8-13-17s4-15 13-16Z" className="bot-main bot-edge" />
      <path d="M23 21c-7 6-7 21 0 27m18-27c7 6 7 21 0 27M13 28h38M13 40h38" className="bot-line bot-light" />
      <g className="bot-eyes">
        <ellipse className="bot-eye" cx="26" cy="34" rx="1.9" ry="2.4" />
        <ellipse className="bot-eye" cx="38" cy="34" rx="1.9" ry="2.4" />
      </g>
      <path d="M30 38q2 2 4 0" className="bot-line" />
    </>
  ),
  cat: (
    <>
      <path d="M24 38c-6-8-13-10-14-3-1 6 3 11 6 14" className="bot-main bot-edge" />
      <path
        d="M16 55c-2-7 0-15 5-20-4-3-5-8-3-12l-1-11a2 2 0 0 1 3-2l9 7c4-1 8-1 11 0l8-7a2 2 0 0 1 3 2l-1 12c2 5 0 9-4 12 5 5 6 12 4 19-1 3-32 3-34 0Z"
        className="bot-paper bot-edge"
      />
      <path d="M19 37c7 3 19 3 27-1l2 3c-8 5-23 5-30 1Z" className="bot-shade" />
      <ellipse cx="35" cy="47" rx="5.5" ry="7" className="bot-main" />
      <path d="M35 45v4M23 53v2m22-2v2" className="bot-line" />
      <g className="bot-eyes">
        <ellipse className="bot-eye" cx="27" cy="27" rx="1.8" ry="2.3" />
        <ellipse className="bot-eye" cx="41" cy="27" rx="1.8" ry="2.3" />
      </g>
      <path d="M31 31q1.5 2.5 3 0 1.5 2.5 3 0" className="bot-line" />
    </>
  ),
  ghost: (
    <>
      <path d="m12 32 19 9 9-23 4 16 13-7-16 24-15 2Z" className="bot-shade bot-edge" />
      <path d="m12 32-5-17 26 12 7 18-14 8Z" className="bot-paper bot-edge" />
      <path d="m33 27 9-12 8-3 7 4-10 4-7 25Z" className="bot-main bot-edge" />
      <path d="m12 32 28 13-14 8Zm28 13 17-18-16 24Z" className="bot-main" />
      <path d="m12 32 28 13-14 8" className="bot-line bot-fold" />
      <g className="bot-eyes">
        <ellipse className="bot-eye" cx="48.5" cy="15.8" rx="1.5" ry="1.7" />
      </g>
    </>
  ),
  astro: (
    <>
      <path d="M39 7c7 11 2 21-8 24 10 5 23 0 23-11 0-7-5-12-11-14Z" className="bot-main bot-edge" />
      <path
        d="M20 32c-5-6-9-18-5-21 4-4 10 4 14 14-1-9 0-18 5-18 5 1 7 12 5 24 7 2 11 7 11 13 0 9-8 13-20 13-13 0-20-5-20-13 0-6 4-10 10-12Z"
        className="bot-paper bot-edge"
      />
      <path d="M23 27q-4-6-5-11m16 9q2-7 0-13" className="bot-line bot-fold" />
      <g className="bot-eyes">
        <ellipse className="bot-eye" cx="23" cy="42" rx="1.9" ry="2.4" />
        <ellipse className="bot-eye" cx="37" cy="42" rx="1.9" ry="2.4" />
      </g>
      <path d="M27 47q1.5 2.5 3 0 1.5 2.5 3 0" className="bot-line" />
      <path d="M20 50q2 2 4 2m12 0q2 0 4-2" className="bot-line bot-fold" />
    </>
  ),
};

/** One built-in bot, as an SVG that fills its box. `working` makes it bob and look around. */
export function BotAvatar({ id, working = false }: { id: BotId; working?: boolean }) {
  return (
    <svg
      className={`bot bot-${id}`}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      data-bot={id}
      data-working={working ? "true" : undefined}
    >
      <circle cx="32" cy="32" r="32" className="bot-disc" />
      <g className="bot-body">{ART[id]}</g>
    </svg>
  );
}
