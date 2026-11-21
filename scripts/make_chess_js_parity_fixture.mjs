#!/usr/bin/env node
// Build engine-core/tests/fixtures/chess_js_parity.json using web/'s chess.js.
//
// Each position records its FEN and all sorted legal moves (UCI, SAN, and a lossless
// 64-square diff + FEN-tail diff that reconstructs chess.js's exact FEN after each move).
//
// Usage: node scripts/make_chess_js_parity_fixture.mjs [--limit N]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "../web/node_modules/chess.js/dist/esm/chess.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_FIXTURES = path.join(ROOT, "web", "test", "fixtures");
const OUT_PATH = path.join(ROOT, "engine-core", "tests", "fixtures", "chess_js_parity.json");
const MAX_BYTES = 5_000_000;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const SOURCES = [
  "web/test/fixtures/parity.json",
  "web/test/fixtures/model.json",
  "web/test/fixtures/tactics.json",
  "web/test/fixtures/find_rate.json",
  "web/test/fixtures/archive_187138001290.json",
  "web/test/fixtures/archive_promo.json",
  "web/test/fixtures/archive_promo_capture.json",
];

function parseLimit(argv) {
  const idx = argv.indexOf("--limit");
  if (idx === -1) return 10000;
  const n = Number(argv[idx + 1]);
  if (!Number.isInteger(n) || n < 10000) {
    throw new Error(`--limit must be an integer >= 10000, got ${argv[idx + 1]}`);
  }
  return n;
}

function collectFens() {
  const fens = new Set();

  const addMoves = (moves) => {
    const chess = new Chess();
    fens.add(chess.fen());
    for (const mv of moves) {
      chess.move(mv);
      fens.add(chess.fen());
    }
  };

  // Include archive games first so promotions and capturing promotions are always covered.
  for (const name of [
    "archive_187138001290.json",
    "archive_promo.json",
    "archive_promo_capture.json",
  ]) {
    const arch = JSON.parse(fs.readFileSync(path.join(WEB_FIXTURES, name), "utf8"));
    if (arch.pgn) {
      const chess = new Chess();
      chess.loadPgn(arch.pgn);
      addMoves(chess.history());
    }
  }

  const findRate = JSON.parse(fs.readFileSync(path.join(WEB_FIXTURES, "find_rate.json"), "utf8"));
  for (const item of findRate) {
    const chess = new Chess(item.fen);
    fens.add(chess.fen());
  }

  const tactics = JSON.parse(fs.readFileSync(path.join(WEB_FIXTURES, "tactics.json"), "utf8"));
  for (const item of tactics.positions) {
    const chess = new Chess(item.fen);
    fens.add(chess.fen());
  }
  for (const game of tactics.games) addMoves(game.moves);

  const model = JSON.parse(fs.readFileSync(path.join(WEB_FIXTURES, "model.json"), "utf8"));
  for (const game of model.games) addMoves(game.moves);

  const parity = JSON.parse(fs.readFileSync(path.join(WEB_FIXTURES, "parity.json"), "utf8"));
  for (const game of parity.games) addMoves(game.moves);

  return Array.from(fens);
}

function expandBoard(boardField) {
  const cells = new Array(64);
  let idx = 0;
  for (let i = 0; i < boardField.length; i++) {
    const ch = boardField[i];
    if (ch === "/") continue;
    if (ch >= "1" && ch <= "8") {
      const n = ch.charCodeAt(0) - 48;
      for (let k = 0; k < n; k++) cells[idx++] = ".";
    } else {
      cells[idx++] = ch;
    }
  }
  if (idx !== 64) throw new Error(`Invalid board field: ${boardField}`);
  return cells;
}

function compressBoard(cells) {
  let out = "";
  for (let r = 0; r < 8; r++) {
    if (r > 0) out += "/";
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const ch = cells[r * 8 + f];
      if (ch === ".") {
        empty++;
      } else {
        if (empty > 0) {
          out += String(empty);
          empty = 0;
        }
        out += ch;
      }
    }
    if (empty > 0) out += String(empty);
  }
  return out;
}

