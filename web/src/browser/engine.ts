// Stockfish in the browser: a pool of single-threaded WASM engines (one per
// core; the multi-threaded build needs cross-origin isolation, which GitHub
// Pages can't provide), plus the per-move analysis of wf/engine.py.
import { Chess, type Move } from "chess.js";
import type { Game } from "./games";

export const OPENING_PLIES = 24;   // through move 12
export const BLUNDER_DROP = 20;    // win% lost in one move
const MATE = 3000;
const VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export interface MoveRow {
  ply: number; move_no: number; san: string; best: string | null;
  mover: "white" | "black"; is_me: boolean; phase: "opening" | "middlegame" | "endgame";
  fen: string; cp_before: number; cp_after: number; wp_loss: number;
  clock: number | null; clock_frac: number | null; time_spent: number | null;
  legal_moves: number; in_check: number; captures_available: number;
  material_balance: number; non_pawn_material: number; is_capture: number;
}
export interface GameAnalysis { url: string; color: "white" | "black"; moves: MoveRow[]; opening_eval: number | null; }

export const winPct = (cp: number) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

function nonPawnMaterial(c: Chess): number {
  let s = 0;
  for (const row of c.board()) for (const sq of row) if (sq && sq.type !== "p" && sq.type !== "k") s += VALUES[sq.type];
  return s;
}
function materialBalance(c: Chess, color: "w" | "b"): number {
  let s = 0;
  for (const row of c.board()) for (const sq of row) if (sq && sq.type !== "k") s += VALUES[sq.type] * (sq.color === color ? 1 : -1);
  return s;
}
function baseSeconds(tc: string): number | null {
  if (!tc || tc.includes("/")) return null;      // daily games
  const v = parseFloat(tc.split("+")[0]);
  return Number.isFinite(v) ? v : null;
}
function clocks(pgn: string): number[] {
  return [...pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)]
    .map(m => +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]));
}

// ---------- one engine ----------

export class Engine {
  private w: Worker;
  private listeners: ((line: string) => void)[] = [];
  constructor(url: string) {
    this.w = new Worker(url);
    this.w.onmessage = e => { const line = String(e.data); this.listeners.slice().forEach(f => f(line)); };
  }
  private until(pred: (l: string) => boolean, onLine?: (l: string) => void): Promise<string> {
    return new Promise(resolve => {
      const f = (l: string) => {
        onLine?.(l);
        if (pred(l)) { this.listeners = this.listeners.filter(x => x !== f); resolve(l); }
      };
      this.listeners.push(f);
    });
  }
  async init() {
    const ok = this.until(l => l === "uciok");
    this.w.postMessage("uci"); await ok;
    this.w.postMessage("setoption name Hash value 16");
    const ready = this.until(l => l === "readyok");
    this.w.postMessage("isready"); await ready;
  }
  /** Score (centipawns, side-to-move POV, mates as +/-MATE-n) and best move in UCI. */
  async analyse(fen: string, depth: number): Promise<{ cp: number; best: string | null }> {
    let cp = 0, pv: string | null = null;
    const done = this.until(l => l.startsWith("bestmove"), l => {
      if (!l.startsWith("info") || !l.includes(" score ")) return;
      if (/ (lower|upper)bound/.test(l)) return;
      const m = l.match(/ score (cp|mate) (-?\d+)/);
      if (m) {
        const v = +m[2];
        cp = m[1] === "cp" ? v : v > 0 ? MATE - v : -MATE - v;
      }
      const p = l.match(/ pv (\S+)/);
      if (p) pv = p[1];
    });
    this.w.postMessage(`position fen ${fen}`);
    this.w.postMessage(`go depth ${depth}`);
    const bm = await done;
    const best = bm.split(" ")[1];
    return { cp, best: pv ?? (best && best !== "(none)" ? best : null) };
  }
  terminate() { this.w.terminate(); }
}

// ---------- cache (IndexedDB) ----------

