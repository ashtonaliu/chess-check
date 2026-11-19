import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chess.js";
import { analyseGames, recheckBlunders, type GameAnalysis, type MoveRow } from "../src/browser/engine";
import { parseGame } from "../src/browser/games";
import { readFileSync } from "node:fs";

test("shallow node counts schedule the longest estimated deep checks first and support old rows", async t => {
  const searched: string[] = [];
  class WorkerStub {
    onmessage?: (message: { data: string }) => void;
    postMessage(command: string) {
      if (command.startsWith("position fen ")) {
        searched.push(command.slice("position fen ".length));
        return;
      }
      queueMicrotask(() => {
        const send = (data: string) => this.onmessage?.({ data });
        if (command === "uci") send("uciok");
        else if (command === "isready") send("readyok");
        else if (command.startsWith("go depth")) {
          send("info depth 7 score cp 0 nodes 120");
          send("info depth 8 score cp 0 nodes 300");
          send("bestmove (none)");
        }
      });
    }
    terminate() {}
  }
  // Node does not normally expose a web Worker, so set the stub for this test file.
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: WorkerStub });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "Worker", original);
    else Reflect.deleteProperty(globalThis, "Worker");
  });
  const raw = JSON.parse(readFileSync(new URL("./fixtures/archive_187138001290.json", import.meta.url), "utf8"));
  const game = parseGame(raw, raw.white.username)!;
  const [shallow] = await analyseGames([game], { depth: 8, engineUrl: "", workers: 1 });
  assert.equal(shallow.moves[0].shallow_nodes, 600);

  const task = (opening: string, ply: number, shallow_nodes?: number): MoveRow => {
    const board = new Chess();
    board.move(opening);
    return { ...shallow.moves[ply], ply, fen: board.fen(), san: "e5", wp_loss: 40, shallow_nodes };
  };
  const analyses: GameAnalysis[] = [{ ...shallow, moves: [
    task("e4", 0, 200), task("d4", 1), task("c4", 2, 1500), task("Nf3", 3, 500),
  ] }];
  searched.length = 0;
  await recheckBlunders(analyses, { engineUrl: "", workers: 1 });
  assert.deepEqual(searched.filter((_, index) => index % 2 === 0),
    [2, 1, 3, 0].map(i => analyses[0].moves[i].fen));
});
