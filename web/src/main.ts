import { costUsd, describeError, makeClient, runCoach } from "./browser/coach";
import { analyzeInBrowser } from "./browser/pipeline";
import { embed } from "./browser/search";

// Weakness Finder UI. Plain TypeScript, no framework: fetches /api/analyze and
// /api/coach and renders cards, an SVG forest plot and the verified report.

interface Opening {
  color: "white" | "black"; family: string; n: number;
  score: number; expected: number; raw: number; shrunk: number;
  ci_low: number; ci_high: number; p_below: number; verdict: string;
  branch: { moves: string; n: number; score: number; expected: number } | null;
}
interface Phase { moves: number; avg_loss: number; blunder_rate: number; }
interface Blunder { move: string; best: string | null; loss: number; phase: string; url: string; }
interface RiskBand { moves: number; actual: number; expected: number; ratio: number; ci_low?: number; ci_high?: number; }
interface Risk extends RiskBand { model?: string; buckets: (RiskBand & { label: string })[]; }
// Only call a ratio high or low when its 90% interval excludes 1.
const riskClass = (r: RiskBand) => r.ci_low === undefined
  ? (r.ratio > 1.15 ? "weak" : r.ratio < 0.85 ? "strong" : "")
  : (r.ci_low > 1 ? "weak" : r.ci_high! < 1 ? "strong" : "");
const ratioText = (r: RiskBand) => `${r.ratio.toFixed(2)}×` +
  (r.ci_low !== undefined ? ` <span class="ci">(${r.ci_low.toFixed(2)}–${r.ci_high!.toFixed(2)})</span>` : "");
