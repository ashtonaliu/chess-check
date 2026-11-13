import { Chess } from "chess.js";
import { costUsd, describeError, makeClient, runCoach } from "./browser/coach";
import { analyzeInBrowser, STAGES } from "./browser/pipeline";
import { embed } from "./browser/search";

// Weakness Finder UI. Plain TypeScript, no framework. In the static demo the
// analysis runs in the browser (browser/pipeline.ts); with the Python server it
// comes from /api/analyze. Either way the page renders the same payload.

interface Opening {
  color: "white" | "black"; family: string; n: number;
  score: number; expected: number; raw: number; shrunk: number;
  ci_low: number; ci_high: number; p_below: number; verdict: string;
  branch: { moves: string; n: number; score: number; expected: number } | null;
}
interface Phase { moves: number; avg_loss: number; blunder_rate: number; }
interface Blunder { move: string; best: string | null; loss: number; phase: string; url: string; fen?: string; }
interface RiskBand { moves: number; actual: number; expected: number; ratio: number; ci_low?: number; ci_high?: number; }
interface Risk extends RiskBand { model?: string; buckets: (RiskBand & { label: string })[]; }
interface MotifStat { kind: string; motif: string; me: number; opp: number; ratio: number | null; ci_low: number | null; ci_high: number | null; verdict: string; higher: boolean; }
interface PieceStat { piece: string; moves: number; blunders: number; rate: number; opp_moves: number; opp_blunders: number; opp_rate: number | null; ratio: number | null; ci_low: number | null; ci_high: number | null; verdict: string; }
interface Example { url: string; ply: number; move_no: number; san: string; wp_loss: number; phase: string; best: string | null; refutation: string | null; fen: string; allowed: string[]; missed: string[]; fork_by?: string; }
interface Tactics {
  motifs: MotifStat[]; pieces: PieceStat[]; forks_allowed_by: Record<string, number>; pieces_lost: Record<string, number>;
  examples: Record<string, Example>; flagged: number; confirmed: number; deep: boolean; deep_depth: number;
  n_tests: number; moves_me: number; moves_opp: number;
}
interface Fact { id: string; text: string; }
interface Payload {
  username: string; generated_at?: string; time_class?: string | null;
  overall: { games: number; score: number; expected: number; resid: number; avg_rating: number; se: number | null };
  openings: Opening[]; phases: Record<string, Phase> | null; blunders: Blunder[];
  risk: Risk | null; facts: Fact[]; engine: boolean; tactics?: Tactics | null;
}
interface Unsupported { type: string; claim: string | number; sentence: string; }
interface Verification { checked: number; unsupported: Unsupported[]; bad_citations: string[]; ok: boolean; unsupported_rate: number; }
interface CoachResp {
  report: string; verification: Verification; first_verification: Verification;
  repaired: boolean; tool_calls: { name: string; input: Record<string, unknown> }[];
  facts: Fact[]; username?: string; backend?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pct = (x: number) => `${Math.round(100 * x)}%`;
const pts = (x: number) => { const v = Math.round(100 * x); return v > 0 ? `+${v}` : `${v}`; };
const esc = (s: string) => s.replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const side = (c: string) => (c === "white" ? "as White" : "as Black");
const cap1 = (s: string) => s[0].toUpperCase() + s.slice(1);

interface StaticConfig { analysis: string; report: string; repo: string; browser?: boolean; }
const STATIC = (window as unknown as { WF_STATIC?: StaticConfig }).WF_STATIC ?? null;
const ENGINE_URL = new URL("engine/stockfish-19-lite-single.js", import.meta.url).href;
const BROWSER_DEPTH = 8;

let lastReq: { username: string; games: number; time_class: string | null } | null = null;
let current: Payload | null = null;

function setStatus(msg: string, error = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (error ? " error" : "");
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail ?? detail; } catch { /* not JSON */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return r.json() as Promise<T>;
}

function card(label: string, value: string, detail = "", cls = ""): string {
  return `<div class="card"><div class="label">${esc(label)}</div>
    <div class="value ${cls}">${esc(value)}</div><div class="detail">${esc(detail)}</div></div>`;
}

// ---------- progress ----------

function showProgress(stage: number | null, frac: number | null, text: string) {
  $("progress").hidden = stage === null;
  if (stage === null) return;
  $("steps").innerHTML = STAGES.map((s, i) =>
    `<li class="${i < stage ? "done" : i === stage ? "active" : ""}">${esc(s)}</li>`).join("");
  const fill = $("barFill");
  if (frac === null) { fill.classList.add("indeterminate"); fill.style.width = ""; }
  else { fill.classList.remove("indeterminate"); fill.style.width = `${Math.round(100 * ((stage + frac) / STAGES.length))}%`; }
  $("progressText").textContent = text;
}

// ---------- key findings ----------

const PLURAL: Record<string, string> = { mate: "forced mates", fork: "forks", skewer: "skewers",
  discoveredAttack: "discovered attacks", hangingPiece: "free pieces", promotion: "pawn promotions" };
const PUZZLE: Record<string, string> = { mate: "mate", fork: "fork", skewer: "skewer", discoveredAttack: "discoveredAttack",
  hangingPiece: "hangingPiece", promotion: "promotion" };
interface Finding { level: "weak" | "watch" | "good" | "info"; title: string; detail: string; link?: [string, string]; score: number; }
const TAG = { weak: "Weakness", watch: "Worth watching", good: "Strength", info: "Overview" };
const rx = (r: number | null) => (r === null ? "" : `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`);

function findings(p: Payload): Finding[] {
  const out: Finding[] = [];
  const t = p.tactics;
  for (const m of t?.motifs ?? []) {
    if (m.verdict === "no difference") continue;
    const level = m.higher ? (m.verdict === "pattern" ? "weak" : "watch") : "good";
    const what = PLURAL[m.motif];
    const title = m.higher
      ? (m.kind === "missed" ? `You miss ${what}` : `You walk into ${what}`)
      : (m.kind === "missed" ? `You rarely miss ${what}` : `You rarely allow ${what}`);
    const detail = `${m.me} times vs ${m.opp} for your opponents in the same games` + (m.ratio !== null && m.higher ? ` (${rx(m.ratio)} their rate).` : ".");
    out.push({ level, title, detail, score: (level === "weak" ? 300 : level === "watch" ? 200 : 0) + m.me,
      link: m.higher ? [`Practice ${what}`, `https://lichess.org/training/${PUZZLE[m.motif]}`] : undefined });
  }
  for (const pc of t?.pieces ?? []) {
    if (pc.verdict === "no difference" || pc.ratio === null) continue;
    const higher = pc.ratio > 1;
    out.push({ level: higher ? (pc.verdict === "pattern" ? "weak" : "watch") : "good",
      title: higher ? `Your ${pc.piece} moves blunder more` : `Your ${pc.piece} moves are safe`,
      detail: `${(100 * pc.rate).toFixed(1)}% of ${pc.piece} moves are blunders vs ${(100 * (pc.opp_rate ?? 0)).toFixed(1)}% for your opponents.`,
      score: higher ? 250 : 5 });
  }
  for (const o of p.openings) {
    if (o.verdict.endsWith("weakness") || o.verdict === "worth watching") {
      const firm = o.verdict === "weakness";   // "possible weakness" and "worth watching" stay amber
      out.push({ level: firm ? "weak" : "watch", title: `${o.family} ${side(o.color)}`,
        detail: `You scored ${pct(o.score)} in ${o.n} games where your ratings predicted ${pct(o.expected)}.` +
          (firm ? "" : " Too few games to be sure."),
        score: firm ? 290 : 190 - (o.verdict === "worth watching" ? 0 : 5) + o.n / 100 });
    } else if (o.verdict.endsWith("strength")) {
      out.push({ level: "good", title: `${o.family} ${side(o.color)}`,
        detail: `You scored ${pct(o.score)} in ${o.n} games against an expected ${pct(o.expected)}.`, score: 10 + o.n / 100 });
    }
  }
  for (const b of p.risk?.buckets ?? []) {
    if (b.ci_low === undefined || b.ci_high === undefined || !b.label.startsWith("under 10%")) continue;
    if (b.ci_low > 1) out.push({ level: "weak", title: "You blunder more in time trouble", detail: `With ${b.label}: ${b.actual} blunders vs ${b.expected.toFixed(0)} expected.`, score: 280 });
    else if (b.ci_high < 1) out.push({ level: "good", title: "You handle time trouble well", detail: `With ${b.label}: ${b.actual} blunders vs ${b.expected.toFixed(0)} expected.`, score: 8 });
  }
  const problems = out.filter(f => f.level !== "good").sort((a, b) => b.score - a.score);
  const goods = out.filter(f => f.level === "good").sort((a, b) => b.score - a.score);
  const shown = [...problems.slice(0, 3), ...goods.slice(0, problems.length ? 1 : 3)];
  if (!problems.length) {
    shown.unshift({ level: "info", title: "No clear weakness", score: 0,
      detail: `You scored ${pct(p.overall.score)} where your ratings predicted ${pct(p.overall.expected)}, and no tactic, piece or opening stands out from your opponents.` });
  }
  return shown.slice(0, 4);
}

function renderOverview(p: Payload) {
  const o = p.overall;
  $("player").innerHTML = `<h2>${esc(p.username)}</h2><span class="meta">${o.games} ${esc(p.time_class ?? "")} games ·
    average rating ${o.avg_rating} · scored ${pct(o.score)} against an expected ${pct(o.expected)}</span>`;
  $("findings").innerHTML = findings(p).map(f => `<article class="finding ${f.level}">
      <div class="tag">${TAG[f.level]}</div><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p>
      ${f.link ? `<a href="${esc(f.link[1])}" target="_blank" rel="noopener">${esc(f.link[0])} on Lichess →</a>` : ""}
    </article>`).join("");
}

// ---------- board diagrams ----------

const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const sqXY = (sq: string, flip: boolean) => {
  const f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1;
  return flip ? [7 - f, r] : [f, 7 - r];
};

/** SVG board for a FEN, oriented for `flip` (Black at the bottom), with move arrows. */
function boardSvg(fen: string, flip: boolean, arrows: { from: string; to: string; color: string }[]): string {
  const S = 40, rows = fen.split(" ")[0].split("/");
  let svg = `<svg class="board" viewBox="0 0 ${8 * S} ${8 * S}" role="img" aria-label="Chess position">`;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    svg += `<rect x="${x * S}" y="${y * S}" width="${S}" height="${S}" fill="var(${(x + y) % 2 ? "--sq-dark" : "--sq-light"})"/>`;
  }
  rows.forEach((row, ri) => {
    let fi = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { fi += Number(ch); continue; }
      const sq = String.fromCharCode(97 + fi) + String(8 - ri);
      const [x, y] = sqXY(sq, flip);
      const white = ch === ch.toUpperCase();
      svg += `<text x="${x * S + S / 2}" y="${y * S + S * 0.78}" text-anchor="middle" font-size="${S * 0.82}"
        fill="${white ? "#fafaf7" : "#1b1d1c"}" stroke="${white ? "#1b1d1c" : "none"}" stroke-width="${white ? 1.1 : 0}"
        style="font-family:'Segoe UI Symbol','Noto Sans Symbols 2','DejaVu Sans',sans-serif">${GLYPH[ch.toLowerCase()]}</text>`;
      fi++;
    }
  });
  arrows.forEach((a, i) => {
    const [x1, y1] = sqXY(a.from, flip), [x2, y2] = sqXY(a.to, flip);
    const cx1 = x1 * S + S / 2, cy1 = y1 * S + S / 2, cx2 = x2 * S + S / 2, cy2 = y2 * S + S / 2;
    const len = Math.hypot(cx2 - cx1, cy2 - cy1) || 1, sx = cx2 - (cx2 - cx1) / len * 12, sy = cy2 - (cy2 - cy1) / len * 12;
    svg += `<defs><marker id="ah${i}${a.color}" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto">
      <path d="M0,0 L4,2 L0,4 z" fill="${a.color}"/></marker></defs>
      <line x1="${cx1}" y1="${cy1}" x2="${sx}" y2="${sy}" stroke="${a.color}" stroke-width="7" stroke-linecap="round"
        opacity=".8" marker-end="url(#ah${i}${a.color})"/>`;
  });
  return svg + "</svg>";
}

