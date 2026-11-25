import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { enginePruneKeys } from "../src/browser/cacheRetention";
import { gameCacheId } from "../src/browser/ids";
import { siteForId } from "../src/browser/sites";
import { gameIdFromPage, pageSafetyKey } from "../src/extension/guard";
import { LichessRequests } from "../src/extension/lichessRequests";
import { afterLookup, markFind } from "../src/extension/panelModel";
import { recapKey } from "../src/extension/storageKeys";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/lichess_parity.json", import.meta.url), "utf8"));
// Finished game: https://lichess.org/game/BYvvanic.
const game = fixture.exports[fixture.expected[0].game_id];
const url = new URL(`https://lichess.org/game/${game.id}`);
const site = siteForId("lichess")!;

test("history and status share a request slot until the response body is consumed", async () => {
  const requested: URL[] = [];
  let stream: ReadableStreamDefaultController;
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  const queue = new LichessRequests(async () => {}, () => 0, async input => {
    requested.push(new URL(String(input)));
    return requested.length === 1 ? new Response(body) : new Response("");
  });
  const first = queue.history({ user: "player", timeClass: "daily", max: 150 });
  const second = queue.history({ user: "opponent", timeClass: null, max: 100 });
  assert.deepEqual(await queue.check(1, game.id), { status: "wait", retryAfterMs: 3000 });
  await setImmediate();
  assert.equal(requested.length, 1);
  assert.equal(requested[0].search, "?max=150&clocks=true&opening=true&ongoing=false&finished=true&perfType=correspondence");
  stream!.close();
  await Promise.all([first, second]);
  assert.equal(requested.length, 2);
});

test("status checks are spaced per tab and a 429 pauses all Lichess requests for a minute", async () => {
  let now = 0, calls = 0, until = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 2) return new Response(null, { status: 429 });
    return Response.json(calls === 3 ? { status: "noStart", id: game.id } : { status: "started" });
  };
  const queue = new LichessRequests(async value => { until = value; }, () => now, fetcher);
  assert.deepEqual(await queue.check(1, game.id), { status: "pending" });
  now = 2999;
  assert.deepEqual(await queue.check(1, game.id), { status: "wait", retryAfterMs: 1 });
  now = 3000;
  assert.deepEqual(await queue.check(1, game.id), { status: "wait", retryAfterMs: 60_000 });
  assert.equal(until, 63_000);
  const restarted = new LichessRequests(async () => {}, () => now, fetcher);
  restarted.restoreCooldown(until);
  now = 62_999;
  assert.deepEqual(await restarted.check(2, game.id), { status: "wait", retryAfterMs: 1 });
  assert.deepEqual(await restarted.history({ user: "player", timeClass: null, max: 50 }), { status: "wait", retryAfterMs: 1 });
  assert.equal(calls, 2);
  now++;
  assert.deepEqual(await restarted.check(2, game.id), { status: "aborted" });
  assert.equal(calls, 3);
});

test("Lichess engine cache entries have their own IDs and participate in pruning", () => {
  const sameId = "12345678";
  const lichess = gameCacheId(`https://lichess.org/game/${sameId}`);
  const chesscom = gameCacheId(`https://www.chess.com/game/live/${sameId}`);
  assert.equal(chesscom, sameId);
  assert.equal(lichess, `lichess:${sameId}`);
  assert.deepEqual(enginePruneKeys([`v1_${chesscom}_d8`, `v1_${lichess}_d8`], new Map(), new Set([lichess]), 1),
    [`v1_${chesscom}_d8`]);
});

test("the panel stops polling an aborted game and stays pending during a cooldown", () => {
  for (const outcome of [
    ["aborted", { next: "aborted" }],
    [{ retryAfterMs: 60_000 }, { next: "pending", delay: 60_000 }],
  ] as const) {
    assert.deepEqual(afterLookup(outcome[0], url.href, null, [], null), outcome[1]);
  }
});

