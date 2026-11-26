import { LibraryError } from "@presenter-garage/node/library";

/**
 * What every tool's answer goes through on its way to the wire, and the
 * hints and limits the tools share, wherever they are registered.
 */

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** How long a person has to read and answer the confirmation: as long as a plan lives. */
export const CONFIRM_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Characters that show as nothing, or as an ordinary space: non-breaking and
 * other Unicode spaces, zero-width characters, bidirectional marks,
 * embeddings and isolates (U+2066-U+2069), the other invisible format
 * controls up to U+206F, the soft hyphen and the byte-order mark.
 */
const INVISIBLE = /[\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g;

/**
 * JSON with every invisible character written as its `\uXXXX` escape.
 *
 * A reader of the text sees `Couplet\u00a01` where a raw non-breaking space
 * would look exactly like `Couplet 1`, and ProPresenter treats the two as
 * different group names. Parsed, the escape is the character itself, so
 * nothing is lost: a name or a line handed back reads exactly as stored.
 * Safe to do to the whole text because those characters can only be inside
 * a JSON string, where an escape means the same thing.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value).replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Wrap a tool's answer for the wire.
 *
 * A `LibraryError` is something the model can act on -- a wrong path, a file
 * that is a chord chart -- so it goes back as a tool error rather than a
 * protocol failure, which a client may show to nobody.
 */
export async function answer(run: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: toJson(await run()) }] };
  } catch (e) {
    if (!(e instanceof LibraryError)) throw e;
    return { isError: true, content: [{ type: "text" as const, text: e.message }] };
  }
}