const DB = "wf-engine-cache", STORE = "games", CACHE_VERSION = 1;
function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
function idb<T>(db: IDBDatabase | null, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  if (!db) return Promise.resolve(undefined);
  return new Promise(resolve => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

// ---------- per-game analysis (wf/engine.py _analyse) ----------

type Stored = Omit<GameAnalysis, "color" | "opening_eval"> & { opening_eval_white: number | null };

const uciToSan = (c: Chess, uci: string | null): string | null => {
  if (!uci) return null;
  try { return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; }
  catch { return null; }
};  // callers pass a throwaway copy of the board

async function analyseOne(eng: Engine, game: Game, depth: number): Promise<Stored> {
  const replay = new Chess();
  replay.loadPgn(game.pgn);
  const history: Move[] = replay.history({ verbose: true });
  const clk = clocks(game.pgn);
  const base = baseSeconds(game.timeControl);
  const c = new Chess();
  const evalWhite = async (): Promise<{ cpWhite: number; best: string | null }> => {
    const r = await eng.analyse(c.fen(), depth);
    const sign = c.turn() === "w" ? 1 : -1;
    return { cpWhite: r.cp * sign, best: uciToSan(new Chess(c.fen()), r.best) };
  };
  let { cpWhite, best } = await evalWhite();
  const lastClock: Record<"w" | "b", number | null> = { w: base, b: base };
  const moves: MoveRow[] = [];
  let openingEval: number | null = null;
  for (let ply = 0; ply < history.length; ply++) {
    const mv = history[ply];
    const mover = c.turn();
    const sign = mover === "w" ? 1 : -1;
    const phase = ply < OPENING_PLIES ? "opening" : nonPawnMaterial(c) <= 26 ? "endgame" : "middlegame";
    const legal = c.moves({ verbose: true });
    const feats = {
      legal_moves: legal.length, in_check: c.inCheck() ? 1 : 0,
      captures_available: legal.filter(m => m.captured).length,
      material_balance: materialBalance(c, mover), non_pawn_material: nonPawnMaterial(c),
    };
    const fen = c.fen();
    const clock = clk.length === history.length ? clk[ply] : null;
    const prev = lastClock[mover];
    const spent = clock !== null && prev !== null ? prev - clock : null;
    lastClock[mover] = clock;
    c.move(mv.san);
    let cpAfterWhite: number, nextBest: string | null;
    if (c.isCheckmate()) { cpAfterWhite = MATE * sign; nextBest = null; }
    else if (c.isGameOver()) { cpAfterWhite = 0; nextBest = null; }
    else ({ cpWhite: cpAfterWhite, best: nextBest } = await evalWhite());
    const before = cpWhite * sign, after = cpAfterWhite * sign;
    const drop = winPct(before) - winPct(after);
    moves.push({
      ply, move_no: Math.floor(ply / 2) + 1, san: mv.san, best,
      mover: mover === "w" ? "white" : "black", is_me: false, phase, fen,
      cp_before: before, cp_after: after, wp_loss: Math.round(Math.max(drop, 0) * 10) / 10,
      clock, clock_frac: clock !== null && base ? clock / base : null, time_spent: spent,
      is_capture: mv.captured ? 1 : 0, ...feats,
    });
    if (ply + 1 === OPENING_PLIES) openingEval = cpAfterWhite;
    cpWhite = cpAfterWhite; best = nextBest;
  }
  return { url: game.url, moves, opening_eval_white: openingEval };
}

export interface PoolOptions { depth: number; workers?: number; engineUrl: string;
  onProgress?: (done: number, total: number, cached: number) => void; signal?: AbortSignal; }

export async function analyseGames(games: Game[], opts: PoolOptions): Promise<GameAnalysis[]> {
  const db = await openDb();
  const key = (g: Game) => `v${CACHE_VERSION}_${g.url.split("/").pop()}_d${opts.depth}`;
  const out: (Stored | undefined)[] = await Promise.all(games.map(g => idb<Stored>(db, "readonly", s => s.get(key(g)))));
  const todo = games.map((g, i) => i).filter(i => !out[i]);
  const cached = games.length - todo.length;
  let done = cached;
  opts.onProgress?.(done, games.length, cached);

  const n = Math.max(1, Math.min(opts.workers ?? Math.max(1, (navigator.hardwareConcurrency || 2) - 1), 8, todo.length));
  const engines: Engine[] = [];
  try {
    if (todo.length) {
      for (let i = 0; i < n; i++) engines.push(new Engine(opts.engineUrl));
      await Promise.all(engines.map(e => e.init()));
    }
    let next = 0;
    await Promise.all(engines.map(async eng => {
      while (next < todo.length) {
        if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        const i = todo[next++];
        const res = await analyseOne(eng, games[i], opts.depth);
        out[i] = res;
        idb(db, "readwrite", s => s.put(res, key(games[i])));
        opts.onProgress?.(++done, games.length, cached);
      }
    }));
  } finally {
    engines.forEach(e => e.terminate());
  }
  // "is_me" and the user's-POV opening eval depend on whose report this is
  return games.map((g, i) => {
    const s = out[i]!;
    return {
      url: s.url, color: g.color,
      moves: s.moves.map(m => ({ ...m, is_me: m.mover === g.color })),
      opening_eval: s.opening_eval_white === null ? null
        : g.color === "white" ? s.opening_eval_white : -s.opening_eval_white,
    };
  });
}

// ---------- deep re-check of flagged blunders (wf/engine.py recheck_blunders) ----------

export const DEEP_DEPTH_BROWSER = 14;

/** Screen cheap, confirm expensive: re-search only the positions flagged as blunders, deeper.
 * Adds deep_* fields to those move rows (in place). Cached in IndexedDB per game and depth. */
export async function recheckBlunders(analyses: GameAnalysis[], opts: { depth?: number; engineUrl: string;
  workers?: number; onProgress?: (done: number, total: number) => void }): Promise<void> {
  const depth = opts.depth ?? DEEP_DEPTH_BROWSER;
  const db = await openDb();
  const key = (a: GameAnalysis) => `deep_v1_${a.url.split("/").pop()}_d${depth}`;
  type Deep = Record<string, { deep_best: string | null; deep_refutation: string | null; deep_cp_before: number; deep_cp_after: number; deep_loss: number }>;
  const cached = await Promise.all(analyses.map(a => idb<Deep>(db, "readonly", s => s.get(key(a)))));
  const todo = analyses.map((a, i) => i).filter(i => !cached[i] && analyses[i].moves.some(m => m.wp_loss >= BLUNDER_DROP));
  const total = todo.reduce((n, i) => n + analyses[i].moves.filter(m => m.wp_loss >= BLUNDER_DROP).length, 0);
  let done = 0;
  const n = Math.max(1, Math.min(opts.workers ?? Math.max(1, (navigator.hardwareConcurrency || 2) - 1), 8, todo.length));
  const engines: Engine[] = [];
  try {
    if (todo.length) { for (let i = 0; i < n; i++) engines.push(new Engine(opts.engineUrl)); await Promise.all(engines.map(e => e.init())); }
    let next = 0;
    await Promise.all(engines.map(async eng => {
      while (next < todo.length) {
        const i = todo[next++], a = analyses[i], out: Deep = {};
        for (const m of a.moves) {
          if (m.wp_loss < BLUNDER_DROP) continue;
          const c = new Chess(m.fen);
          const r1 = await eng.analyse(m.fen, depth);
          const before = r1.cp;   // the mover is the side to move
          const best = uciToSan(new Chess(m.fen), r1.best);
          c.move(m.san);
          let after: number, refutation: string | null;
          if (c.isGameOver()) { after = c.isCheckmate() ? MATE : 0; refutation = null; }
          else {
            const r2 = await eng.analyse(c.fen(), depth);
            after = -r2.cp;   // side to move is now the opponent
            refutation = uciToSan(new Chess(c.fen()), r2.best);
          }
          out[String(m.ply)] = { deep_best: best, deep_refutation: refutation, deep_cp_before: before,
            deep_cp_after: after, deep_loss: Math.round(Math.max(winPct(before) - winPct(after), 0) * 10) / 10 };
          opts.onProgress?.(++done, total);
        }
        cached[i] = out;
        idb(db, "readwrite", s => s.put(out, key(a)));
      }
    }));
  } finally {
    engines.forEach(e => e.terminate());
  }
  analyses.forEach((a, i) => { const d = cached[i]; if (d) for (const m of a.moves) Object.assign(m, d[String(m.ply)] ?? {}); });
}

// ---------- summaries (wf/engine.py) ----------

export function phaseSummary(analyses: GameAnalysis[], mine = true) {
  const rows: Record<string, { moves: number; loss: number; blunders: number }> = {
    opening: { moves: 0, loss: 0, blunders: 0 }, middlegame: { moves: 0, loss: 0, blunders: 0 },
    endgame: { moves: 0, loss: 0, blunders: 0 },
  };
  for (const a of analyses) for (const m of a.moves) {
    if (m.is_me !== mine) continue;
    const r = rows[m.phase];
    r.moves++; r.loss += m.wp_loss; r.blunders += m.wp_loss >= BLUNDER_DROP ? 1 : 0;
  }
  return Object.fromEntries(Object.entries(rows).map(([p, r]) => [p, {
    moves: r.moves, avg_loss: r.moves ? r.loss / r.moves : 0, blunder_rate: r.moves ? r.blunders / r.moves : 0,
  }]));
}

/** The user's biggest mistakes, by the confirmed (deep) loss when available (wf/engine.py worst_blunders). */
export function worstBlunders(analyses: GameAnalysis[], k = 5) {
  const all = analyses.flatMap(a => a.moves.filter(m => m.is_me).map(m => {
    const d = m as MoveRow & { deep_loss?: number; deep_best?: string | null };
    return d.deep_loss !== undefined ? { ...m, url: a.url, wp_loss: d.deep_loss, best: d.deep_best ?? null } : { ...m, url: a.url };
  }));
  return all.sort((a, b) => b.wp_loss - a.wp_loss).slice(0, k);
}

export const moveLabel = (m: Pick<MoveRow, "ply" | "move_no" | "san">) =>
  m.ply % 2 === 0 ? `${m.move_no}.${m.san}` : `${m.move_no}...${m.san}`;