test("a finished Lichess export reaches a complete recap using only the public game ID", async t => {
  const secret = "fake";
  const privateUrl = new URL(url.href + secret);
  const messages: object[] = [];
  let analyzed = 0;
  let checked = 0;
  let now = 0;
  let status = "started";
  const username = game.players.white.user.name;
  const active = { status: "started", get moves() { assert.fail("read active moves"); },
    get clocks() { assert.fail("read active clocks"); }, get id() { assert.fail("read active ID"); } };
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async input => {
    const request = new URL(String(input));
    if (request.pathname.startsWith("/api/games/user/")) return new Response(JSON.stringify(game));
    checked++;
    assert.equal(request.pathname, `/game/export/${game.id}`);
    if (status === "started") {
      assert.equal(request.searchParams.get("moves"), "false");
      assert.equal(request.searchParams.get("clocks"), "false");
      const response = new Response();
      response.json = async () => active;
      return response;
    }
    return Response.json({ ...game, fullId: game.id + secret });
  });

  const tab = { id: 1, url: privateUrl.href };
  const session: Record<string, unknown> = {};
  const extensionUrl = (path: string) => `chrome-extension://test/${path}`;
  type Listener = (msg: object, sender: object, reply: (value: unknown) => void) => boolean;
  const listeners: Listener[] = [];
  const event = { addListener: () => {} };
  const send = (msg: { target: string } & Record<string, unknown>) => new Promise(resolve => {
    messages.push(msg);
    const fromOffscreen = msg.target === "lichess-history" || msg.target === "review-dependencies";
    const sender = fromOffscreen ? { url: extensionUrl("offscreen.html") } : { tab, url: tab.url, frameId: 0 };
    for (const listener of listeners) if (listener(msg, sender, resolve)) return;
    resolve(undefined);
  });
  const globals = {
    chrome: {
      runtime: { sendMessage: send, getURL: extensionUrl, onMessage: { addListener: (fn: Listener) => listeners.push(fn) } },
      storage: { session: { get: async () => session, set: async (value: object) => Object.assign(session, value) },
        local: { get: async () => ({}) } },
      tabs: { query: async () => [tab], onUpdated: event, onRemoved: event, onReplaced: event },
      offscreen: { hasDocument: async () => listeners.length > 1 },
      action: { onClicked: event },
    },
    window: {},
    __lichessEngine: () => { analyzed++; },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  const stubs: Record<string, string> = {
    "../browser/follow": `export const analyzeGame = async game => {
      globalThis.__lichessEngine();
      return { analysis: { url: game.url, color: game.color, moves: [], opening_eval: null }, blunders: [] };
    };`,
    "../browser/pipeline": `export const analyzeInBrowser = async ({ username, site, timeClass, games, signal, prefetchedGames }) => {
      const history = await (prefetchedGames ?? site.history(username, timeClass, games, signal));
      return { username, gameRows: [], openings: [], tactics: null, games: history };
    };`,
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const stub = context.parentURL?.endsWith("/extension/offscreen.ts") && stubs[specifier];
    return stub ? { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true } : next(specifier, context);
  } });
  await import("../src/extension/background");
  const { handle } = await import("../src/extension/offscreen").finally(() => hooks.deregister());

  const id = gameIdFromPage(privateUrl.href)!;
  const safePage = site.publicPageUrl!(privateUrl);
  const signal = new AbortController().signal;
  const recapRequest = { type: "recap", site: "lichess", username, gameId: id } as const;
  const pageKey = pageSafetyKey(safePage);
  const markPage = (finished: boolean) => send({ target: "bg", type: "page-state", pageKey, finished });
  await markPage(false);
  assert.equal(safePage, url.href);
  assert.equal(await site.lookupFinishedPage(id, new URL(safePage), signal), null);
  assert.equal(checked, 1);
  assert.deepEqual(await handle({ ...recapRequest, evidence: active }), { status: "pending" });
  assert.deepEqual(await send({ target: "bg", ...recapRequest }), { status: "paused" });
  assert.equal(analyzed, 0);

  status = game.status; now = 3000;
  const finished = await site.lookupFinishedPage(id, new URL(safePage), signal);
  assert.ok(finished && typeof finished === "object" && "evidence" in finished);
  await markPage(true);
  const request = { target: "bg", ...recapRequest, site: "chesscom", evidence: finished.evidence };
  const stored = new Map<string, string>();
  const board = { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
  const key = recapKey("lichess", username, id);
  markFind(board, gameIdFromPage(site.moveLink(privateUrl.href, 1))!, null, 0);
  assert.deepEqual(JSON.parse([...stored.values()][0]), { game: game.id, item: null, expires: 30_000 });
  assert.equal(key.split("|").at(-1), game.id);
  assert.equal(pageSafetyKey(privateUrl.href), `game:${game.id}`);
  assert.doesNotMatch(JSON.stringify({ request, key, messages, session, markers: [...stored] }), /fake/);
  assert.equal(site.moveLink(privateUrl.href, 0), url.href + "#0");
  assert.equal(site.moveLink(privateUrl.href, 1), url.href + "#1");
  assert.equal(site.isAtPly(new URL(url.href + "#1"), 1), true);
  assert.equal(site.isAtPly(new URL(url.href + "#1"), 2), false);

  try {
    for (let i = 0; i < 30; i++) {
      const reply = await send(request) as Awaited<ReturnType<typeof handle>>;
      if (reply.status === "recap" && !reply.partial) {
        assert.equal(reply.recap.url, url.href);
        assert.equal(reply.games, 50);
        assert.equal(analyzed, 1);
        assert.ok(messages.some(msg => "target" in msg && msg.target === "offscreen" && "site" in msg && msg.site === "lichess"));
        assert.doesNotMatch(JSON.stringify({ messages, session, recap: reply.recap }), /fake/);
        return;
      }
      assert.notEqual(reply.status, "error", JSON.stringify(reply));
      await setImmediate();
    }
    assert.fail("the recap did not complete");
  } finally {
    await handle({ type: "stop" });
  }
});
