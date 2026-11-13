// Run with Cargo on PATH: node web/test/rust-tactics.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tactics.json", import.meta.url), "utf8"));
const manifest = fileURLToPath(new URL("../rust/tactics/Cargo.toml", import.meta.url));
const squares = Array.from({ length: 64 }, (_, i) => "abcdefgh"[i % 8] + (Math.floor(i / 8) + 1));
const indices = new Map(squares.map((square, i) => [square, i]));

const names = ["mate", "backRankMate", "fork", "pin", "skewer", "discoveredAttack", "hangingPiece", "promotion"];
const moves = [];
const expectedMotifs = [];
const boards = [];
const expected = [];
for (const { fen, from, to, promotion, motifs } of fixture.positions) {
  const chess = new Chess(fen);
  for (const afterMove of [false, true]) {
    if (afterMove) chess.move({ from, to, promotion: promotion ?? undefined });
    boards.push(squares.map(square => {
      const piece = chess.get(square);
      if (!piece) return ".";
      return piece.color === "w" ? piece.type.toUpperCase() : piece.type;
    }).join(""));

    const masks = Array(64).fill(0n);
    for (const [i, square] of squares.entries()) {
      const bit = 1n << BigInt(i);
      for (const color of ["w", "b"]) {
        for (const attacker of chess.attackers(square, color)) masks[indices.get(attacker)] |= bit;
      }
    }
    expected.push(masks.map(mask => mask.toString(16).padStart(16, "0")).join(" "));
  }
  moves.push([...boards.slice(-2), indices.get(from), indices.get(to), Number(chess.isCheckmate())].join(" "));
  expectedMotifs.push(motifs);
}

const run = (example, lines) => execFileSync("cargo", ["run", "--quiet", "--locked", "--release",
  "--manifest-path", manifest, "--example", example], {
  encoding: "utf8",
  input: lines.join("\n") + "\n",
  maxBuffer: 10 * 1024 * 1024,
}).trimEnd().split("\n");

const actual = run("attack_masks", boards);
assert.equal(actual.length, expected.length, "board count");
for (const [i, masks] of expected.entries()) {
  assert.equal(actual[i], masks, `fixture ${Math.floor(i / 2)} (${i % 2 ? "after" : "before"} move)`);
}
console.log(`Attack masks match chess.js on ${boards.length} boards (${boards.length * 64} squares).`);

const classified = run("classify_motifs", moves);
assert.equal(classified.length, expectedMotifs.length, "move count");
for (const [i, labels] of expectedMotifs.entries()) {
  const mask = Number(classified[i]);
  assert.deepEqual(names.filter((_, bit) => mask & (1 << bit)).sort(), labels, `fixture ${i}`);
}
console.log(`Rust motif labels match the Python fixture on ${moves.length} moves.`);

execFileSync("cargo", ["build", "--quiet", "--locked", "--release", "--target",
  "wasm32-unknown-unknown", "--manifest-path", manifest]);
const wasm = readFileSync(new URL("../rust/tactics/target/wasm32-unknown-unknown/release/chess_check_tactics.wasm", import.meta.url));
const { instance: { exports: { memory, reserve_records, classify_records } } } = await WebAssembly.instantiate(wasm);
const pointer = reserve_records(moves.length);
const records = new Uint8Array(memory.buffer, pointer, moves.length * 131);
for (const [i, move] of moves.entries()) {
  const [before, after, from, to, mate] = move.split(" ");
  const start = i * 131;
  records.set(Buffer.from((before + after).replaceAll(".", "\0")), start);
  records.set([Number(from), Number(to), Number(mate)], start + 128);
}
classify_records();
assert.deepEqual(Array.from(records.subarray(0, moves.length)), classified.map(Number));
console.log(`Wasm batch results match native Rust on ${moves.length} moves.`);
