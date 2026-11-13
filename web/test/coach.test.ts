// Facts parity with Python, the verifier's rules, and the agent loop
// (tools, citations and the repair turn) with a fake client: no API calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { runCoach, type CoachClient } from "../src/browser/coach";
import type { GameAnalysis, MoveRow } from "../src/browser/engine";
import { buildFacts, verify } from "../src/browser/facts";
import type { Game } from "../src/browser/games";
import { playerRisk, type Row } from "../src/browser/model";
import { withExpected } from "../src/browser/stats";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("opening facts match Python exactly (300 games)", () => {
  const fx = load("parity.json");
  const facts = buildFacts(withExpected(fx.games as Game[]), null, null);
  assert.deepEqual(facts.map(f => [f.id, f.text]), fx.facts.map((f: any) => [f.id, f.text]));
});

test("engine, model and blunder facts match Python exactly (real analysed games)", () => {
  const fx = load("model.json");
  const games = withExpected(fx.games as Game[]);
  const byUrl = new Map<string, MoveRow[]>();
  for (const r of fx.rows as Row[]) (byUrl.get(r.url) ?? byUrl.set(r.url, []).get(r.url)!).push(r);
  const analyses: GameAnalysis[] = games.map(g => ({
    url: g.url, color: g.color, moves: byUrl.get(g.url) ?? [], opening_eval: fx.opening_eval[g.url],
  }));
  const facts = buildFacts(games, analyses, playerRisk(fx.rows));
  assert.deepEqual(facts.map(f => [f.id, f.text]), fx.facts.map((f: any) => [f.id, f.text]));
});

// ---------- verifier (same cases as tests/test_core.py) ----------

const FACTS = [
  { id: "F1", text: "Sicilian Defense as White: 12 games, scored 31% versus 50% expected." },
  { id: "F2", text: "Your move 23.Qxd5 (middlegame) lost 45 win%; the engine preferred Rd1. Game: https://www.chess.com/game/live/1" },
];

test("verifier accepts a grounded report", () => {
  const v = verify("You score 31% against an expected 50% in the Sicilian [F1]. On 23.Qxd5 you lost 45 win%; Rd1 was better [F2].", FACTS);
  assert.ok(v.ok, JSON.stringify(v.unsupported));
});

test("verifier catches invented numbers and moves", () => {
  const v = verify("You score 28% in the Sicilian [F1]. Next time play 23.Nf3 [F2].", FACTS);
  const kinds = new Set(v.unsupported.map(u => `${u.type}:${u.claim}`));
  assert.ok(kinds.has("number:28") && kinds.has("move:Nf3") && !v.ok, [...kinds].join(" "));
});

test("verifier rejects a number borrowed from another fact, ignores list markers", () => {
  assert.equal(verify("Do 12 puzzles a day [F2].", FACTS).unsupported[0].type, "miscited number");
  assert.ok(verify("**1. Sicilian Defense.** You score 31% [F1].", FACTS).ok);
});

test("verifier: bad citations, unknown links, punctuation after links", () => {
  const v = verify("See https://example.com/x for more [F9].", FACTS);
  assert.deepEqual(v.bad_citations, ["F9"]);
  assert.ok(v.unsupported.some(u => u.type === "url"));
  const t = [{ id: "T1", text: "- https://www.chess.com/game/live/42: you lost" }];
  assert.ok(verify("Replay https://www.chess.com/game/live/42, then review it [T1].", t).ok);
});

// ---------- agent loop ----------

test("agent loop: tool call, citation of the tool result, and a repair turn", async () => {
  const fx = load("parity.json");
  const games = withExpected(fx.games as Game[]);
  const calls: Record<string, any>[] = [];
  const usage = { input_tokens: 10, output_tokens: 5 };
  const client: CoachClient = { beta: { messages: { create: async (p: Record<string, any>) => {
    calls.push(p);
    if (calls.length === 1) return { stop_reason: "tool_use", usage, content: [
      { type: "tool_use", id: "tu1", name: "example_games", input: { family: "Scotch Game", color: "black", k: 2 } }] };
    if (calls.length === 2) {
      const last = p.messages[p.messages.length - 1].content[0];
      assert.equal(last.type, "tool_result"); assert.equal(last.is_error, false);
      assert.match(last.content, /^\[T1\]\nWorst Scotch Game games as black:/);
      return { stop_reason: "end_turn", usage, content: [{ type: "text", text: "You lost 99 Scotch games [T1]." }] };
    }
    const fixMsg = p.messages[p.messages.length - 1].content;
    assert.match(fixMsg, /number '99'/);
    return { stop_reason: "end_turn", usage, content: [{ type: "text", text: "Your Scotch record as Black is weak; review these games [T1]." }] };
  } } } };
  const res = await runCoach({ client, username: "someone", facts: buildFacts(games, null, null),
                               games, moves: [], engineUrl: "unused" });
  assert.equal(res.tool_calls[0].name, "example_games");
  assert.ok(!res.first_verification.ok);
  assert.ok(res.repaired && res.verification.ok);
  assert.equal(calls[0].model, "claude-haiku-5-5");
  assert.equal(calls[0].fallbacks, undefined);   // Haiku 5.5 has no server-side refusal fallback
  assert.deepEqual(res.usage, { input_tokens: 30, output_tokens: 15 });
});

test("agent loop: SQL tool rejects writes before touching the database", async () => {
  const { ToolBox } = await import("../src/browser/tools");
  const box = new ToolBox([], [], [], "unused");
  const r = await box.run("run_sql", { query: "DROP TABLE games" });
  assert.ok(r.isError && /only SELECT/.test(r.out));
});

test("half-way values round like Python (to even)", async () => {
  const { pyRound } = await import("../src/browser/facts");
  assert.deepEqual([36.5, 37.5, 22.5, 20.5, -0.5, 2.4, 2.6].map(pyRound), [36, 38, 22, 20, -0, 2, 3]);
});