function moveSquares(fen: string, san: string | null): { from: string; to: string } | null {
  if (!san) return null;
  try { const m = new Chess(fen).move(san); return { from: m.from, to: m.to }; } catch { return null; }
}

function exampleCard(e: { fen: string; ply: number; move_no: number; san: string; wp_loss: number; best: string | null; url: string },
                     caption: string): string {
  const flip = e.ply % 2 === 1;
  const played = moveSquares(e.fen, e.san), best = e.best && e.best !== e.san ? moveSquares(e.fen, e.best) : null;
  const arrows = [...(played ? [{ ...played, color: "#d0452f" }] : []), ...(best ? [{ ...best, color: "#2f9a5a" }] : [])];
  const label = e.ply % 2 === 0 ? `${e.move_no}.${e.san}` : `${e.move_no}...${e.san}`;
  return `<div class="example">${boardSvg(e.fen, flip, arrows)}
    <div class="cap"><span class="moves">${esc(label)}</span> lost <strong class="weak">${Math.round(e.wp_loss)}%</strong> winning chances.
      ${caption}</div>
    <div class="keyline"><span style="color:#d0452f">●</span> your move${best ? ` &nbsp;<span style="color:#2f9a5a">●</span> better: <span class="moves">${esc(e.best!)}</span>` : ""}
      · <a href="${esc(e.url)}" target="_blank" rel="noopener">open game</a></div></div>`;
}

