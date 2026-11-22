import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  createNeuralFindRate, encodeNeuralBoard, encodeNeuralInputs, type FindRateContext, type NeuralFindRateWeights,
} from "../src/browser/neuralFindRate";

test("the mover's home rank comes first and a pinned pawn still attacks", () => {
  const black = encodeNeuralBoard("4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1", "e4d3")!;
  assert.equal(black[0 * 64 + 36], 1); // black pawn on e4 maps to e5
  assert.equal(black[12 * 64 + 36], 1);
  assert.equal(black[13 * 64 + 43], 1); // d3 maps to d6
  assert.equal(black[20 * 64 + 43], 1);
  const pinned = encodeNeuralBoard("k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "Kd2")!;
  assert.equal(pinned[14 * 64 + 43], 1);
  assert.equal(pinned[20 * 64 + 43], 0);
});

test("invalid positions, null moves and invalid promotions give no neural input", () => {
  const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
  assert.equal(encodeNeuralBoard("bad fen", "a7a8n"), null);
  for (const move of ["--", "a7a8", "e1d2q", "a7a5"]) assert.equal(encodeNeuralBoard(fen, move), null);
  assert.deepEqual(encodeNeuralBoard(fen, "a7a8n"), encodeNeuralBoard(fen, "a8=N"));
});

const parity = process.env.NEURAL_FIND_RATE_PARITY;
test("TypeScript matches the Python board and scalar inputs and int8 ONNX prediction", { skip: !parity }, () => {
  const model = JSON.parse(readFileSync(join(dirname(parity!), "weights.json"), "utf8")) as NeuralFindRateWeights;
  const predict = createNeuralFindRate(model);
  const rows = JSON.parse(readFileSync(parity!, "utf8")) as
    { fen: string; best: string; context: FindRateContext; board: string; scalars: number[]; probability: number }[];
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const reason = `${row.fen} ${row.best}`;
    const input = encodeNeuralInputs(row.fen, row.best, row.context, model);
    assert.ok(input, reason);
    assert.deepEqual(input.board, Float32Array.from(Buffer.from(row.board, "base64")), reason);
    assert.deepEqual(Array.from(input.scalars), row.scalars, reason);
    const p = predict(row.fen, row.best, row.context);
    assert.ok(p !== null && Math.abs(p - row.probability) < 0.001, `${reason}: ${p} vs ${row.probability}`);
  }
});
