// The numbered facts the coach is given, and the verifier that checks its
// report against them. Ports of wf/facts.py and wf/verify.py; the facts text
// is parity-tested against Python, character for character.
import { BLUNDER_DROP, moveLabel, phaseSummary, worstBlunders, type GameAnalysis } from "./engine";
import type { Risk } from "./model";
import { formatMoves, openingTable, overall, worstBranch, type GameRow, type OpeningRow } from "./stats";

export interface Fact { id: string; kind: string; text: string; color?: string; family?: string; fen?: string; }

// Python's round() rounds halves to even; Math.round rounds them up.
function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}
const pct = (x: number) => `${pyRound(100 * x)}%`;
const pts = (x: number) => { const v = pyRound(100 * x); return v > 0 ? `+${v}` : `${v === 0 ? 0 : v}`; };
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const pawns = (cp: number) => { const v = cp / 100; return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`; };
const side = (c: string) => (c === "white" ? "as White" : "as Black");

const PHASE_THEMES: Record<string, [string, string]> = {
  opening: ["opening", "https://lichess.org/training/opening"],
  middlegame: ["middlegame", "https://lichess.org/training/middlegame"],
  endgame: ["endgame", "https://lichess.org/training/endgame"],
  blunders: ["hanging piece", "https://lichess.org/training/hangingPiece"],
};

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median eval after move 12 and win% lost per move in moves 13-25 (wf/engine.py opening_exit). */
export function openingExit(analyses: GameAnalysis[], urls: Set<string>) {
  const evals: number[] = [];
  let loss = 0, n = 0;
  for (const a of analyses) {
    if (!urls.has(a.url)) continue;
    if (a.opening_eval !== null) evals.push(a.opening_eval);
    for (const m of a.moves) if (m.is_me && m.move_no > 12 && m.move_no <= 25) { loss += m.wp_loss; n++; }
  }
  if (!evals.length) return null;
  return { games: evals.length, eval12: median(evals), loss13_25: n ? loss / n : 0 };
}

export function buildFacts(rows: GameRow[], analyses: GameAnalysis[] | null, risk: Risk | null): Fact[] {
  const facts: Fact[] = [];
  const add = (kind: string, text: string, extra: Partial<Fact> = {}) =>
    facts.push({ id: `F${facts.length + 1}`, kind, text, ...extra });

  const o = overall(rows);
  add("overall", `Across ${o.games} games (average rating ${o.avg_rating}), you scored ${pct(o.score)} ` +
    `versus ${pct(o.expected)} expected from ratings (${pts(o.resid)} points).`);

  if (risk) {
    add("model", `A blunder-risk model trained only on your opponents' moves (players of similar rating) ` +
      `expected ${f1(risk.expected)} blunders in your ${risk.moves} moves given how hard the positions were; ` +
      `you made ${risk.actual}, ${f2(risk.ratio)} times the expected count ` +
      `(90% interval ${f2(risk.ci_low)} to ${f2(risk.ci_high)}).`);
    for (const b of risk.buckets) {
      add("model", `With ${b.label}, you made ${b.actual} blunders in ${b.moves} moves versus ` +
        `${f1(b.expected)} expected (${f2(b.ratio)} times expected, 90% interval ${f2(b.ci_low)} to ` +
        `${f2(b.ci_high)}). Treat a band as different from expected only if its interval excludes 1.`);
    }
  }

  const table = openingTable(rows);
  const branchFact = (r: OpeningRow) => {
    const b = worstBranch(rows, r.color, r.family);
    if (!b) return;
    add("branch", `In the ${r.family} ${side(r.color)}, after ${formatMoves(b.moves)} you scored ` +
      `${pct(b.score)} in ${b.n} games versus ${pct(b.expected)} expected.`, { color: r.color, family: r.family });
  };
  if (table.length) {
    const weak = table.filter(r => r.verdict === "weakness" || r.verdict === "possible weakness").slice(0, 3);
    const watch = table.filter(r => r.verdict === "worth watching").slice(0, 2);
    const strong = table.filter(r => r.verdict === "strength" || r.verdict === "possible strength")
      .slice().sort((a, b) => b.shrunk - a.shrunk).slice(0, 2);
    for (const r of [...weak, ...strong]) {
      add("opening", `${r.family} ${side(r.color)}: ${r.n} games, scored ${pct(r.score)} versus ` +
        `${pct(r.expected)} expected. Rating-adjusted gap after shrinkage: ${pts(r.shrunk)} points ` +
        `(90% interval ${pts(r.ci_low)} to ${pts(r.ci_high)}). Verdict: ${r.verdict}.`,
        { color: r.color, family: r.family });
      if (r.verdict.endsWith("weakness")) branchFact(r);
    }
    for (const r of watch) {
      add("opening", `${r.family} ${side(r.color)}: ${r.n} games, scored ${pct(r.score)} versus ` +
        `${pct(r.expected)} expected (${pts(r.mean_resid)} points unadjusted). Verdict: worth watching. ` +
        `On its own this is unlikely to be chance, but among the ${r.n_openings} openings checked one ` +
        `result this extreme is expected by luck alone; more games will tell.`, { color: r.color, family: r.family });
      branchFact(r);
    }
    if (!weak.length) {
      add("opening", "No opening family shows a weakness that is clear after adjusting for opponent " +
        "rating, sample size and the number of openings checked.");
    }
  }

  if (analyses) {
    const ps = phaseSummary(analyses), opp = phaseSummary(analyses, false);
    for (const [p, s] of Object.entries(ps)) {
      if (!s.moves) continue;
      const q = opp[p];
      add("phase", `In the ${p} you lose an average of ${f1(s.avg_loss)} win% per move, with a blunder ` +
        `(a drop of ${BLUNDER_DROP} win% or more) on ${f1(100 * s.blunder_rate)}% of moves (${s.moves} moves ` +
        `analysed). Your opponents: ${f1(q.avg_loss)} win% per move, blunders on ${f1(100 * q.blunder_rate)}% of moves.`);
    }
    let worstPhase: string | null = null;
    for (const [p, s] of Object.entries(ps)) {
      if (s.moves && (worstPhase === null || s.avg_loss > ps[worstPhase].avg_loss)) worstPhase = p;
    }
    const allUrls = new Set(analyses.map(a => a.url));
    const base = openingExit(analyses, allUrls);
    for (const f of facts.filter(f => f.kind === "opening" && f.family)) {
      const urls = new Set(rows.filter(r => r.color === f.color && r.family === f.family && allUrls.has(r.url)).map(r => r.url));
      const ex = openingExit(analyses, urls);
      if (ex && base && ex.games >= 3) {
        add("exit", `In your ${f.family} games ${side(f.color!)}, the engine eval after move 12 had a median ` +
          `of ${pawns(ex.eval12)} pawns for you; in moves 13-25 you lost ${f1(ex.loss13_25)} win% per move, ` +
          `versus ${f1(base.loss13_25)} across all your games.`, { color: f.color, family: f.family });
      }
    }
    for (const m of worstBlunders(analyses, 3)) {
      if (m.wp_loss < BLUNDER_DROP) break;
      const best = m.best ? `; the engine preferred ${m.best}` : "";
      add("blunder", `Your move ${moveLabel(m)} (${m.phase}) lost ${m.wp_loss.toFixed(0)} win%${best}. ` +
        `Game: ${m.url}`, { fen: m.fen });
    }
    const themes: string[] = [];
    if (worstPhase) themes.push(worstPhase);
    if (analyses.some(a => a.moves.some(m => m.wp_loss >= BLUNDER_DROP))) themes.push("blunders");
    for (const t of themes) {
      const [name, url] = PHASE_THEMES[t];
      add("puzzles", `Lichess puzzle theme '${name}': ${url}`);
    }
  }
  return facts;
}

