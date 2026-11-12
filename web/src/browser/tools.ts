// The coach's tools, running in the browser (wf/coach.py ToolBox). Every
// result is registered as a citable fact [T#] so the verifier can check it.
import type { Fact } from "./facts";
import { formatMoves, type GameRow } from "./stats";
import { Engine } from "./engine";
import type { Row } from "./model";
import { GameIndex } from "./search";

export const SCHEMA_DOC = `games(url, color, my_rating, opp_rating, score, expected, residual,
      time_class, eco, opening, family, end_time, moves)
  -- one row per game; score is 1/0.5/0 for the user; expected is the Elo
  -- expected score; residual = score - expected; family e.g. 'Sicilian Defense'
moves(url, ply, move_no, san, best, mover, is_me, phase, cp_before, cp_after,
      wp_loss, clock, clock_frac, time_spent, legal_moves, in_check,
      captures_available, material_balance, non_pawn_material, is_capture)
  -- one row per ply for BOTH players; wp_loss = win% lost by the move (0-100);
  -- blunder = wp_loss >= 20; phase in ('opening','middlegame','endgame');
  -- clock = seconds left before the move; cp_* are from the mover's view`;

export const TOOLS = [
  {
    name: "run_sql",
    description: "Run a read-only DuckDB SQL query (SELECT/WITH only) over the player's games and " +
      "engine-analysed moves. Use it to drill into a weakness, e.g. results by time class, or blunders " +
      "by phase in one opening. Returns CSV, at most 50 rows. Tables:\n" + SCHEMA_DOC,
    input_schema: { type: "object" as const, additionalProperties: false,
      properties: { query: { type: "string", description: "The SQL query." } }, required: ["query"] },
    strict: true,
  },
  {
    name: "example_games",
    description: "Retrieve the player's worst-scoring games (relative to rating expectation) in one " +
      "opening family and color, with links and first moves, to use as concrete examples.",
    input_schema: { type: "object" as const, additionalProperties: false,
      properties: {
        family: { type: "string", description: "Opening family exactly as in the facts." },
        color: { type: "string", enum: ["white", "black"] },
        k: { type: "integer", description: "How many games (1-5)." },
      }, required: ["family", "color", "k"] },
    strict: true,
  },
  {
    name: "search_games",
    description: "Search the player's games by meaning: each game has a plain-English summary " +
      "(result and how it ended, opening, rating gap, eval after the opening, the worst mistake with " +
      "phase and clock, blunder count), ranked by a hybrid of sentence embeddings and keyword matching. " +
      "Use it for descriptive questions such as 'games where I collapsed in time trouble' to find concrete " +
      "examples. For exact filters (a specific result, opening or rating) prefer run_sql. Returns the top k " +
      "summaries with links.",
    input_schema: { type: "object" as const, additionalProperties: false,
      properties: {
        query: { type: "string", description: "What to look for, in plain English." },
        k: { type: "integer", description: "How many games (1-8)." },
      }, required: ["query", "k"] },
    strict: true,
  },
  {
    name: "engine_eval",
    description: "Stockfish evaluation and best move for a FEN position.",
    input_schema: { type: "object" as const, additionalProperties: false,
      properties: { fen: { type: "string" } }, required: ["fen"] },
    strict: true,
  },
];

// ---------- DuckDB-WASM (loaded only when the coach runs) ----------

type Conn = { query: (sql: string) => Promise<{ toArray(): Record<string, unknown>[]; schema: { fields: { name: string }[] } }> };

async function openDuckDb(games: GameRow[], moves: Row[]): Promise<Conn> {
  const duckdb = await import("@duckdb/duckdb-wasm");
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  const conn = await db.connect();
  const gamesOut = games.map(g => ({
    url: g.url, color: g.color, my_rating: g.myRating, opp_rating: g.oppRating, score: g.score,
    expected: g.expected, residual: g.residual, time_class: g.timeClass, eco: g.eco, opening: g.opening,
    family: g.family, end_time: g.endTime, moves: g.moves.slice(0, 16).join(" "),
  }));
  const movesOut = moves.map(({ fen: _fen, ...m }) => m);
  await db.registerFileText("games.json", JSON.stringify(gamesOut));
  await db.registerFileText("moves.json", JSON.stringify(movesOut));
  await conn.query("CREATE TABLE games AS SELECT * FROM read_json_auto('games.json')");
  await conn.query("CREATE TABLE moves AS SELECT * FROM read_json_auto('moves.json')");
  await conn.query("SET enable_external_access = false");
  await conn.query("SET lock_configuration = true");
  return conn as unknown as Conn;
}

