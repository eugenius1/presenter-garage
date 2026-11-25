/**
 * What each tool returns, as plain data.
 *
 * Kept apart from the server so the answers can be tested without a transport,
 * and so the server is left with nothing to do but describe and route. The
 * shapes are for a model to read: addresses (`slideIndex`, `boxIndex`,
 * `lineIndex`) are the same ones the presentation fixer writes back to, so a
 * later write tool can take exactly what these handed out.
 *
 * Slide text is never written here; that is `edits.ts`. The one write is
 * `save_rules`, which writes only `rules.json`, through `saveRules()` in
 * `packages/node`.
 */

export * from "./presentations";
export * from "./rules";
export * from "./playlists";
export * from "./configuration";
export * from "./styles";
