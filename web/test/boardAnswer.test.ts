import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ALSO_WORKS_MAX_LOSS, formatBoardGrade, gradeEvaluatedMove, isBoardAnswerFound,
  parseFenBoard, resolveBoardMove,
} from "../src/browser/boardMove";
import { openingNames } from "../src/browser/games";
import { reviewRateSentence, type ReviewItem } from "../src/browser/reviewQueue";
import { chesscomPages, readChesscomBoard } from "../src/browser/sites/chesscomPages";
import { lichessPages, readLichessBoard } from "../src/browser/sites/lichessPages";
import { WasmChess } from "../src/browser/wasmChess";
import { BoardWatcher, canWatchBoard } from "../src/extension/boardWatch";
import type { ReviewCard } from "../src/extension/panelModel";

interface FakeEl {
  tag: string;
  attrs: Record<string, string>;
  parentElement: FakeEl | null;
  children: FakeEl[];
  className: string;
  classList: { contains: (cls: string) => boolean };
  getAttribute: (name: string) => string | null;
  closest: (sel: string) => FakeEl | null;
  querySelector: (sel: string) => FakeEl | null;
  querySelectorAll: (sel: string) => FakeEl[];
}

function matchesSelector(el: FakeEl, sel: string): boolean {
  return sel.split(",").some(part => {
    const s = part.trim();
    if (!s) return false;
    if (s.startsWith(".")) return el.classList.contains(s.slice(1));
    return el.tag === s.toLowerCase();
  });
}

