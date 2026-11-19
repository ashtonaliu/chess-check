// Stockfish in the browser: a pool of single-threaded WASM engines (one per
// core; the multi-threaded build needs cross-origin isolation, which GitHub
// Pages can't provide), plus the per-move analysis of chesscheck/engine.py.
import { Chess, type Move } from "chess.js";
import { enginePruneKeys, pruneTransaction } from "./cacheRetention";
import type { Game } from "./games";

export const OPENING_PLIES = 24;   // through move 12
export const BLUNDER_DROP = 20;    // win% lost in one move
const MATE = 3000;
const VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export interface MoveRow {
  ply: number; move_no: number; san: string; best: string | null;
  mover: "white" | "black"; is_me: boolean; phase: "opening" | "middlegame" | "endgame";
  fen: string; cp_before: number; cp_after: number; wp_loss: number;
  shallow_nodes?: number;   // before and after the move; older cache entries have no count
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

/** How long one search may take before the engine counts as stuck (depth 14 takes a few seconds). */
export const SEARCH_TIMEOUT_MS = 60_000;

export class Engine {
  private w: Worker;
  private listeners: ((line: string) => void)[] = [];
  private waiters = new Set<(e: Error) => void>();
  private dead: Error | null = null;
  constructor(url: string) {
    this.w = new Worker(url);
    this.w.onmessage = e => { const line = String(e.data); this.listeners.slice().forEach(f => f(line)); };
    // A worker that fails to load or crashes would otherwise leave every pending call waiting forever.
    this.w.onerror = e => { e.preventDefault?.(); this.fail(new Error(`Stockfish stopped: ${e.message || "the worker failed"}`)); };
    this.w.onmessageerror = () => this.fail(new Error("Stockfish sent a message that could not be read."));
  }
  private fail(err: Error) {
    if (this.dead) return;
    this.dead = err;
    this.w.terminate();
    for (const reject of [...this.waiters]) reject(err);
    this.waiters.clear();
    this.listeners = [];
  }
  private until(pred: (l: string) => boolean, onLine?: (l: string) => void, timeoutMs = SEARCH_TIMEOUT_MS): Promise<string> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(fail); this.listeners = this.listeners.filter(x => x !== f); };
      const fail = (e: Error) => { done(); reject(e); };
      const timer = setTimeout(() => this.fail(new Error("Stockfish did not answer in time.")), timeoutMs);
      const f = (l: string) => {
        onLine?.(l);
        if (pred(l)) { done(); resolve(l); }
      };
      this.waiters.add(fail);
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
  /** Score (centipawns, side-to-move POV, mates as +/-MATE-n), best move and principal variation in UCI. */
  async analyse(fen: string, depth: number): Promise<{ cp: number; best: string | null; pv: string[]; nodes: number }> {
    let cp = 0, pv: string[] | null = null, nodes = 0;
    const done = this.until(l => l.startsWith("bestmove"), l => {
      if (!l.startsWith("info")) return;
      const count = l.match(/ nodes (\d+)/);
      if (count) nodes = Math.max(nodes, Number(count[1]));
      if (!l.includes(" score ")) return;
      if (/ (lower|upper)bound/.test(l)) return;
      const m = l.match(/ score (cp|mate) (-?\d+)/);
      if (m) {
        const v = +m[2];
        cp = m[1] === "cp" ? v : v > 0 ? MATE - v : -MATE - v;
      }
      const p = l.match(/ pv (.+)$/);
      if (p) pv = p[1].trim().split(/\s+/);
    });
    this.w.postMessage(`position fen ${fen}`);
    this.w.postMessage(`go depth ${depth}`);
    const bm = await done;
    const best = bm.split(" ")[1];
    return { cp, best: pv?.[0] ?? (best && best !== "(none)" ? best : null), pv: pv ?? [], nodes };
  }
  /** Stop the worker; anything still waiting on it is rejected with `reason`. */
  terminate(reason: Error = new DOMException("Cancelled", "AbortError")) {
    if (this.dead) return;
    this.fail(reason);
  }
}

/** One Stockfish worker per core but one, up to MAX_WORKERS. */
export const MAX_WORKERS = 8;
export const defaultWorkers = () => Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, MAX_WORKERS));

// ---------- cache (IndexedDB) ----------