interface Fact { id: string; text: string; }
interface Payload {
  username: string; generated_at?: string; time_class?: string | null;
  overall: { games: number; score: number; expected: number; resid: number; avg_rating: number; se: number | null };
  openings: Opening[]; phases: Record<string, Phase> | null; blunders: Blunder[];
  risk: Risk | null; facts: Fact[]; engine: boolean;
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

interface StaticConfig { analysis: string; report: string; repo: string; browser?: boolean; }
const STATIC = (window as unknown as { WF_STATIC?: StaticConfig }).WF_STATIC ?? null;
const ENGINE_URL = new URL("engine/stockfish-19-lite-single.js", import.meta.url).href;
const BROWSER_DEPTH = 8;

let lastReq: { username: string; games: number; time_class: string | null } | null = null;

function setStatus(msg: string, error = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = error ? "error" : "";
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

function renderSummary(p: Payload) {
  const o = p.overall;
  const html = [
    card("Games analysed", `${o.games}`, `average rating ${o.avg_rating}`),
    card("Score vs expected", `${pct(o.score)} / ${pct(o.expected)}`,
      `${pts(o.resid)} points against rating expectation`, o.resid < 0 ? "weak" : "strong"),
  ];
  const weak = p.openings.filter(x => x.verdict.endsWith("weakness"));
  const watch = p.openings.filter(x => x.verdict === "worth watching");
  const flagged = weak.length ? weak : watch;
  html.push(card(weak.length ? "Opening weaknesses" : "Openings worth watching", `${flagged.length}`,
    flagged.length ? flagged.slice(0, 2).map(w => `${w.family} ${side(w.color)}: ${pct(w.score)} vs ${pct(w.expected)} expected`).join("; ")
      : "none clear after adjusting for rating, sample size and number of openings", flagged.length ? "weak" : ""));
  if (p.risk) {
    html.push(card("Blunders vs model expectation", `${p.risk.ratio.toFixed(2)}×`,
      `${p.risk.actual} actual vs ${p.risk.expected.toFixed(1)} expected` +
      (p.risk.ci_low !== undefined ? `; 90% interval ${p.risk.ci_low.toFixed(2)}–${p.risk.ci_high!.toFixed(2)}` : ""),
      riskClass(p.risk)));
  }
  $("summary").innerHTML = html.join("");
}

function renderForest(rows: Opening[]) {
  const el = $("forest");
  if (!rows.length) { el.innerHTML = `<p class="note">Not enough games per opening yet (need at least 3).</p>`; return; }
  const shown = rows.slice(0, 14);
  const W = 900, rowH = 30, top = 28, left = 260, right = 70;
  const H = top + shown.length * rowH + 30;
  const lim = Math.max(0.15, ...shown.map(r => Math.max(Math.abs(r.ci_low), Math.abs(r.ci_high), Math.abs(r.raw)))) * 1.05;
  const x = (v: number) => left + ((v + lim) / (2 * lim)) * (W - left - right);
  const color = (r: Opening) => r.verdict.endsWith("weakness") ? "var(--weak)"
    : r.verdict === "worth watching" ? "var(--watch)"
    : r.verdict.endsWith("strength") ? "var(--strong)" : "var(--neutral)";
  const ticks = [-lim, -lim / 2, 0, lim / 2, lim].map(t => Math.round(t * 100) / 100);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating-adjusted score by opening">`;
  svg += `<line class="zero" x1="${x(0)}" x2="${x(0)}" y1="${top - 8}" y2="${H - 24}"/>`;
  for (const t of ticks) {
    svg += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${pts(t)}</text>`;
  }
  svg += `<text x="${x(-lim)}" y="16">worse than rating predicts</text>`;
  svg += `<text x="${x(lim)}" y="16" text-anchor="end">better</text>`;
  shown.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    const c = color(r);
    svg += `<text x="8" y="${y + 4}">${esc(r.family)} <tspan fill="var(--muted)">${side(r.color)} · ${r.n}</tspan></text>`;
    svg += `<line x1="${x(r.ci_low)}" x2="${x(r.ci_high)}" y1="${y}" y2="${y}" stroke="${c}" stroke-width="3" stroke-linecap="round" opacity=".45"/>`;
    svg += `<circle cx="${x(Math.max(-lim, Math.min(lim, r.raw)))}" cy="${y}" r="4" fill="none" stroke="${c}"/>`;
    svg += `<circle cx="${x(r.shrunk)}" cy="${y}" r="6" fill="${c}"><title>${esc(
      `${r.family} ${side(r.color)}: scored ${pct(r.score)} vs ${pct(r.expected)} expected in ${r.n} games. ` +
      `Adjusted ${pts(r.shrunk)} (90%: ${pts(r.ci_low)} to ${pts(r.ci_high)}). ${r.verdict}.`)}</title></circle>`;
    svg += `<text x="${W - 8}" y="${y + 4}" text-anchor="end" fill="${c}">${pts(r.shrunk)}</text>`;
  });
  svg += "</svg>";
  el.innerHTML = svg;

  $("branches").innerHTML = rows.filter(r => r.branch).map(r => {
    const b = r.branch!;
    const tag = r.verdict === "worth watching" ? ` <span class="chip">worth watching</span>` : "";
    return `<div class="branch"><strong>${esc(r.family)} ${side(r.color)}</strong>${tag}: you score
      <strong class="weak">${pct(b.score)}</strong> (expected ${pct(b.expected)}, ${b.n} games) after
      <span class="moves">${esc(b.moves)}</span></div>`;
  }).join("");
}

function renderEngine(p: Payload) {
  if (!p.phases) {
    $("phases").innerHTML = `<p class="note">Stockfish isn't available on this server, so engine analysis was skipped.</p>`;
    return;
  }
  const worst = Object.entries(p.phases).filter(([, v]) => v.moves)
    .sort((a, b) => b[1].avg_loss - a[1].avg_loss)[0]?.[0];
  $("phases").innerHTML = Object.entries(p.phases).filter(([, v]) => v.moves).map(([k, v]) =>
    card(k[0].toUpperCase() + k.slice(1), `${v.avg_loss.toFixed(1)} win%/move`,
      `blunders on ${(100 * v.blunder_rate).toFixed(1)}% of ${v.moves} moves`, k === worst ? "weak" : "")).join("");

  if (p.risk && p.risk.buckets.length) {
    $("risk").innerHTML = `<table><thead><tr><th>Clock</th><th class="num">Moves</th>
      <th class="num">Blunders</th><th class="num">Model expected</th><th class="num">Ratio (90% interval)</th></tr></thead><tbody>` +
      p.risk.buckets.map(b => `<tr><td>${esc(b.label)}</td><td class="num">${b.moves}</td>
        <td class="num">${b.actual}</td><td class="num">${b.expected.toFixed(1)}</td>
        <td class="num ${riskClass(b)}">${ratioText(b)}</td></tr>`).join("") +
      `</tbody></table><p class="note">"Expected" comes from a ${esc(p.risk.model ?? "gradient boosting")} model trained only on
      your opponents' moves (similar-rated players) and scored on your games in held-out folds. A ratio is highlighted only when its
      90% interval excludes 1; with few low-clock blunders, those intervals are wide.</p>`;
  }
  $("blunders").innerHTML = p.blunders.slice(0, 3).map(b =>
    `<div class="blunder"><span class="moves">${esc(b.move)}</span> <span class="chip">${esc(b.phase)}</span>
     lost <strong class="weak">${b.loss.toFixed(0)} win%</strong>${b.best ? `; Stockfish preferred <span class="moves">${esc(b.best)}</span>` : ""}
     · <a href="${esc(b.url)}" target="_blank" rel="noopener">open game</a></div>`).join("");
}

// Minimal Markdown: headings, bullets, bold, links, [F#]/[T#] citations.
function renderMarkdown(md: string, facts: Map<string, string>): string {
  const inline = (s: string) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\[([FT]\d+)\]/g, (_m, id: string) =>
      `<span class="cite" title="${esc(facts.get(id) ?? "unknown citation")}">${id}</span>`);
  const out: string[] = [];
  let inList = false;
  for (const line of md.split("\n")) {
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
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
    ? ` The live coach for <strong>${esc(shown)}</strong> needs Claude, which runs in the full app.` : "";
  const banner = example
    ? `<p class="verify ok">This is a saved example report for <strong>${esc(c.username ?? "")}</strong>. Live coaching runs locally with Claude Code or with an API key; see the README.${other}</p>`
    : "";
  const v = c.verification;
  const issues = v.unsupported.map(u => `<li>${esc(u.type)} <code>${esc(String(u.claim))}</code></li>`).join("");
  const first = c.first_verification;
  const repairNote = c.repaired
    ? ` The first draft had ${first.unsupported.length + first.bad_citations.length} unsupported claim(s) out of ${first.checked}; the coach was sent the checker's findings and rewrote it.`
    : "";
  const tools = c.tool_calls.length
    ? ` Tools used: ${c.tool_calls.map(t => esc(t.name)).join(", ")}.` : "";
  $("coach").innerHTML = `${banner}<div class="report">${renderMarkdown(c.report, facts)}</div>
    <div class="verify ${v.ok ? "ok" : "bad"}">
      <strong>${v.ok ? "Verified" : "Not fully verified"}:</strong> ${v.checked} numbers, moves and links checked,
      ${v.unsupported.length + v.bad_citations.length} unsupported.${repairNote}${tools}
      ${issues ? `<ul>${issues}</ul>` : ""}${footnote ? `<br><span class="ci">${esc(footnote)}</span>` : ""}</div>`;
}

async function analyze(ev: Event) {
  ev.preventDefault();
  const username = ($("username") as HTMLInputElement).value.trim();
  const time_class = ($("time_class") as HTMLSelectElement).value || null;
  const games = Number(($("games") as HTMLSelectElement).value);
  const btn = $("go") as HTMLButtonElement;
  btn.disabled = true;
  $("coach").innerHTML = "";
  setStatus(`Fetching ${username}'s games and running Stockfish on every move. This takes 15-60 seconds…`);
  try {
    const p: Payload = STATIC?.browser
      ? await analyzeInBrowser({ username, games, timeClass: time_class, depth: BROWSER_DEPTH,
                                 engineUrl: ENGINE_URL, onStatus: m => setStatus(m) })
      : await post<Payload>("/api/analyze", { username, games, time_class });
    if (STATIC?.browser) {
      browserRun = p as Awaited<ReturnType<typeof analyzeInBrowser>>;
      $("keyBox").hidden = false;
      ($("coachBtn") as HTMLButtonElement).textContent = `Write ${p.username}'s coaching report`;
      $("snapshot").innerHTML = `<strong>Analyzed in your browser.</strong> Stockfish (WebAssembly, depth ${BROWSER_DEPTH}) ran on
        your computer over ${p.overall.games} games; nothing was sent to a server except the requests to Chess.com.
        It uses Stockfish's smaller "lite" network, which flags somewhat fewer blunders than the full engine in the
        snapshot, so compare players within one version, not across them.
        For the AI coach, add your own Anthropic API key below.`;
    }
    lastReq = { username, games, time_class };
    renderSummary(p);
    renderForest(p.openings);
    renderEngine(p);
    $("results").hidden = false;
    setStatus("");
  } catch (e) {
    setStatus((e as Error).message, true);
  } finally {
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
    const res = await runCoach({
      client: await makeClient(key), username: run.username, facts: run.facts,
      games: run.gameRows, moves: run.moveRows, engineUrl: ENGINE_URL, onStatus: status, summaries: run.summaries,
    });
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
  try {
    renderCoach(await post<CoachResp>("/api/coach", lastReq));
  } catch (e) {
    $("coach").innerHTML = `<p class="error weak">${esc((e as Error).message)}</p>`;
  } finally {
    btn.disabled = false;
  }
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
  if (STATIC) {
    coachBackend = null;
    ($("coachBtn") as HTMLButtonElement).textContent = "Show the coach's report";
    return;
  }
  try {
    const s = await (await fetch("/api/coach/status")).json() as { backend: string | null; example: boolean };
    coachBackend = s.backend;
    if (s.backend === null) {
      ($("coachBtn") as HTMLButtonElement).textContent = s.example ? "Show an example report" : "Coaching unavailable";
      ($("coachBtn") as HTMLButtonElement).disabled = !s.example;
    }
  } catch { /* leave defaults */ }
}

// Snapshot mode (GitHub Pages): no backend, so the page renders a saved
// analysis and the saved, verified coach report instead of calling the API.
async function initStatic(cfg: StaticConfig) {
  if (!cfg.browser) {
    const form = $("form") as HTMLFormElement;
    for (const el of Array.from(form.elements)) (el as HTMLInputElement).disabled = true;
  }
  try {
    const p = await (await fetch(cfg.analysis)).json() as Payload;
    const qsUser = new URLSearchParams(location.search).get("u");
    ($("username") as HTMLInputElement).value = qsUser || p.username;
    if (p.time_class) ($("time_class") as HTMLSelectElement).value = p.time_class;
    renderSummary(p);
    renderForest(p.openings);
    renderEngine(p);
    $("results").hidden = false;
    const when = p.generated_at ? new Date(p.generated_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
    $("snapshot").innerHTML = `<strong>Snapshot.</strong> This is a saved analysis of <strong>${esc(p.username)}</strong>'s
      last ${p.overall.games} ${esc(p.time_class ?? "")} games${when ? `, run on ${esc(when)}` : ""}. ` + (cfg.browser
      ? `<strong>Enter any Chess.com username above</strong> to analyze it right here: Stockfish runs in your browser, no account or key needed.
         Add your own Anthropic API key for a live AI coaching report.`
      : `The full app analyzes any Chess.com username, but Stockfish and the coach need a server, so it runs locally:
         <a href="${esc(cfg.repo)}" target="_blank" rel="noopener">code and setup on GitHub</a>.`);
    if (qsUser && cfg.browser && qsUser.toLowerCase() !== p.username.toLowerCase()) {
      ($("form") as HTMLFormElement).requestSubmit();
    }
    $("snapshot").hidden = false;
  } catch (e) {
    setStatus(`Couldn't load the snapshot: ${(e as Error).message}`, true);
  }
}

$("form").addEventListener("submit", analyze);
$("coachBtn").addEventListener("click", coach);
initCoach();
if (STATIC) initStatic(STATIC);
const qs = new URLSearchParams(location.search).get("u");
if (qs) { ($("username") as HTMLInputElement).value = qs; }

// Debug hook (only with ?debug=1): lets the real coach tools (DuckDB-WASM, Stockfish)
// be exercised from the console with a scripted client, without an API key.
if (new URLSearchParams(location.search).get("debug") === "1") {
  (window as unknown as Record<string, unknown>).__wf = { runCoach, getRun: () => browserRun, engineUrl: ENGINE_URL, embed };
}