function csv(rows: Record<string, unknown>[], cols: string[], max = 50): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(","), ...rows.slice(0, max).map(r => cols.map(c => cell(r[c])).join(","))];
  return lines.join("\n") + "\n" + (rows.length > max ? `... (${rows.length} rows total, first ${max} shown)\n` : "");
}

export class ToolBox {
  calls: { name: string; input: Record<string, unknown>; error: boolean }[] = [];
  private conn: Promise<Conn> | null = null;
  private index: GameIndex | null = null;
  private engine: Engine | null = null;

  constructor(private games: GameRow[], private moves: Row[], public facts: Fact[], private engineUrl: string,
              private summaries: [string, string][] = []) {}

  private register(text: string): string {
    const id = `T${this.facts.filter(f => f.id.startsWith("T")).length + 1}`;
    this.facts.push({ id, kind: "tool", text });
    return `[${id}]\n${text}`;
  }

  async run(name: string, input: Record<string, unknown>): Promise<{ out: string; isError: boolean }> {
    const done = (out: string, isError = false) => { this.calls.push({ name, input, error: isError }); return { out, isError }; };
    try {
      if (name === "run_sql") {
        const sql = String(input.query ?? "").trim();
        const head = sql.replace(/^\(+/, "").split(/\s+/)[0]?.toUpperCase();
        if (head !== "SELECT" && head !== "WITH") return done("Error: only SELECT/WITH queries are allowed.", true);
        this.conn ??= openDuckDb(this.games, this.moves);
        try {
          const res = await (await this.conn).query(sql);
          const cols = res.schema.fields.map(f => f.name);
          return done(this.register(`Query: ${sql}\nResult:\n${csv(res.toArray(), cols)}`));
        } catch (e) {
          return done(`SQL error: ${(e as Error).message}`, true);
        }
      }
      if (name === "example_games") return done(this.register(this.examples(String(input.family), String(input.color), Number(input.k))));
      if (name === "search_games") return done(this.register(await this.search(String(input.query), Number(input.k))));
      if (name === "engine_eval") return done(this.register(await this.evalFen(String(input.fen))));
      return done(`Unknown tool ${name}`, true);
    } catch (e) {
      return done(`Tool error: ${(e as Error).message}`, true);
    }
  }

  private examples(family: string, color: string, k: number): string {
    const sub = this.games.filter(g => g.family === family && g.color === color);
    if (!sub.length) return `No games found for ${family} as ${color}.`;
    const rows = sub.slice().sort((a, b) => a.residual - b.residual).slice(0, Math.max(1, Math.min(k || 1, 5)));
    const res = (s: number) => (s === 1 ? "won" : s === 0.5 ? "drew" : "lost");
    return [`Worst ${family} games as ${color}:`, ...rows.map(r =>
      `- ${r.url}: you ${res(r.score)} (${r.myRating} vs ${r.oppRating}), ${r.opening}; ${formatMoves(r.moves.slice(0, 12).join(" "))}`)].join("\n");
  }

  private async search(query: string, k: number): Promise<string> {
    if (!this.summaries.length) return "No game summaries are available.";
    this.index ??= new GameIndex(this.summaries.map(s => s[0]), this.summaries.map(s => s[1]));
    const hits = await this.index.search(query, Math.max(1, Math.min(k || 5, 8)));
    return [`Games best matching '${query}' (hybrid search over game summaries):`,
      ...hits.map(h => `- ${this.index!.urls[h.i]}: ${this.index!.texts[h.i]}`)].join("\n");
  }

  private async evalFen(fen: string): Promise<string> {
    const { Chess } = await import("chess.js");
    const board = new Chess(fen);   // throws on an invalid FEN
    if (!this.engine) { this.engine = new Engine(this.engineUrl); await this.engine.init(); }
    const r = await this.engine.analyse(fen, 16);
    const sideName = board.turn() === "w" ? "White" : "Black";
    let best = "none";
    if (r.best) { try { best = board.move({ from: r.best.slice(0, 2), to: r.best.slice(2, 4), promotion: r.best[4] }).san; } catch { /* keep none */ } }
    const v = r.cp / 100;
    return `Position ${fen}: ${sideName} to move, eval ${v >= 0 ? "+" : ""}${v.toFixed(1)} pawns for ${sideName}, best move ${best}.`;
  }

  close() { this.engine?.terminate(); }
}