function makeEl(tag: string, attrs: Record<string, string>, parent: FakeEl | null): FakeEl {
  const cls = attrs.class ?? "";
  const clsSet = new Set(cls.split(/\s+/).filter(Boolean));
  const el: FakeEl = {
    tag: tag.toLowerCase(),
    attrs,
    parentElement: parent,
    children: [],
    className: cls,
    classList: { contains: c => clsSet.has(c) },
    getAttribute: name => attrs[name] ?? null,
    closest(sel) {
      let cur: FakeEl | null = el;
      while (cur) {
        if (matchesSelector(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] ?? null;
    },
    querySelectorAll(sel) {
      const out: FakeEl[] = [];
      const walk = (node: FakeEl) => {
        for (const child of node.children) {
          if (matchesSelector(child, sel)) out.push(child);
          walk(child);
        }
      };
      walk(el);
      return out;
    },
  };
  return el;
}

function parseHtmlDoc(html: string): Document {
  const root = makeEl("html", {}, null);
  const stack: FakeEl[] = [root];
  const tokenRe = /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)([^>]*)>/g;
  for (const m of html.matchAll(tokenRe)) {
    if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else if (m[2]) {
      const tag = m[2];
      const rawAttrs = m[3] ?? "";
      const attrs: Record<string, string> = {};
      for (const am of rawAttrs.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) attrs[am[1]] = am[2];
      const parent = stack[stack.length - 1];
      const el = makeEl(tag, attrs, parent);
      parent.children.push(el);
      if (!rawAttrs.trim().endsWith("/")) stack.push(el);
    }
  }
  return {
    body: root,
    documentElement: root,
    querySelector: (sel: string) => root.querySelector(sel),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
  } as unknown as Document;
}

let wasmPromise: Promise<WasmChess | null> | undefined;
function loadWasm(): Promise<WasmChess | null> {
  if (!wasmPromise) {
    const assets = new URL("../../extension/engine/", import.meta.url);
    const jsPath = new URL("engine_core.js", assets);
    const wasmPath = new URL("engine_core_bg.wasm", assets);
    wasmPromise = (async () => {
      try {
        const js = readFileSync(jsPath, "utf8");
        const bindings = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
        bindings.initSync({ module: readFileSync(wasmPath) });
        return new WasmChess(bindings);
      } catch {
        return null;
      }
    })();
  }
  return wasmPromise;
}

test("Chess.com board reader parses saved finished-game DOM fixture", () => {
  const html = readFileSync(new URL("./fixtures/chesscom_board.html", import.meta.url), "utf8");
  const reading = readChesscomBoard(parseHtmlDoc(html));
  assert.ok(reading);
  assert.equal(reading.pieces.b6, "wQ");
  assert.equal(reading.pieces.e4, "wP");
  assert.equal(reading.pieces.e5, "bP");
  assert.equal(reading.placement, "rnbqkbnr/pppp1ppp/1Q6/4p3/4P3/8/PPPP1PPP/RNB1KBNR");
});

test("Chess.com board reader returns null while a piece is dragging", () => {
  const html = readFileSync(new URL("./fixtures/chesscom_board.html", import.meta.url), "utf8")
    .replace('class="piece wq square-26"', 'class="piece wq square-26 dragging"');
  assert.equal(readChesscomBoard(parseHtmlDoc(html)), null);
});

test("Lichess board reader parses saved chessground DOM fixture in both orientations", () => {
  const html = readFileSync(new URL("./fixtures/lichess_board.html", import.meta.url), "utf8");
  const white = readLichessBoard(parseHtmlDoc(html));
  assert.ok(white);
  assert.equal(white.pieces.b6, "wQ");
  assert.equal(white.pieces.e4, "wP");
  assert.equal(white.pieces.e5, "bP");
  assert.equal(white.placement, "rnbqkbnr/pppp1ppp/1Q6/4p3/4P3/8/PPPP1PPP/RNB1KBNR");

  const flippedHtml = `<div class="cg-wrap orientation-black"><cg-container style="width: 512px; height: 512px;"><cg-board>
    <piece class="white king" style="transform: translate(192px, 0px);"></piece>
    <piece class="black king" style="transform: translate(448px, 448px);"></piece>
    <piece class="white queen ghost" style="transform: translate(0px, 0px);"></piece>
  </cg-board></cg-container></div>`;
  const black = readLichessBoard(parseHtmlDoc(flippedHtml));
  assert.ok(black);
  assert.deepEqual(black.pieces, { e1: "wK", a8: "bK" });
});

test("position diff resolves normal, capture, castling, en passant, and promotion moves with WasmChess", async () => {
  const wasm = await loadWasm();
  for (const engine of wasm ? [wasm, null] : [null]) {
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const normal = resolveBoardMove(start, parseFenBoard("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"), engine);
    assert.equal(normal?.uci, "e2e4");
    assert.equal(normal?.san, "e4");

    const capStart = "rnbqkbnr/ppp1pppp/8/3p4/3Q4/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1";
    const capture = resolveBoardMove(capStart, parseFenBoard("rnbqkbnr/ppp1pppp/8/3Q4/8/8/PPPPPPPP/RNB1KBNR"), engine);
    assert.equal(capture?.uci, "d4d5");
    assert.equal(capture?.san, "Qxd5");

    const castleStart = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1";
    const afterOO = resolveBoardMove(castleStart, parseFenBoard("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R4RK1"), engine);
    assert.equal(afterOO?.uci, "e1g1");
    assert.equal(afterOO?.san, "O-O");
    const afterOOO = resolveBoardMove(castleStart, parseFenBoard("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/2KR3R"), engine);
    assert.equal(afterOOO?.uci, "e1c1");
    assert.equal(afterOOO?.san, "O-O-O");

    const epStart = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
    const afterEp = resolveBoardMove(epStart, parseFenBoard("rnbqkbnr/ppp1pppp/3P4/8/8/8/PPPP1PPP/RNBQKBNR"), engine);
    assert.equal(afterEp?.uci, "e5d6");
    assert.equal(afterEp?.san, "exd6");

    const promoQueen = resolveBoardMove("3rk3/4P3/8/8/8/8/8/4K3 w - - 0 1", parseFenBoard("3Qk3/8/8/8/8/8/8/4K3"), engine);
    assert.equal(promoQueen?.uci, "e7d8q");
    assert.equal(promoQueen?.san, "exd8=Q+");
    const promoKnight = resolveBoardMove("3rk3/4P3/8/8/8/8/8/4K3 w - - 0 1", parseFenBoard("3Nk3/8/8/8/8/8/8/4K3"), engine);
    assert.equal(promoKnight?.uci, "e7d8n");
    assert.equal(promoKnight?.san, "exd8=N");

    assert.equal(resolveBoardMove(start, parseFenBoard(start), engine), null);
    assert.equal(resolveBoardMove(start, parseFenBoard("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR"), engine), null);
  }
});

test("grading rule accepts best move, accepts within 5 points as also-works, and rejects > 5 points", () => {
  assert.equal(ALSO_WORKS_MAX_LOSS, 5);

  const exact = gradeEvaluatedMove("Qh5+", "Qh5", 200, 200);
  assert.equal(exact.kind, "correct");
  assert.equal(isBoardAnswerFound(exact), true);
  assert.equal(formatBoardGrade(exact), "Correct");

  const alsoWorks = gradeEvaluatedMove("Nf3", "Qh5", 200, 170);
  assert.equal(alsoWorks.kind, "also-works");
  assert.equal(isBoardAnswerFound(alsoWorks), true);
  assert.match(formatBoardGrade(alsoWorks), /^Also works: Nf3 keeps \d+%$/);

  const missed = gradeEvaluatedMove("h3", "Qh5", 200, -100);
  assert.equal(missed.kind, "missed");
  assert.equal(isBoardAnswerFound(missed), false);
  assert.equal(formatBoardGrade(missed), "h3 loses 27%. Better was Qh5.");
});

test("BoardWatcher never calls readBoard on play routes or unfinished games and disconnects on close", () => {
  const chessOrigin = chesscomPages.tabPatterns[0].replace("/*", "");
  const lichessOrigin = lichessPages.tabPatterns[0].replace("/*", "");
  const item: ReviewItem = {
    id: "123:10", url: `${chessOrigin}/game/live/123`, ply: 10, label: "6.Nf3", san: "Nf3", best: "d4",
    loss: 25, tactics: [], opponent: "opp", endTime: 1, step: 0, due: 0,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  };
  const hereCard: ReviewCard = { kind: "card", item, position: 1, total: 1, here: true, back: "show" };

  let reads = 0;
  let disconnects = 0;
  const doc = parseHtmlDoc(readFileSync(new URL("./fixtures/chesscom_board.html", import.meta.url), "utf8"));
  const watcher = new BoardWatcher({
    doc,
    readBoard: d => { reads++; return readChesscomBoard(d); },
    createObserver: () => ({ observe: () => {}, disconnect: () => { disconnects++; } }),
    onCandidateMove: () => {},
  });

  for (const path of ["/play", "/play/online", "/live"]) {
    const url = chessOrigin + path;
    assert.equal(canWatchBoard({ pageUrl: url, state: "finished", view: "review", panelOpen: true, card: hereCard, alreadyGraded: false }), false, url);
    watcher.sync({ pageUrl: url, state: "finished", view: "review", panelOpen: true, card: hereCard, alreadyGraded: false });
  }
  for (const path of ["/", "/play", "/tv", "/tournament/abc123"]) {
    const url = lichessOrigin + path;
    assert.equal(canWatchBoard({ pageUrl: url, state: "finished", view: "review", panelOpen: true, card: hereCard, alreadyGraded: false }), false, url);
    watcher.sync({ pageUrl: url, state: "finished", view: "review", panelOpen: true, card: hereCard, alreadyGraded: false });
  }
  for (const state of ["pending", "loading", "idle", "aborted", "error"] as const) {
    for (const url of [`${chessOrigin}/game/live/123?move=10`, `${lichessOrigin}/game/abcdefgh#10`]) {
      assert.equal(canWatchBoard({ pageUrl: url, state, view: "review", panelOpen: true, card: hereCard, alreadyGraded: false }), false, `${url} ${state}`);
      watcher.sync({ pageUrl: url, state, view: "review", panelOpen: true, card: hereCard, alreadyGraded: false });
    }
  }
  assert.equal(reads, 0, "readBoard must never be called on play routes or unfinished games");

  watcher.sync({
    pageUrl: `${chessOrigin}/game/live/123?move=10`,
    state: "finished", view: "review", panelOpen: true, card: hereCard, alreadyGraded: false,
  });
  assert.equal(reads, 1);
  assert.equal(watcher.active, true);

  watcher.sync({
    pageUrl: `${chessOrigin}/game/live/123?move=10`,
    state: "finished", view: "review", panelOpen: false, card: hereCard, alreadyGraded: false,
  });
  assert.equal(watcher.active, false);
  assert.ok(disconnects >= 1);
});

test("reviewRateSentence uses the item's site and time class", () => {
  const chessOrigin = chesscomPages.tabPatterns[0].replace("/*", "");
  const lichessOrigin = lichessPages.tabPatterns[0].replace("/*", "");
  const mk = (url: string, timeClass: string, rating: number, neuralFindRate: number): ReviewItem => ({
    id: "1:1", url, ply: 1, label: "1.e4", san: "e4", best: "d4", loss: 25, tactics: [],
    opponent: "opp", endTime: 1, step: 0, due: 0, rating, timeClass, neuralFindRate,
  });
  assert.equal(
    reviewRateSentence(mk(`${lichessOrigin}/game/abcdefgh`, "rapid", 1510, 0.71)),
    " In Lichess rapid, players near 1500 find moves like this about 70% of the time.",
  );
  assert.equal(
    reviewRateSentence(mk(`${lichessOrigin}/game/abcdefgh`, "ultraBullet", 1420, 0.56)),
    " In Lichess UltraBullet, players near 1400 find moves like this about 55% of the time.",
  );
  assert.equal(
    reviewRateSentence(mk(`${chessOrigin}/game/live/123`, "bullet", 1200, 0.64)),
    " In Chess.com bullet, players near 1200 find moves like this about 65% of the time.",
  );
  assert.equal(
    reviewRateSentence(mk(`${chessOrigin}/game/live/123`, "blitz", 1600, 0.79)),
    " In Chess.com blitz, players near 1600 find moves like this about 80% of the time.",
  );
  assert.equal(
    reviewRateSentence(mk(`${chessOrigin}/game/live/123`, "daily", 1500, 0.75)),
    "",
  );
});

test("Chess.com openingNames restores apostrophes for common possessive opening names", () => {
  const cases: [string, string, string][] = [
    ["x/Queens-Gambit-Declined-Three-Knights-Variation", "Queen's Gambit Declined Three Knights Variation", "Queen's Gambit"],
    ["x/Kings-Indian-Defense-Fianchetto", "King's Indian Defense Fianchetto", "King's Indian Defense"],
    ["x/Kings-Indian-Attack", "King's Indian Attack", "King's Indian Attack"],
    ["x/Kings-Gambit-Accepted-3.Nf3", "King's Gambit Accepted", "King's Gambit"],
    ["x/Queens-Indian-Defense", "Queen's Indian Defense", "Queen's Indian Defense"],
    ["x/Queens-Pawn-Opening-Chigorin-Variation", "Queen's Pawn Opening Chigorin Variation", "Queen's Pawn Opening"],
    ["x/Kings-Pawn-Opening", "King's Pawn Opening", "King's Pawn Opening"],
    ["x/Bishops-Opening-Berlin-Defense", "Bishop's Opening Berlin Defense", "Bishop's Opening"],
    ["x/Birds-Opening-From-Gambit", "Bird's Opening From Gambit", "Bird's Opening"],
    ["x/Alekhines-Defense-Modern-Variation", "Alekhine's Defense Modern Variation", "Alekhine's Defense"],
    ["x/Petrovs-Defense-Classical-Attack", "Petrov's Defense Classical Attack", "Petrov's Defense"],
    ["x/Owens-Defense", "Owen's Defense", "Owen's Defense"],
    ["x/Philidors-Defense", "Philidor's Defense", "Philidor's Defense"],
    ["x/Four-Knights-Game-Scotch-Variation", "Four Knights Game Scotch Variation", "Four Knights Game"],
  ];
  for (const [slug, expectedFull, expectedFamily] of cases) {
    assert.deepEqual(openingNames(slug), [expectedFull, expectedFamily], slug);
  }
});
