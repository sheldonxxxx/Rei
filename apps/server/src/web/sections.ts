// The sections of a stored page (ADR 0020): the reader finds them, the server keeps and shows them.
import type { ReadSection } from "@rei/protocol";

export type Section = ReadSection;

/** The id of the text before the first heading. */
export const TOP_SECTION = "top";
