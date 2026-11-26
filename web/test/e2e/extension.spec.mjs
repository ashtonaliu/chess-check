import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test as base } from "@playwright/test";
import { LIVE_POLL_MS } from "../../src/browser/sites/chesscomPages.ts";
import { chessOrigin, chessGame, chessId, lichessGame, lichessId, serveFixtures } from "./fixtures.mjs";

const test = base.extend({
  session: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), "chess-check-browser-"));
    const fixture = await serveFixtures(dir);
    let context;
    try {
      const extension = process.env.CC_E2E_EXTENSION;
      if (!extension) throw new Error("Run npm run test:e2e to build the extension first.");
      context = await chromium.launchPersistentContext(join(dir, "profile"), {
        channel: "chromium",
        headless: true,
        colorScheme: "light",
        args: [
          "--disable-extensions-except=" + extension,
          "--load-extension=" + extension,
          "--ignore-certificate-errors",
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
          "--proxy-server=http://" + fixture.proxy,
          "--proxy-bypass-list=<-loopback>",
        ],
      });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      await use({ context, worker, fixture, page: context.pages()[0] });
    } finally {
      await context?.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
      expect(fixture.unexpected, "Every external request must match the loopback fixture").toEqual([]);
    }
  },
});

const cube = page => page.locator("button.cube");
const panel = page => page.getByRole("dialog", { name: "Chess Check recap" });
const ready = /\bready\b/;
const onBoard = page => panel(page).getByRole("link", { name: "Find it on the board" });
const archives = fixture => fixture.requests.filter(r => r.host === "api.chess.com");
const exports = fixture => fixture.requests.filter(r => r.path === "/game/export/" + lichessId);
const offscreen = worker => worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }));
const pausedTabs = worker => worker.evaluate(async () =>
  Object.values(await chrome.storage.session.get("analysis-paused-tabs"))[0]?.map(([, state]) => state) ?? []);

async function expectRecap(page, result) {
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator(".recap-head strong")).toHaveText(result);
  await expect(panel(page).locator(".recap-turning .moves").first()).toBeVisible();
}

test("Chess.com confirms a finished game and shows the turning point", async ({ session: { page, fixture } }) => {
  await page.goto(chessGame);
  await expect(cube(page)).toHaveClass(ready);
  await expect(cube(page)).toHaveCSS("background-color", "rgb(47, 122, 79)");
  await cube(page).click();
  await expectRecap(page, /^You won/);
  expect(fixture.requests).toContainEqual({ host: "www.chess.com", path: "/callback/live/game/" + chessId, query: {} });
  await expect.poll(() => archives(fixture).map(r => r.path)).toContainEqual(expect.stringMatching(/\/games\/archives$/));
});

test("Chess.com leaves an unfinished game paused without archives or offscreen analysis", async ({ session: { page, worker, fixture } }) => {
  fixture.chessFinished = false;
  await page.goto(chessGame);
  await expect(cube(page)).not.toHaveClass(ready);
  await cube(page).click();
  await expect(panel(page)).toContainText("Your recap will appear when this game ends.");
  expect(await offscreen(worker)).toHaveLength(0);
  expect(archives(fixture)).toEqual([]);
  expect(fixture.requests.some(r => r.path === "/callback/live/game/" + chessId)).toBe(true);
});

for (const path of ["/play", "/live"]) {
  test("Chess.com " + path + " pauses the finished tab until it closes", async ({ session: { context, worker, page, fixture } }) => {
    // Hold the finished callback long enough to open the other tab, without racing Stockfish.
    const { promise, resolve } = Promise.withResolvers();
    fixture.holdCallback = promise;
    try {
      await page.goto(chessGame);
      await expect.poll(() => fixture.requests.some(r => r.path === "/callback/live/game/" + chessId)).toBe(true);
      const play = await context.newPage();
      await play.goto(chessOrigin + path);
      await expect.poll(() => pausedTabs(worker)).toContainEqual({ key: "play", paused: true });
      await expect(cube(play)).toBeHidden();
      resolve();
      await cube(page).click();
      await expect(panel(page)).toContainText("Recap paused while Play or an unconfirmed game is open.");
      expect(await offscreen(worker)).toHaveLength(0);
      expect(archives(fixture)).toEqual([]);
      await play.close();
      await expect(cube(page)).toHaveClass(ready);
      await expectRecap(page, /^You won/);
    } finally {
      resolve();
    }
  });
}

test("Lichess checks only status until the game finishes", async ({ session: { page, worker, fixture } }) => {
  const finished = fixture.lichessStatus;
  fixture.lichessStatus = "started";
  await page.goto(lichessGame);
  await cube(page).click();
  await expect(panel(page)).toContainText("Your recap will appear when this game ends.");
  expect(await offscreen(worker)).toHaveLength(0);
  const statusChecks = exports(fixture);
  expect(statusChecks.length).toBeGreaterThan(0);
  for (const request of statusChecks) expect(request.query).toMatchObject({ moves: "false", clocks: "false" });
  expect(fixture.requests.some(r => r.path.startsWith("/api/games/"))).toBe(false);

  fixture.lichessStatus = finished;
  await expectRecap(page, /^You (won|lost)/);
  expect(exports(fixture).slice(statusChecks.length, statusChecks.length + 2).map(r => [r.query.moves, r.query.clocks]))
    .toEqual([["false", "false"], ["true", "true"]]);
});

