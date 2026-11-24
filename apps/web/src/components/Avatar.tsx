import { BotAvatar, botIdOf } from "./BotAvatar.tsx";

const IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** The first two letters or emoji (a family emoji is one). */
function badgeText(value: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const parts = Segmenter
    ? [...new Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((s) => s.segment)
    : Array.from(value);
  return parts.slice(0, 2);
}

/**
 * An agent's look (Agent.avatar): a built-in bot (`bot:<id>`, an unknown id shows the first), your own picture (a
 * `data:image` URL) or a short text or emoji badge. `working` animates a bot.
 */
export function Avatar({
  value,
  label,
  size = 36,
  working = false,
}: {
  value: string;
  label?: string;
  size?: number;
  working?: boolean;
}) {
  const a11y = label ? ({ role: "img", "aria-label": label } as const) : ({ "aria-hidden": true } as const);
  const box = { width: size, height: size };

  if (value.startsWith("data:")) {
    if (IMAGE.test(value))
      return (
        <img
          className="avatar avatar-img"
          src={value}
          alt={label ?? ""}
          style={box}
          draggable={false}
          {...(label ? {} : { "aria-hidden": true })}
        />
      );
    return (
      <span className="avatar avatar-bot" style={box} {...a11y}>
        <BotAvatar id={botIdOf("")} working={working} />
      </span>
    );
  }
  if (value.startsWith("bot:")) {
    return (
      <span className="avatar avatar-bot" style={box} {...a11y}>
        <BotAvatar id={botIdOf(value)} working={working} />
      </span>
    );
  }
  const text = badgeText(value);
  return (
    <span className="avatar" style={{ ...box, fontSize: Math.round(size * (text.length > 1 ? 0.42 : 0.5)) }} {...a11y}>
      {text.join("")}
    </span>
  );
}
