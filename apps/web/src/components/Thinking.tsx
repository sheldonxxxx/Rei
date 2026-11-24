const DOT = "size-[6px] rounded-full bg-muted-foreground animate-[thinking-dot_1.2s_ease-in-out_infinite]";

/** Three bouncing dots: the assistant has started and nothing has streamed yet. */
export function Thinking() {
  return (
    <p className="thinking my-0 flex h-4 items-center gap-1.5" role="status" aria-label="Thinking">
      <span className={DOT} />
      <span className={`${DOT} [animation-delay:0.15s]`} />
      <span className={`${DOT} [animation-delay:0.3s]`} />
    </p>
  );
}
