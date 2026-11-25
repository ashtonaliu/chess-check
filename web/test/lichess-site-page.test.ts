// Tests for Lichess history in ordinary web pages vs the extension, page-level
// queueing and 429 cooldown, Follower/opponentNoteFor, and site-aware coach prompt.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runCoach, systemPrompt, type CoachClient } from "../src/browser/coach";
import { Follower, opponentNoteFor } from "../src/browser/follow";
import type { Game } from "../src/browser/games";
import { lichess, resetLichessPageQueue } from "../src/browser/sites/lichess";

function makeExport(id: string, white = "alice", black = "bob", winner: "white" | "black" = "white", speed = "blitz") {
  return JSON.stringify({
    id,
    variant: "standard",
    speed,
    createdAt: 1_760_000_000_000,
    lastMoveAt: 1_760_000_120_000,
    status: "resign",
    winner,
    moves: "e4 e5 Nf3 Nc6",
    clocks: [18000, 18000, 17900, 17800],
    clock: { initial: 180, increment: 0 },
    opening: { eco: "C44", name: "Italian Game: Classical Variation" },
    players: {
      white: { user: { id: white.toLowerCase(), name: white }, rating: 1500 },
      black: { user: { id: black.toLowerCase(), name: black }, rating: 1500 },
    },
  });
}

test("lichess.history uses chrome.runtime.sendMessage in extension and direct fetch in web pages", async () => {
  const origChrome = (globalThis as Record<string, unknown>).chrome;
  const origFetch = globalThis.fetch;
  try {
    // 1. Extension path (chrome.runtime.id is set)
    const sent: unknown[] = [];
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls++; throw new Error("should not fetch directly in extension"); }) as typeof fetch;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        id: "ext-test-id",
        sendMessage: async (msg: unknown) => {
          sent.push(msg);
          return { status: "history", text: makeExport("ExtGame1") };
        },
      },
    };
    const extGames = await lichess.history("alice", "blitz", 50);
    assert.equal(extGames.length, 1);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(sent, [{ target: "lichess-history", user: "alice", timeClass: "blitz", max: 50 }]);

    // 2. Web page path (no chrome.runtime.id)
    delete (globalThis as Record<string, unknown>).chrome;
    resetLichessPageQueue();
    const seen: { url: URL; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: new URL(String(input)), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(makeExport("WebGame1", "alice", "bob", "white", "correspondence"), { status: 200 });
    }) as typeof fetch;

    const webGames = await lichess.history("alice", "daily", 25);
    assert.equal(webGames.length, 1);
    assert.equal(webGames[0].site, "lichess");
    assert.equal(webGames[0].timeClass, "daily");
    assert.equal(seen.length, 1);
    const { url, headers } = seen[0];
    assert.equal(url.pathname, "/api/games/user/alice");
    assert.equal(url.searchParams.get("max"), "25");
    assert.equal(url.searchParams.get("perfType"), "correspondence");
    assert.equal(url.searchParams.get("ongoing"), "false");
    assert.equal(url.searchParams.get("finished"), "true");
    assert.equal(url.searchParams.get("clocks"), "true");
    assert.equal(url.searchParams.get("opening"), "true");
    assert.equal(headers.Accept, "application/x-ndjson");
  } finally {
    if (origChrome === undefined) delete (globalThis as Record<string, unknown>).chrome;
    else (globalThis as Record<string, unknown>).chrome = origChrome;
    globalThis.fetch = origFetch;
    resetLichessPageQueue();
  }
});

