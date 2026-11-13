// Side panel of the Weakness Finder Chrome extension. It shows the recap of the
// Chess.com game in the active tab, and only once that game is finished: see
// guard.ts. It never reads or changes Chess.com's page, only the tab's address.
import { recapGame, type Profile } from "../browser/follow";
import { fetchGames } from "../browser/games";
import { analyzeInBrowser } from "../browser/pipeline";
import type { Recap } from "../browser/recap";
import { esc, notificationText, recapCard } from "../ui/recapCard";
import { canShowRecap, gameUrlFromPage } from "./guard";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const IN_EXTENSION = typeof chrome !== "undefined" && !!chrome.runtime?.getURL;
const ENGINE_URL = IN_EXTENSION ? chrome.runtime.getURL("engine/stockfish-19-lite-single.js")
  : new URL("../engine/stockfish-19-lite-single.js", import.meta.url).href;
const RECHECK_MS = 20_000;

// ---------- storage (chrome.storage in the extension, localStorage in the dev harness) ----------

async function load(key: string): Promise<string | null> {
  try {
    if (IN_EXTENSION) return ((await chrome.storage.local.get([key]))[key] as string) ?? null;
    return localStorage.getItem(`wf:${key}`);
  } catch { return null; }
}
async function save(key: string, value: string) {
  try {
    if (IN_EXTENSION) await chrome.storage.local.set({ [key]: value });
    else localStorage.setItem(`wf:${key}`, value);
  } catch { /* storage unavailable: the setting just isn't remembered */ }
}

// ---------- state ----------

let profile: Profile | null = null;
let currentGame: string | null = null;
let recheck: ReturnType<typeof setTimeout> | null = null;
const recaps = new Map<string, Recap>();

function status(msg: string, error = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = "note" + (error ? " weak" : "");
}

function show(section: "setup" | "main") {
  $("setup").hidden = section !== "setup";
  $("main").hidden = section !== "main";
}

// ---------- profile ----------

async function buildProfile(username: string, timeClass: string) {
  show("main");
  $("who").textContent = username;
  status(`Analyzing ${username}'s recent ${timeClass} games (this happens once; later it is quick)…`);
  const run = await analyzeInBrowser({ username, games: 150, timeClass, depth: 8, engineUrl: ENGINE_URL,
    onProgress: (_stage, _frac, text) => status(text) });
  profile = { username: run.username, timeClass, rows: run.gameRows, openings: run.openings, tactics: run.tactics };
  status(`Ready. Profile: ${run.overall.games} ${timeClass} games.`);
  await onTab(await activeTabUrl());
}

// ---------- active tab ----------

async function activeTabUrl(): Promise<string | null> {
  if (!IN_EXTENSION) return new URLSearchParams(location.search).get("tab");
  try { return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url ?? null; }
  catch { return null; }
}

async function onTab(pageUrl: string | null) {
  const game = gameUrlFromPage(pageUrl);
  if (recheck) { clearTimeout(recheck); recheck = null; }
  currentGame = game;
  if (!profile) return;
  const box = $("current");
  if (!game) {
    box.innerHTML = `<p class="note">Open one of your finished games on Chess.com to see its recap here.</p>`;
    return;
  }
  if (recaps.has(game)) { box.replaceChildren(recapCard(recaps.get(game)!, false)); return; }
  // Fair-play guard: only games the public API lists as finished.
  const finished = await fetchGames(profile.username, 30, null).catch(() => []);
  if (currentGame !== game) return;   // the user moved on while we were fetching
  const found = finished.find(g => g.url === game);
  if (!canShowRecap(game, new Set(finished.map(g => g.url))) || !found) {
    box.innerHTML = `<p class="note"><strong>Your recap will appear when this game ends.</strong> Nothing is shown during a game.
      If this is not one of your games, open one of yours.</p>`;
    recheck = setTimeout(() => { void onTab(pageUrl); }, RECHECK_MS);
    return;
  }
  box.innerHTML = `<p class="note">Analyzing this game…</p>`;
  const r = await recapGame(found, profile, ENGINE_URL);
  recaps.set(game, r);
  if (currentGame === game) box.replaceChildren(recapCard(r, true));
  addRecent(r);
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    const n = notificationText(r);
    new Notification(n.title, { body: n.body });
  }
}

function addRecent(r: Recap) {
  const list = $("recent");
  const item = document.createElement("li");
  item.innerHTML = `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.verdict)} vs ${esc(r.opponent)}</a>`;
  list.prepend(item);
  $("recentBox").hidden = false;
}

// ---------- setup ----------

async function init() {
  const user = await load("username"), tc = (await load("timeClass")) ?? "blitz";
  ($("timeClass") as HTMLSelectElement).value = tc;
  if (user) {
    ($("username") as HTMLInputElement).value = user;
    try { await buildProfile(user, tc); } catch (e) { show("setup"); status((e as Error).message, true); }
  } else {
    show("setup");
  }
}

$("setupForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const user = ($("username") as HTMLInputElement).value.trim(), tc = ($("timeClass") as HTMLSelectElement).value;
  if (!user) return;
  await save("username", user);
  await save("timeClass", tc);
  try { await buildProfile(user, tc); } catch (e) { show("setup"); status((e as Error).message, true); }
});
$("change").addEventListener("click", () => { profile = null; show("setup"); status(""); });

if (IN_EXTENSION) {
  chrome.tabs.onActivated.addListener(async ({ tabId }) => { try { void onTab((await chrome.tabs.get(tabId)).url ?? null); } catch { /* tab gone */ } });
  chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (tab.active && (change.url || change.status === "complete")) void onTab(tab.url ?? null); });
}
void init();