test("Lichess stops checking an aborted game", async ({ session: { page, worker, fixture } }) => {
  fixture.lichessStatus = "aborted";
  await page.goto(lichessGame);
  await cube(page).click();
  await expect(panel(page)).toContainText("This game was aborted.");

  // An absence needs an observation window. Watch through one pending game's poll interval.
  const until = performance.now() + LIVE_POLL_MS + 500;
  await expect.poll(() => exports(fixture).length === 1 && performance.now() >= until,
    { intervals: [250], timeout: 8_000 }).toBe(true);
  expect(exports(fixture)[0].query).toMatchObject({ moves: "false", clocks: "false" });
  expect(await offscreen(worker)).toHaveLength(0);
});

for (const [site, game, result] of [
  ["Lichess", lichessGame, /^You (won|lost)/],
  ["Chess.com", chessGame, /^You won/],
]) {
  test(site + " loads the move in a fresh document and reopens the panel", async ({ session: { page, fixture } }) => {
    await page.goto(game);
    await expect(cube(page)).toHaveClass(ready);
    await cube(page).click();
    await expectRecap(page, result);
    const link = onBoard(page);
    const url = new URL(await link.getAttribute("href"));
    const ply = site === "Lichess" ? url.hash.slice(1) : url.searchParams.get("move");
    expect(ply).toMatch(/^[1-9]\d*$/);
    const loadedAt = await page.evaluate(() => performance.timeOrigin);
    const requests = () => fixture.requests.filter(r => r.path === url.pathname);
    const before = requests().length;
    await link.click();
    await expect.poll(() => page.evaluate(() => performance.timeOrigin)).not.toBe(loadedAt);
    if (site === "Lichess") {
      await expect(page.locator("html")).toHaveAttribute("data-board-ply", ply);
      await expect(page).toHaveURL(game);
    } else {
      await expect(page).toHaveURL(url.toString());
      expect(requests().at(-1).query).toMatchObject({ move: ply });
    }
    expect(requests()).toHaveLength(before + 1);
    await expect(cube(page)).toHaveAttribute("aria-expanded", "true");
    await expectRecap(page, result);
  });
}

for (const [site, game, result] of [
  ["Chess.com", chessGame, /^You won/],
  ["Lichess", lichessGame, /^You (won|lost)/],
]) {
  test(site + " grades a review move played on the board and updates the queue due date", async ({ session: { page, worker } }) => {
    const { Chess } = await import("chess.js");
    await page.goto(game);
    await expect(cube(page)).toHaveClass(ready);
    await cube(page).click();
    await expectRecap(page, result);
    // Wait for the review queue item to be persisted, then make it due now.
    await expect.poll(async () => worker.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return Object.entries(all).some(([k, v]) => k.startsWith("review:") && Array.isArray(v) && v.length > 0);
    })).toBe(true);

    const { key, item } = await worker.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const [k, items] = Object.entries(all).find(([key, v]) => key.startsWith("review:") && Array.isArray(v) && v.length > 0);
      const dueNow = Date.now() - 10_000;
      const updated = items.map((it, idx) => idx === 0 ? { ...it, due: dueNow } : it);
      await chrome.storage.local.set({ [k]: updated });
      return { key: k, item: updated[0] };
    });

    await expect(panel(page).locator(".recap-review button")).toBeVisible();
    await panel(page).locator(".recap-review button").click();
    await expect(onBoard(page)).toBeVisible();
    await onBoard(page).click();

    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveClass(/\bcompact\b/);
    await expect(panel(page)).toContainText("Only your first move is graded.");
    // Compact panel stays off the right-side move list (x = 850).
    const box = await panel(page).boundingBox();
    expect(box.x + box.width).toBeLessThan(850);

    // Compute the board placement after playing the best move and update the site's board DOM.
    const board = new Chess(item.fen);
    const mv = board.move(item.best);
    expect(mv).toBeTruthy();
    const afterPlacement = board.fen().split(" ")[0];
    await page.evaluate(({ siteName, placement }) => {
      const ranks = placement.split("/");
      if (siteName === "Chess.com") {
        const el = document.querySelector("wc-chess-board");
        const divs = [];
        for (let r = 0; r < 8; r++) {
          let f = 0;
          const rankNum = 8 - r;
          for (const ch of ranks[r]) {
            if (ch >= "1" && ch <= "8") { f += Number(ch); continue; }
            const color = ch === ch.toUpperCase() ? "w" : "b";
            divs.push(`<div class="piece ${color}${ch.toLowerCase()} square-${f + 1}${rankNum}"></div>`);
            f++;
          }
        }
        el.innerHTML = divs.join("");
      } else {
        const el = document.querySelector("cg-board");
        const role = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
        const pieces = [];
        for (let r = 0; r < 8; r++) {
          let f = 0;
          for (const ch of ranks[r]) {
            if (ch >= "1" && ch <= "8") { f += Number(ch); continue; }
            const color = ch === ch.toUpperCase() ? "white" : "black";
            pieces.push(`<piece class="${color} ${role[ch.toLowerCase()]}" style="transform: translate(${f * 64}px, ${r * 64}px);"></piece>`);
            f++;
          }
        }
        el.innerHTML = pieces.join("");
      }
    }, { siteName: site, placement: afterPlacement });

    await expect(panel(page)).toContainText("Correct");
    await expect.poll(async () => worker.evaluate(async ({ k, id }) => {
      const items = (await chrome.storage.local.get([k]))[k] ?? [];
      const found = items.find(it => it.id === id);
      return found ? { step: found.step, due: found.due } : null;
    }, { k: key, id: item.id })).toMatchObject({ step: item.step + 1 });

    const afterItem = await worker.evaluate(async ({ k, id }) => {
      const items = (await chrome.storage.local.get([k]))[k] ?? [];
      return items.find(it => it.id === id);
    }, { k: key, id: item.id });
    expect(afterItem.due).toBeGreaterThan(item.due + 24 * 3600 * 1000);
  });
}
