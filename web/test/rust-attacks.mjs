// Run with Cargo on PATH: node web/test/rust-attacks.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tactics.json", import.meta.url), "utf8"));
const manifest = fileURLToPath(new URL("../rust/tactics/Cargo.toml", import.meta.url));
const squares = Array.from({ length: 64 }, (_, i) => "abcdefgh"[i % 8] + (Math.floor(i / 8) + 1));
const indices = new Map(squares.map((square, i) => [square, i]));

const boards = [];
const expected = [];
for (const { fen, from, to, promotion } of fixture.positions) {
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
}

const actual = execFileSync("cargo", ["run", "--quiet", "--locked", "--release",
  "--manifest-path", manifest, "--example", "attack_masks"], {
  encoding: "utf8",
  input: boards.join("\n") + "\n",
  maxBuffer: 10 * 1024 * 1024,
}).trimEnd().split("\n");

assert.equal(actual.length, expected.length, "board count");
for (const [i, masks] of expected.entries()) {
  assert.equal(actual[i], masks, `fixture ${Math.floor(i / 2)} (${i % 2 ? "after" : "before"} move)`);
}
console.log(`Attack masks match chess.js on ${boards.length} boards (${boards.length * 64} squares).`);