test("web-page Lichess queue runs one request at a time and enforces 60s 429 cooldown", async () => {
  const origChrome = (globalThis as Record<string, unknown>).chrome;
  const origFetch = globalThis.fetch;
  delete (globalThis as Record<string, unknown>).chrome;
  let now = 10_000;
  resetLichessPageQueue(() => now);
  try {
    let active = 0;
    let peak = 0;
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(r => { releaseFirst = r; });

    globalThis.fetch = (async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        if (calls === 1) await firstGate;
        return new Response(makeExport(`SeqGame${calls}`), { status: 200 });
      } finally {
        active--;
      }
    }) as typeof fetch;

    const p1 = lichess.history("alice", "blitz", 10);
    const p2 = lichess.history("alice", "blitz", 10);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(calls, 1, "second request must wait for first");
    releaseFirst();
    const [g1, g2] = await Promise.all([p1, p2]);
    assert.equal(peak, 1);
    assert.equal(g1.length, 1);
    assert.equal(g2.length, 1);

    // 429 fails immediately with no retry and blocks subsequent requests for 60s
    let rateCalls = 0;
    globalThis.fetch = (async () => {
      rateCalls++;
      if (rateCalls === 1) return new Response("", { status: 429 });
      return new Response(makeExport("AfterW88"), { status: 200 });
    }) as typeof fetch;

    await assert.rejects(lichess.history("alice", "blitz", 10), /try again in a minute/i);
    assert.equal(rateCalls, 1);

    now += 30_000;
    await assert.rejects(lichess.history("bob", "blitz", 10), /try again in a minute/i);
    assert.equal(rateCalls, 1);

    now += 31_000;
    const resumed = await lichess.history("alice", "blitz", 10);
    assert.equal(resumed.length, 1);
    assert.equal(rateCalls, 2);
  } finally {
    if (origChrome === undefined) delete (globalThis as Record<string, unknown>).chrome;
    else (globalThis as Record<string, unknown>).chrome = origChrome;
    globalThis.fetch = origFetch;
    resetLichessPageQueue();
  }
});

test("opponentNoteFor and Follower fetch Lichess history via web-page path", async () => {
  const origChrome = (globalThis as Record<string, unknown>).chrome;
  const origFetch = globalThis.fetch;
  delete (globalThis as Record<string, unknown>).chrome;
  resetLichessPageQueue();
  try {
    const oppLines = [
      makeExport("OppGame1", "alice", "bob", "black"),
      makeExport("OppGame2", "charlie", "bob", "black"),
      makeExport("OppGame3", "dave", "bob", "black"),
      makeExport("OppGame4", "erin", "bob", "white"),
      makeExport("OppGame5", "frank", "bob", "black"),
    ].join("\n");
    const fetchedPaths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      fetchedPaths.push(u.pathname);
      return new Response(oppLines, { status: 200 });
    }) as typeof fetch;

    const sampleGame: Game = {
      site: "lichess",
      url: "https://" + "lichess.org/game/Current1",
      color: "white",
      myRating: 1500,
      oppRating: 1500,
      score: 1,
      timeClass: "blitz",
      timeControl: "180+0",
      eco: "C44",
      opening: "Italian Game: Classical Variation",
      family: "Italian Game",
      endTime: 1_760_000_120,
      opponent: "bob",
      result: "win",
      oppResult: "resigned",
      moves: ["e4", "e5", "Nf3", "Nc6"],
      pgn: "",
    };

    const note = await opponentNoteFor(sampleGame, "blitz");
    assert.ok(note && note.includes("bob"), `expected opponent note, got ${note}`);
    assert.equal(fetchedPaths[0], "/api/games/user/bob");

    // Follower reaches Lichess history through the page path
    const recapped: string[] = [];
    const f = new Follower(
      { site: "lichess", username: "alice", timeClass: "blitz", rows: [], openings: [], tactics: null },
      "unused",
      () => {},
      () => {},
    );
    f.recap = async g => { recapped.push(g.url); return {} as never; };
    await f.start();
    f.stop();
    assert.ok(fetchedPaths.includes("/api/games/user/alice"));
    assert.equal(recapped.length, 1);
  } finally {
    if (origChrome === undefined) delete (globalThis as Record<string, unknown>).chrome;
    else (globalThis as Record<string, unknown>).chrome = origChrome;
    globalThis.fetch = origFetch;
    resetLichessPageQueue();
  }
});

test("browser coach system prompt follows the selected site", async () => {
  assert.match(systemPrompt("chesscom"), /Chess\.com/);
  assert.match(systemPrompt("lichess"), /Lichess/);
  assert.doesNotMatch(systemPrompt("lichess"), /Chess\.com/);

  let seenSystem = "";
  const client: CoachClient = {
    beta: {
      messages: {
        create: async params => {
          seenSystem = String(params.system);
          return { stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Clean report." }] };
        },
      },
    },
  };
  await runCoach({ client, username: "alice", facts: [], games: [], moves: [], engineUrl: "unused", site: "lichess" });
  assert.match(seenSystem, /Lichess/);
  assert.doesNotMatch(seenSystem, /Chess\.com/);
});