function decodeAfterFen(beforeFen, diffStr, flagsStr) {
  const [board, turn, castling, _ep, halfmoveStr, fullmoveStr] = beforeFen.split(" ");
  const cells = expandBoard(board);
  for (let i = 0; i < diffStr.length; i += 2) {
    const sq = B64.indexOf(diffStr[i]);
    if (sq < 0) throw new Error(`Invalid square code: ${diffStr[i]}`);
    cells[sq] = diffStr[i + 1];
  }
  const nextTurn = turn === "w" ? "b" : "w";
  let nextCastling = castling;
  let nextEp = "-";
  let nextHalfmove = Number(halfmoveStr) + 1;
  const nextFullmove = Number(fullmoveStr) + (turn === "b" ? 1 : 0);

  if (flagsStr) {
    for (const token of flagsStr.split(",")) {
      if (token === "0") {
        nextHalfmove = 0;
      } else if (token.startsWith("c")) {
        nextCastling = token.slice(1);
      } else if (token.startsWith("e")) {
        nextEp = token.slice(1);
      } else if (token.startsWith("h")) {
        nextHalfmove = Number(token.slice(1));
      } else {
        throw new Error(`Unknown flag token: ${token}`);
      }
    }
  }

  return `${compressBoard(cells)} ${nextTurn} ${nextCastling} ${nextEp} ${nextHalfmove} ${nextFullmove}`;
}

function buildFixture(fens) {
  const chessJsPkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "web", "node_modules", "chess.js", "package.json"), "utf8"),
  );

  const positions = [];
  let totalMoves = 0;

  for (const fen of fens) {
    const chess = new Chess(fen);
    const [board, turn, castling, _ep, halfmoveStr, fullmoveStr] = fen.split(" ");
    const beforeCells = expandBoard(board);
    const expectedTurn = turn === "w" ? "b" : "w";
    const expectedFullmove = Number(fullmoveStr) + (turn === "b" ? 1 : 0);
    const beforeHalfmove = Number(halfmoveStr);

    const moves = chess
      .moves({ verbose: true })
      .map((m) => ({
        uci: `${m.from}${m.to}${m.promotion || ""}`,
        san: m.san,
        after: m.after,
      }))
      .sort((a, b) => (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0));

    const packedMoves = [];
    for (const mv of moves) {
      const [aBoard, aTurn, aCastling, aEp, aHalfStr, aFullStr] = mv.after.split(" ");
      if (aTurn !== expectedTurn || Number(aFullStr) !== expectedFullmove) {
        throw new Error(`Unexpected turn/fullmove for ${fen} -> ${mv.uci}: ${mv.after}`);
      }
      const afterCells = expandBoard(aBoard);
      let diff = "";
      for (let sq = 0; sq < 64; sq++) {
        if (afterCells[sq] !== beforeCells[sq]) {
          diff += B64[sq] + afterCells[sq];
        }
      }

      const flags = [];
      const aHalf = Number(aHalfStr);
      if (aHalf === 0) {
        flags.push("0");
      } else if (aHalf !== beforeHalfmove + 1) {
        flags.push(`h${aHalf}`);
      }
      if (aCastling !== castling) flags.push(`c${aCastling}`);
      if (aEp !== "-") flags.push(`e${aEp}`);
      const flagsStr = flags.join(",");

      const decoded = decodeAfterFen(fen, diff, flagsStr);
      if (decoded !== mv.after) {
        throw new Error(`Round-trip mismatch for ${fen} ${mv.uci}: ${decoded} !== ${mv.after}`);
      }

      packedMoves.push(flagsStr ? `${mv.uci} ${mv.san} ${diff} ${flagsStr}` : `${mv.uci} ${mv.san} ${diff}`);
      totalMoves += 1;
    }

    positions.push([fen, packedMoves.join(";")]);
  }

  return {
    chess_js_version: chessJsPkg.version,
    sources: SOURCES,
    position_count: positions.length,
    move_count: totalMoves,
    positions,
  };
}

function main() {
  const limit = parseLimit(process.argv.slice(2));
  const fens = collectFens().slice(0, limit);
  const fixture = buildFixture(fens);
  const json = JSON.stringify(fixture);
  const bytes = Buffer.byteLength(json, "utf8");
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, json);
  console.log(
    `Wrote ${OUT_PATH}: ${fixture.position_count} positions, ${fixture.move_count} legal moves, ` +
      `${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes} bytes)`,
  );
  if (bytes >= MAX_BYTES) {
    throw new Error(`Fixture exceeds 5 MB limit (${bytes} bytes >= ${MAX_BYTES})`);
  }
}

main();