const DB = "chess-check-engine-cache", STORE = "games", CACHE_VERSION = 1;
const recordEndTimes = globalThis.location?.protocol === "chrome-extension:";
let askedToPersist = false;
function openDb(): Promise<IDBDatabase | null> {
  // Ask once that the browser not evict this cache when disk space runs low (losing it only costs a
  // rebuild, so a refusal is fine). The extension has the unlimitedStorage permission instead.
  if (!askedToPersist) { askedToPersist = true; void navigator.storage?.persist?.().catch(() => false); }
  return new Promise(resolve => {
    try {
      let created = false;
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { created = true; req.result.createObjectStore(STORE); };
      req.onsuccess = () => {
        const db = req.result;
        if (created) void moveOldCache(db).finally(() => resolve(db));
        else resolve(db);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** Only the extension's offscreen page calls this. Count keys without reading the move rows. */
export async function pruneAnalysisCache(protectedGames: ReadonlySet<string>, limit: number, signal: AbortSignal) {
  if (signal.aborted) return;
  const db = await openDb();
  if (!db) return;
  try {
    await pruneTransaction(db, STORE, signal, store => {
      const keys = store.getAllKeys();
      const dates = store.getAll(IDBKeyRange.bound("end_", "end_\uffff"));
      dates.onsuccess = () => {
        const endTimes = new Map<string, number>(dates.result.map(({ id, endTime }) => [id, endTime]));
        for (const key of enginePruneKeys(keys.result, endTimes, protectedGames, limit)) store.delete(key);
      };
    });
  } finally { db.close(); }
}

/** One-time move of engine results saved under the cache's earlier name, so nobody loses them. */
const OLD_DB = "wf-engine-cache";
async function moveOldCache(db: IDBDatabase): Promise<void> {
  try {
    const names = (await indexedDB.databases?.())?.map(d => d.name) ?? [];
    if (!names.includes(OLD_DB)) return;
    const old = await new Promise<IDBDatabase | null>(res => {
      const r = indexedDB.open(OLD_DB);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    });
    if (!old || !old.objectStoreNames.contains(STORE)) { old?.close(); return; }
    const entries = await new Promise<[IDBValidKey, unknown][]>(res => {
      const out: [IDBValidKey, unknown][] = [];
      const cur = old.transaction(STORE, "readonly").objectStore(STORE).openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
      cur.onerror = () => res(out);
    });
    old.close();
    await new Promise<void>(res => {
      const tx = db.transaction(STORE, "readwrite");
      for (const [k, v] of entries) tx.objectStore(STORE).put(v, k);
      tx.oncomplete = tx.onerror = tx.onabort = () => res();
    });
    indexedDB.deleteDatabase(OLD_DB);
  } catch { /* an unreadable old cache only costs a rebuild */ }
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

/** Add `fresh` to the object stored under `key`, reading and writing in one transaction, so two
 *  writers that each hold part of an entry (a recap's recheck and a profile build's) both keep
 *  their part instead of the later one replacing the whole entry. */
export function mergeInto<T extends object>(existing: T | undefined, fresh: T): T { return { ...(existing ?? {}), ...fresh } as T; }
function idbMerge(db: IDBDatabase | null, key: string, fresh: object) {
  if (!db) return;
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const req = store.get(key);
    req.onsuccess = () => store.put(mergeInto(req.result as object | undefined, fresh), key);
  } catch { /* not cached */ }
}

// Issue all reads before the transaction can become inactive.
async function readCached<T>(db: IDBDatabase | null, keys: string[]): Promise<(T | undefined)[]> {
  if (db && keys.length) {
    try {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      return await Promise.all(keys.map(key => new Promise<T | undefined>(resolve => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () => resolve(undefined);
      })));
    } catch {
      // Treat an unavailable cache as a miss.
    }
  }
  return keys.map(() => undefined);
}

// ---------- per-game analysis (chesscheck/engine.py _analyse) ----------

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
  const evalWhite = async (): Promise<{ cpWhite: number; best: string | null; nodes: number }> => {
    const r = await eng.analyse(c.fen(), depth);
    const sign = c.turn() === "w" ? 1 : -1;
    return { cpWhite: r.cp * sign, best: uciToSan(new Chess(c.fen()), r.best), nodes: r.nodes };
  };
  let { cpWhite, best, nodes } = await evalWhite();
  const lastClock: Record<"w" | "b", number | null> = { w: base, b: base };
  const moves: MoveRow[] = [];
  let openingEval: number | null = null;
  for (let ply = 0; ply < history.length; ply++) {
    const mv = history[ply];
    const mover = c.turn();
    const sign = mover === "w" ? 1 : -1;
    const phase = ply < OPENING_PLIES ? "opening" : nonPawnMaterial(c) <= 26 ? "endgame" : "middlegame";
    // SAN strings, not verbose moves: chess.js builds the position before and after every legal
    // move for the verbose form, which took 82% of this page's time per position (0.80 ms against
    // 0.06 ms; the counts were identical on 6,312 positions). Captures are the SANs with an "x".
    const legal = c.moves();
    const feats = {
      legal_moves: legal.length, in_check: c.inCheck() ? 1 : 0,
      captures_available: legal.filter(m => m.includes("x")).length,
      material_balance: materialBalance(c, mover), non_pawn_material: nonPawnMaterial(c),
    };
    const fen = c.fen();
    const clock = clk.length === history.length ? clk[ply] : null;
    const prev = lastClock[mover];
    const spent = clock !== null && prev !== null ? prev - clock : null;
    lastClock[mover] = clock;
    c.move(mv.san);
    let cpAfterWhite: number, nextBest: string | null, nextNodes = 0;
    if (c.isCheckmate()) { cpAfterWhite = MATE * sign; nextBest = null; }
    else if (c.isGameOver()) { cpAfterWhite = 0; nextBest = null; }
    else ({ cpWhite: cpAfterWhite, best: nextBest, nodes: nextNodes } = await evalWhite());
    const before = cpWhite * sign, after = cpAfterWhite * sign;
    const drop = winPct(before) - winPct(after);
    moves.push({
      ply, move_no: Math.floor(ply / 2) + 1, san: mv.san, best,
      mover: mover === "w" ? "white" : "black", is_me: false, phase, fen,
      cp_before: before, cp_after: after, shallow_nodes: nodes + nextNodes, wp_loss: Math.round(Math.max(drop, 0) * 10) / 10,
      clock, clock_frac: clock !== null && base ? clock / base : null, time_spent: spent,
      is_capture: mv.captured ? 1 : 0, ...feats,
    });
    if (ply + 1 === OPENING_PLIES) openingEval = cpAfterWhite;
    cpWhite = cpAfterWhite; best = nextBest; nodes = nextNodes;
  }
  return { url: game.url, moves, opening_eval_white: openingEval };
}

/** Worker slots shared by every background build (pace.ts). A pool takes a slot before each task
 *  and gives it back after, and keeps an engine only while it holds a slot, so builds running
 *  together never search on more workers, or keep more engines loaded, than the budget allows. */
export interface Pacer {
  readonly max: number;
  acquire(signal?: AbortSignal): Promise<void>;
  /** Whether the pool may keep a slot it holds for its next task (no other build needs it). */
  keep(): boolean;
  release(): void;
}

interface PoolEngine { init(): Promise<void>; terminate(): void }

/** Runs tasks 0..count-1 on up to `max` engines, each engine taking the next task when free.
 *  If a task fails, or the signal aborts, every worker loop stops (one waiting for a slot stops
 *  waiting) and all engines are shut down before this returns or throws. */
export async function runPool<E extends PoolEngine = Engine>(count: number,
    o: { workers?: number; pace?: Pacer; engineUrl: string; signal?: AbortSignal },
    task: (eng: E, t: number) => Promise<void>,
    make: () => E = () => new Engine(o.engineUrl) as unknown as E): Promise<void> {
  if (!count) return;
  const n = Math.max(1, Math.min(o.pace?.max ?? o.workers ?? defaultWorkers(), count));
  const engines = new Set<E>();
  const quit = new AbortController();        // the pool's own stop: a failure or the caller's abort
  let failure: unknown = null;
  const fail = (e: unknown) => { if (!quit.signal.aborted) { failure = e; quit.abort(); } };
  const cancelled = () => new DOMException("Cancelled", "AbortError");
  // Cancelling stops the engines mid-search instead of after the task each is working on.
  const stopAll = () => { engines.forEach(e => e.terminate()); engines.clear(); };
  const onAbort = () => { fail(cancelled()); stopAll(); };
  if (o.signal?.aborted) throw cancelled();
  o.signal?.addEventListener("abort", onAbort);
  quit.signal.addEventListener("abort", stopAll);
  const drop = (e: E | null) => { if (e) { e.terminate(); engines.delete(e); } return null; };
  let next = 0;
  const loop = async () => {
    let eng: E | null = null, holding = false;
    try {
      while (next < count && !quit.signal.aborted) {
        if (o.pace && !holding) {
          // waiting for a slot: an engine kept while waiting would hold memory without a slot
          eng = drop(eng);
          await o.pace.acquire(quit.signal);
          holding = true;
        }
        if (quit.signal.aborted || next >= count) break;
        const t = next++;
        if (!eng) { eng = make(); engines.add(eng); await eng.init(); }
        if (quit.signal.aborted) break;
        await task(eng, t);
        // keep the slot, and the engine, unless another build needs it or the budget dropped
        if (o.pace && !o.pace.keep()) { o.pace.release(); holding = false; }
      }
    } catch (e) {
      fail(e);
    } finally {
      if (holding) o.pace?.release();
      drop(eng);
    }
  };
  try {
    await Promise.all(Array.from({ length: n }, loop));   // loops never reject: each records its failure
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    stopAll();
  }
  if (failure) throw failure;
}

export interface PoolOptions { depth: number; workers?: number; engineUrl: string;
  onProgress?: (done: number, total: number, cached: number) => void; signal?: AbortSignal; pace?: Pacer; }

export async function analyseGames(games: Game[], opts: PoolOptions): Promise<GameAnalysis[]> {
  const db = await openDb();
  const key = (g: Game) => `v${CACHE_VERSION}_${g.url.split("/").pop()}_d${opts.depth}`;
  const out: (Stored | undefined)[] = await readCached<Stored>(db, games.map(key));
  const todo = games.map((g, i) => i).filter(i => !out[i]);
  const cached = games.length - todo.length;
  let done = cached;
  opts.onProgress?.(done, games.length, cached);

  if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  await runPool(todo.length, opts, async (eng, t) => {
    const i = todo[t];
    const res = await analyseOne(eng, games[i], opts.depth);
    out[i] = res;
    const game = games[i];
    idb(db, "readwrite", s => {
      if (recordEndTimes) {
        const id = game.url.split("/").pop()!;
        s.put({ id, endTime: game.endTime }, `end_${id}`);
      }
      return s.put(res, key(game));
    });
    opts.onProgress?.(++done, games.length, cached);
  });
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

// ---------- deep re-check of flagged blunders (chesscheck/engine.py recheck_blunders) ----------

export const DEEP_DEPTH_BROWSER = 14;

/** Screen cheap, confirm expensive: re-search only the positions flagged as blunders, deeper.
 * Adds deep_* fields to those move rows (in place). Every flagged position is its own task, shared
 * across the workers, so one game's blunders are checked in parallel too. `only` limits which
 * flagged moves are checked (a recap needs only the player's own). Cached in IndexedDB per game and
 * depth, position by position, so a later call checks only what is still missing. */
export async function recheckBlunders(analyses: GameAnalysis[], opts: { depth?: number; engineUrl: string;
  workers?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal;
  only?: (m: MoveRow) => boolean; pace?: Pacer }): Promise<void> {
  const depth = opts.depth ?? DEEP_DEPTH_BROWSER;
  const db = await openDb();
  const key = (a: GameAnalysis) => `deep_v1_${a.url.split("/").pop()}_d${depth}`;
  type Deep = Record<string, { deep_best: string | null; deep_refutation: string | null; deep_cp_before: number; deep_cp_after: number; deep_loss: number }>;
  const cached = (await readCached<Deep>(db, analyses.map(key))).map(d => d ?? {});
  const tasks = analyses.flatMap((a, i) => a.moves
    .filter(m => m.wp_loss >= BLUNDER_DROP && (opts.only?.(m) ?? true) && !cached[i][String(m.ply)])
    .map(m => ({ i, m })));
  // Launch the estimated long searches first so they can overlap with the short ones.
  // Unmeasured rows from older caches get the median known cost, or keep their order if all are old.
  const costs = tasks.flatMap(({ m }) => m.shallow_nodes ? [m.shallow_nodes] : []).sort((a, b) => a - b);
  const typical = costs[Math.floor(costs.length / 2)] ?? 0;
  tasks.sort((a, b) => (b.m.shallow_nodes || typical) - (a.m.shallow_nodes || typical));
  let done = 0;
  if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const left = new Map<number, number>();               // positions still to check, per game
  for (const t of tasks) left.set(t.i, (left.get(t.i) ?? 0) + 1);
  await runPool(tasks.length, opts, async (eng, t) => {
    const { i, m } = tasks[t];
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
    cached[i][String(m.ply)] = { deep_best: best, deep_refutation: refutation, deep_cp_before: before,
      deep_cp_after: after, deep_loss: Math.round(Math.max(winPct(before) - winPct(after), 0) * 10) / 10 };
    opts.onProgress?.(++done, tasks.length);
    left.set(i, left.get(i)! - 1);
    if (left.get(i) === 0) idbMerge(db, key(analyses[i]), cached[i]);
  });
  analyses.forEach((a, i) => { const d = cached[i]; for (const m of a.moves) Object.assign(m, d[String(m.ply)] ?? {}); });
}

// ---------- summaries (chesscheck/engine.py) ----------

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

/** The user's biggest mistakes, by the confirmed (deep) loss when available (chesscheck/engine.py worst_blunders). */
export function worstBlunders(analyses: GameAnalysis[], k = 5) {
  const all = analyses.flatMap(a => a.moves.filter(m => m.is_me).map(m => {
    const d = m as MoveRow & { deep_loss?: number; deep_best?: string | null };
    return d.deep_loss !== undefined ? { ...m, url: a.url, wp_loss: d.deep_loss, best: d.deep_best ?? null } : { ...m, url: a.url };
  }));
  return all.sort((a, b) => b.wp_loss - a.wp_loss).slice(0, k);
}

export const moveLabel = (m: Pick<MoveRow, "ply" | "move_no" | "san">) =>
  m.ply % 2 === 0 ? `${m.move_no}.${m.san}` : `${m.move_no}...${m.san}`;