// ---------- tactics tab ----------

const LABEL: Record<string, string> = { mate: "Forced mate", fork: "Fork", skewer: "Skewer",
  discoveredAttack: "Discovered attack", hangingPiece: "Free piece", promotion: "Promotion" };
const PIECE_ICON: Record<string, string> = { pawn: "♟", knight: "♞", bishop: "♝", rook: "♜", queen: "♛", king: "♚" };

function chip(verdict: string, higher: boolean): string {
  if (verdict === "no difference") return `<span class="chip">normal</span>`;
  const cls = !higher ? "good" : verdict === "pattern" ? "weak" : "watch";
  const text = !higher ? "better" : verdict === "pattern" ? "pattern" : "watch";
  return `<span class="chip ${cls}">${text}</span>`;
}

function renderTactics(p: Payload) {
  const t = p.tactics;
  const el = $("tactics");
  if (!t) { el.innerHTML = `<p class="note">Tactic analysis needs the engine, which was not available for this analysis.</p>`; return; }
  const per1k = (n: number, moves: number) => (moves ? (1000 * n) / moves : 0);
  const motifBox = (kind: "allowed" | "missed", title: string, sub: string) => {
    const rows = t.motifs.filter(m => m.kind === kind);
    if (!rows.length) return `<div class="box"><h3>${title}</h3><p class="note">${sub}</p><p class="note">None found.</p></div>`;
    const max = Math.max(...rows.flatMap(m => [per1k(m.me, t.moves_me), per1k(m.opp, t.moves_opp)]), 0.001);
    return `<div class="box"><h3>${title}</h3><p class="note">${sub}</p>
      <div class="legend"><span><i style="background:var(--you)"></i>you</span><span><i style="background:var(--opp)"></i>your opponents</span></div>` +
      rows.map(m => `<div class="row" title="${m.ratio !== null ? `${rx(m.ratio)} your opponents' rate; 90% range ${m.ci_low?.toFixed(2)} to ${m.ci_high?.toFixed(2)}` : ""}">
        <div class="name">${esc(LABEL[m.motif])}</div>
        <div class="bars"><span class="you" style="width:${(100 * per1k(m.me, t.moves_me) / max).toFixed(1)}%"></span>
          <span class="opp" style="width:${(100 * per1k(m.opp, t.moves_opp) / max).toFixed(1)}%"></span></div>
        <div class="num">${m.me} vs ${m.opp} ${chip(m.verdict, m.higher)}</div></div>`).join("") + `</div>`;
  };
  const pieceMax = Math.max(...t.pieces.flatMap(pc => [pc.rate, pc.opp_rate ?? 0]), 0.001);
  const pieces = `<div class="box"><h3>Blunders by the piece you moved</h3>
    <p class="note">Share of moves with each piece that were blunders.</p>
    <div class="legend"><span><i style="background:var(--you)"></i>you</span><span><i style="background:var(--opp)"></i>your opponents</span></div>` +
    t.pieces.map(pc => `<div class="row"><div class="name">${PIECE_ICON[pc.piece]} ${cap1(pc.piece)}</div>
      <div class="bars"><span class="you" style="width:${(100 * pc.rate / pieceMax).toFixed(1)}%"></span>
        <span class="opp" style="width:${(100 * (pc.opp_rate ?? 0) / pieceMax).toFixed(1)}%"></span></div>
      <div class="num">${(100 * pc.rate).toFixed(1)}% vs ${(100 * (pc.opp_rate ?? 0)).toFixed(1)}% ${chip(pc.verdict, (pc.ratio ?? 1) > 1)}</div></div>`).join("") +
    (Object.keys(t.forks_allowed_by).length ? `<p class="note" style="margin-top:12px">Forks you walked into, by the forking piece:</p>
      <div class="forkchips">${Object.entries(t.forks_allowed_by).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<span class="chip">${PIECE_ICON[k]} ${k} ${v}</span>`).join("")}</div>` : "") + `</div>`;

  // examples: flagged problems first, then the most common things you walked into
  const keys = t.motifs.filter(m => m.verdict !== "no difference" && m.higher).map(m => `${m.kind}:${m.motif}`);
  // then the most common things you walked into, skipping ones you are better at than your opponents
  for (const m of t.motifs.filter(m => m.kind === "allowed" && !(m.verdict !== "no difference" && !m.higher))
    .sort((a, b) => b.me - a.me)) keys.push(`allowed:${m.motif}`);
  const seen = new Set<string>(), cards: string[] = [];
  for (const k of keys) {
    const e = t.examples[k];
    if (!e || seen.has(e.url + e.ply) || cards.length >= 3) continue;
    seen.add(e.url + e.ply);
    const [kind, motif] = k.split(":");
    const what = kind === "missed"
      ? `You missed a ${LABEL[motif].toLowerCase()}.`
      : `This allowed a ${LABEL[motif].toLowerCase()}${e.fork_by && motif === "fork" ? ` by the ${e.fork_by}` : ""}${e.refutation ? ` (${e.refutation})` : ""}.`;
    cards.push(exampleCard(e, what));
  }
  el.innerHTML = `<p class="note">Based on ${t.confirmed} blunders${t.deep ? ` confirmed by a deeper engine check (depth ${t.deep_depth})` : ""},
      compared with your opponents in the same games. "Pattern" holds even after correcting for all ${t.n_tests} comparisons.</p>
    <div class="tgrid">${motifBox("allowed", "What you walk into", "Tactics your opponent could play right after your blunder.")}
      ${motifBox("missed", "What you miss", "Tactics you could have played instead of your blunder.")}${pieces}</div>
    ${cards.length ? `<h3 class="sub-title">Examples from your games</h3><div class="examples">${cards.join("")}</div>` : ""}`;
}

// ---------- openings, phases, coach ----------

function renderForest(rows: Opening[]) {
  const el = $("forest");
  if (!rows.length) { el.innerHTML = `<p class="note">Not enough games per opening yet (need at least 3).</p>`; return; }
  const shown = rows.slice(0, 14);
  const W = 900, rowH = 30, top = 28, left = 260, right = 70;
  const H = top + shown.length * rowH + 30;
  const lim = Math.max(0.15, ...shown.map(r => Math.max(Math.abs(r.ci_low), Math.abs(r.ci_high), Math.abs(r.raw)))) * 1.05;
  const x = (v: number) => left + ((v + lim) / (2 * lim)) * (W - left - right);
  const color = (r: Opening) => r.verdict.endsWith("weakness") ? "var(--weak)"
    : r.verdict === "worth watching" ? "var(--watch)" : r.verdict.endsWith("strength") ? "var(--good)" : "var(--neutral)";
  const ticks = [-lim, -lim / 2, 0, lim / 2, lim].map(t => Math.round(t * 100) / 100);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating-adjusted score by opening">`;
  svg += `<line class="zero" x1="${x(0)}" x2="${x(0)}" y1="${top - 8}" y2="${H - 24}"/>`;
  for (const t of ticks) svg += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${pts(t)}</text>`;
  svg += `<text x="${x(-lim)}" y="16">worse than rating predicts</text><text x="${x(lim)}" y="16" text-anchor="end">better</text>`;
  shown.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2, c = color(r);
    svg += `<text x="8" y="${y + 4}">${esc(r.family)} <tspan fill="var(--muted)">${side(r.color)} · ${r.n}</tspan></text>`;
    svg += `<line x1="${x(r.ci_low)}" x2="${x(r.ci_high)}" y1="${y}" y2="${y}" stroke="${c}" stroke-width="3" stroke-linecap="round" opacity=".45"/>`;
    svg += `<circle cx="${x(Math.max(-lim, Math.min(lim, r.raw)))}" cy="${y}" r="4" fill="none" stroke="${c}"/>`;
    svg += `<circle cx="${x(r.shrunk)}" cy="${y}" r="6" fill="${c}"><title>${esc(
      `${r.family} ${side(r.color)}: scored ${pct(r.score)} vs ${pct(r.expected)} expected in ${r.n} games. ` +
      `Adjusted ${pts(r.shrunk)} (90%: ${pts(r.ci_low)} to ${pts(r.ci_high)}). ${r.verdict}.`)}</title></circle>`;
    svg += `<text x="${W - 8}" y="${y + 4}" text-anchor="end" fill="${c}">${pts(r.shrunk)}</text>`;
  });
  el.innerHTML = svg + "</svg>";
  $("branches").innerHTML = rows.filter(r => r.branch).map(r => {
    const b = r.branch!;
    const tag = r.verdict === "worth watching" ? ` <span class="chip watch">worth watching</span>` : "";
    return `<div class="branch"><strong>${esc(r.family)} ${side(r.color)}</strong>${tag}: you score
      <strong class="weak">${pct(b.score)}</strong> (expected ${pct(b.expected)}, ${b.n} games) after <span class="moves">${esc(b.moves)}</span></div>`;
  }).join("");
}

const riskCls = (r: RiskBand) => r.ci_low === undefined ? "" : (r.ci_low > 1 ? "weak" : r.ci_high! < 1 ? "goodtxt" : "");
const ratioText = (r: RiskBand) => `${r.ratio.toFixed(2)}×` +
  (r.ci_low !== undefined ? ` <span class="ci">(${r.ci_low.toFixed(2)}–${r.ci_high!.toFixed(2)})</span>` : "");

function renderPhases(p: Payload) {
  if (!p.phases) { $("phases").innerHTML = `<p class="note">Engine analysis was not available.</p>`; return; }
  const worst = Object.entries(p.phases).filter(([, v]) => v.moves).sort((a, b) => b[1].avg_loss - a[1].avg_loss)[0]?.[0];
  $("phases").innerHTML = Object.entries(p.phases).filter(([, v]) => v.moves).map(([k, v]) =>
    card(cap1(k), `${(100 * v.blunder_rate).toFixed(1)}% blunders`, `${v.avg_loss.toFixed(1)}% winning chances lost per move, ${v.moves} moves`,
      k === worst ? "weak" : "")).join("");
  $("risk").innerHTML = p.risk && p.risk.buckets.length ? `<table><thead><tr><th>Clock left</th><th class="num">Moves</th>
      <th class="num">Blunders</th><th class="num">Expected</th><th class="num">Ratio (90% range)</th></tr></thead><tbody>` +
    p.risk.buckets.map(b => `<tr><td>${esc(b.label.replace(" of the clock left", ""))}</td><td class="num">${b.moves}</td>
      <td class="num">${b.actual}</td><td class="num">${b.expected.toFixed(1)}</td><td class="num ${riskCls(b)}">${ratioText(b)}</td></tr>`).join("") +
    `</tbody></table><p class="note" style="margin-top:8px">"Expected" comes from a ${esc(p.risk.model ?? "machine learning")} model trained on your
    opponents' moves in the same situations. A band is highlighted only when its 90% range excludes 1.</p>`
    : `<p class="note">Not enough clock data.</p>`;
  $("blunders").innerHTML = p.blunders.filter(b => b.fen).slice(0, 3).map(b => {
    const san = b.move.replace(/^\d+\.(\.\.)?/, ""), m = b.move.match(/^(\d+)\.(\.\.)?/);
    const ply = m ? (Number(m[1]) - 1) * 2 + (m[2] ? 1 : 0) : 0;
    return exampleCard({ fen: b.fen!, ply, move_no: m ? Number(m[1]) : 1, san, wp_loss: b.loss, best: b.best, url: b.url }, `In the ${b.phase}.`);
  }).join("") || `<p class="note">No blunders found.</p>`;
}

// Minimal Markdown: headings, bullets, bold, links, [F#]/[T#] citations.
function renderMarkdown(md: string, facts: Map<string, string>): string {
  const inline = (s: string) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\[([FT]\d+)\]/g, (_m, id: string) => `<span class="cite" title="${esc(facts.get(id) ?? "unknown citation")}">${id}</span>`);
  const out: string[] = [];
  let inList = false;
  for (const line of md.split("\n")) {
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (inList) { out.push("</ul>"); inList = false; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) out.push(`<h2>${inline(h[2])}</h2>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

function renderCoach(c: CoachResp, example = false, footnote = "") {
  const facts = new Map(c.facts.map(f => [f.id, f.text]));
  const shown = ($("username") as HTMLInputElement).value.trim().toLowerCase();
  const other = example && c.username && shown && shown !== c.username.toLowerCase()
    ? ` For <strong>${esc(shown)}</strong>, add an API key above to write a live report.` : "";
  const banner = example ? `<p class="verify ok">This is a saved example report for <strong>${esc(c.username ?? "")}</strong>.${other}</p>` : "";
  const v = c.verification, first = c.first_verification;
  const issues = v.unsupported.map(u => `<li>${esc(u.type)} <code>${esc(String(u.claim))}</code></li>`).join("");
  const repairNote = c.repaired
    ? ` The first draft had ${first.unsupported.length + first.bad_citations.length} unsupported claim(s); the coach fixed them.` : "";
  const tools = c.tool_calls.length ? ` Tools used: ${c.tool_calls.map(t => esc(t.name)).join(", ")}.` : "";
  $("coach").innerHTML = `${banner}<div class="report">${renderMarkdown(c.report, facts)}</div>
    <div class="verify ${v.ok ? "ok" : "bad"}"><strong>${v.ok ? "Verified" : "Not fully verified"}:</strong> ${v.checked} numbers, moves
      and links checked, ${v.unsupported.length + v.bad_citations.length} unsupported.${repairNote}${tools}
      ${issues ? `<ul>${issues}</ul>` : ""}${footnote ? `<br><span class="ci">${esc(footnote)}</span>` : ""}</div>`;
}

// ---------- tabs ----------

function selectTab(name: string) {
  for (const t of ["tactics", "openings", "phases", "coach"]) {
    $(`t-${t}`).setAttribute("aria-selected", String(t === name));
    $(`tab-${t}`).hidden = t !== name;
  }
}
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach(b =>
  b.addEventListener("click", () => selectTab(b.id.slice(2))));

function render(p: Payload) {
  current = p;
  renderOverview(p);
  renderTactics(p);
  renderForest(p.openings);
  renderPhases(p);
  $("results").hidden = false;
}

// ---------- flows ----------

async function analyze(ev: Event) {
  ev.preventDefault();
  const username = ($("username") as HTMLInputElement).value.trim();
  const time_class = ($("time_class") as HTMLSelectElement).value || null;
  const games = Number(($("games") as HTMLSelectElement).value);
  const btn = $("go") as HTMLButtonElement;
  btn.disabled = true;
  $("coach").innerHTML = "";
  setStatus("");
  try {
    let p: Payload;
    if (STATIC?.browser) {
      showProgress(0, null, `Fetching ${username}'s games from Chess.com…`);
      p = await analyzeInBrowser({ username, games, timeClass: time_class, depth: BROWSER_DEPTH, engineUrl: ENGINE_URL,
        onStatus: () => undefined, onProgress: (stage, frac, text) => showProgress(stage, frac, text) });
      browserRun = p as Awaited<ReturnType<typeof analyzeInBrowser>>;
      $("keyBox").hidden = false;
      ($("coachBtn") as HTMLButtonElement).textContent = `Write ${p.username}'s coaching report`;
      $("snapshot").innerHTML = `<span><strong>Analyzed in your browser.</strong> Stockfish ran on your computer over ${p.overall.games} games
        (depth ${BROWSER_DEPTH}, with blunders double-checked deeper). Nothing was sent anywhere except the requests to Chess.com.
        The browser uses Stockfish's smaller network, so its numbers run slightly lower than the saved example's.</span>`;
      $("snapshot").hidden = false;
    } else {
      showProgress(1, null, "Running Stockfish on every move. This takes 15 to 60 seconds…");
      p = await post<Payload>("/api/analyze", { username, games, time_class });
    }
    lastReq = { username, games, time_class };
    render(p);
    selectTab("tactics");
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    setStatus((e as Error).message, true);
  } finally {
    showProgress(null, null, "");
    btn.disabled = false;
  }
}

let coachBackend: string | null | undefined = undefined;  // undefined until /api/coach/status answers
// The latest in-browser analysis, which the bring-your-own-key coach works from.
let browserRun: Awaited<ReturnType<typeof analyzeInBrowser>> | null = null;

async function browserCoach() {
  const run = browserRun!;
  const key = ($("apiKey") as HTMLInputElement).value.trim();
  if (!key) { $("coach").innerHTML = `<p class="weak">Paste an Anthropic API key above first.</p>`; return; }
  const btn = $("coachBtn") as HTMLButtonElement;
  btn.disabled = true;
  const status = (m: string) => { $("coach").innerHTML = `<p class="note">${esc(m)}</p>`; };
  try {
    const res = await runCoach({ client: await makeClient(key), username: run.username, facts: run.facts,
      games: run.gameRows, moves: run.moveRows, engineUrl: ENGINE_URL, onStatus: status, summaries: run.summaries });
    renderCoach({ ...res, username: run.username }, false,
      `Cost: about $${costUsd(res.usage).toFixed(2)} on your key (${res.usage.input_tokens.toLocaleString()} input and ` +
      `${res.usage.output_tokens.toLocaleString()} output tokens, Claude Opus 5.5).`);
  } catch (e) {
    $("coach").innerHTML = `<p class="weak">${esc(describeError(e))}</p>`;
  } finally {
    btn.disabled = false;
  }
}

async function coach() {
  if (STATIC?.browser && browserRun) { await browserCoach(); return; }
  if (coachBackend === null) { await showExample(); return; }
  if (!lastReq) return;
  const btn = $("coachBtn") as HTMLButtonElement;
  btn.disabled = true;
  $("coach").innerHTML = `<p class="note">The coach is querying your games and writing the report…</p>`;
  try { renderCoach(await post<CoachResp>("/api/coach", lastReq)); }
  catch (e) { $("coach").innerHTML = `<p class="weak">${esc((e as Error).message)}</p>`; }
  finally { btn.disabled = false; }
}

async function showExample() {
  try {
    const r = await fetch(STATIC ? STATIC.report : "/api/coach/example");
    if (!r.ok) throw new Error("Live coaching isn't enabled on this server.");
    renderCoach(await r.json() as CoachResp, true);
  } catch (e) {
    $("coach").innerHTML = `<p class="weak">${esc((e as Error).message)}</p>`;
  }
}

async function initCoach() {
  if (STATIC) { coachBackend = null; ($("coachBtn") as HTMLButtonElement).textContent = "Show the saved coaching report"; return; }
  try {
    const s = await (await fetch("/api/coach/status")).json() as { backend: string | null; example: boolean };
    coachBackend = s.backend;
    if (s.backend === null) {
      ($("coachBtn") as HTMLButtonElement).textContent = s.example ? "Show an example report" : "Coaching unavailable";
      ($("coachBtn") as HTMLButtonElement).disabled = !s.example;
    }
  } catch { /* leave defaults */ }
}

// Static demo (GitHub Pages): opens on a saved analysis; any username runs in the browser.
async function initStatic(cfg: StaticConfig) {
  if (!cfg.browser) for (const el of Array.from(($("form") as HTMLFormElement).elements)) (el as HTMLInputElement).disabled = true;
  try {
    const p = await (await fetch(cfg.analysis)).json() as Payload;
    const qsUser = new URLSearchParams(location.search).get("u");
    ($("username") as HTMLInputElement).value = qsUser || "";
    ($("username") as HTMLInputElement).placeholder = `Chess.com username, e.g. ${p.username}`;
    if (p.time_class) ($("time_class") as HTMLSelectElement).value = p.time_class;
    render(p);
    const when = p.generated_at ? new Date(p.generated_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
    $("snapshot").innerHTML = `<span><strong>Example below:</strong> a saved analysis of ${esc(p.username)}'s last ${p.overall.games}
      ${esc(p.time_class ?? "")} games${when ? ` (${esc(when)})` : ""}. ` + (cfg.browser
      ? `Enter any Chess.com username above to analyze it right here.`
      : `The full app runs locally: <a href="${esc(cfg.repo)}" target="_blank" rel="noopener">setup on GitHub</a>.`) + `</span>`;
    $("snapshot").hidden = false;
    if (qsUser && cfg.browser && qsUser.toLowerCase() !== p.username.toLowerCase()) ($("form") as HTMLFormElement).requestSubmit();
  } catch (e) {
    setStatus(`Couldn't load the example: ${(e as Error).message}`, true);
  }
}

$("form").addEventListener("submit", analyze);
$("coachBtn").addEventListener("click", coach);
initCoach();
if (STATIC) initStatic(STATIC);
else { const qs = new URLSearchParams(location.search).get("u"); if (qs) ($("username") as HTMLInputElement).value = qs; }

// Debug hook (only with ?debug=1): lets the real coach tools (DuckDB-WASM, Stockfish)
// be exercised from the console with a scripted client, without an API key.
if (new URLSearchParams(location.search).get("debug") === "1") {
  (window as unknown as Record<string, unknown>).__wf = { runCoach, getRun: () => browserRun, engineUrl: ENGINE_URL, embed, current: () => current };
}