export const factsText = (facts: Fact[]) => facts.map(f => `[${f.id}] ${f.text}`).join("\n");

// ---------- verifier (wf/verify.py) ----------

const CITE = /\[([FT]\d+)\]/g;
const URL_RE = /https?:\/\/\S+/g;
const MOVE = /(?<![\w.])(?:\d+\.(?:\.\.)?\s?)?(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|[a-h][1-8](?:=[QRBN])?)[+#]?(?!\w)/g;
const NUM = /(?<![\w.])[-+−]?\d+(?:\.\d+)?/g;
const LIST_MARK = /^\s*(?:\**\d+[.)]\**|[-*])\s+/gm;

const numbers = (text: string) => new Set(
  (text.replace(URL_RE, " ").replace(MOVE, " ").match(NUM) ?? []).map(n => Math.abs(parseFloat(n.replace("−", "-")))));
const moves = (text: string) => new Set(
  (text.replace(URL_RE, " ").match(MOVE) ?? []).map(m => m.replace(/^\d+\.(?:\.\.)?\s?/, "")));
const sentences = (text: string) =>
  text.replace(LIST_MARK, "").split(/(?<=[.!?])\s+(?=[A-Z*_#[])|\n+/).map(s => s.trim()).filter(Boolean);
const cleanUrl = (u: string) => u.replace(/[.,:;)\]>*_'"]+$/, "");

export interface Unsupported { type: string; claim: string | number; sentence: string; }
export interface Verification { checked: number; unsupported: Unsupported[]; bad_citations: string[]; unsupported_rate: number; ok: boolean; }

export function verify(output: string, facts: { id: string; text: string }[], requireCitation = true): Verification {
  const byId = new Map(facts.map(f => [f.id, f.text]));
  const allText = [...byId.values()].join(" ");
  const allNums = numbers(allText), allMoves = moves(allText);
  const factUrls = new Set((allText.match(URL_RE) ?? []).map(cleanUrl));
  const bad: string[] = [], unsupported: Unsupported[] = [];
  let checked = 0;
  for (const sent of sentences(output)) {
    const cites = [...sent.matchAll(CITE)].map(m => m[1]);
    bad.push(...cites.filter(c => !byId.has(c)));
    const scopeNums = numbers(cites.filter(c => byId.has(c)).map(c => byId.get(c)!).join(" "));
    const body = sent.replace(CITE, " ");
    for (const u of body.match(URL_RE) ?? []) {
      checked++;
      if (!factUrls.has(cleanUrl(u))) unsupported.push({ type: "url", claim: u, sentence: sent });
    }
    for (const mv of moves(body)) {
      checked++;
      if (!allMoves.has(mv)) unsupported.push({ type: "move", claim: mv, sentence: sent });
    }
    for (const n of numbers(body)) {
      checked++;
      if (scopeNums.has(n)) continue;
      if (allNums.has(n)) { if (requireCitation) unsupported.push({ type: "miscited number", claim: n, sentence: sent }); }
      else unsupported.push({ type: "number", claim: n, sentence: sent });
    }
  }
  const nBad = unsupported.length + bad.length;   // as in Python: repeated bad citations count each time
  return { checked, unsupported, bad_citations: [...new Set(bad)].sort(),
           unsupported_rate: checked ? nBad / checked : 0, ok: nBad === 0 };
}

export function feedback(v: Verification): string {
  return [
    ...v.unsupported.map(u => `- ${u.type} '${u.claim}' is not in the facts (sentence: '${u.sentence.slice(0, 120)}')`),
    ...v.bad_citations.map(c => `- citation [${c}] does not exist`),
  ].join("\n");
}
