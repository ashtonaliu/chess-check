// Chess.com game IDs, kept in a module of their own so code that only needs the ID (the extension's
// Chess.com script) does not load the analysis code around it.

/** A Chess.com game's numeric ID, so the same game matches across archive, endpoint and page URLs. */
export const gameId = (url: string) => url.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? url;
