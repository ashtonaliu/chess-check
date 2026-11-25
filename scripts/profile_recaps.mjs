// Time finished recaps in the real unpacked extension. The site list is deliberately fixed.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = join(root, "web");
const [output, selected = "all", repeats = "3"] = process.argv.slice(2);
assert.ok(output && ["all", "chesscom", "lichess"].includes(selected) && Number.isInteger(+repeats) && +repeats >= 3,
  "Usage: node scripts/profile_recaps.mjs OUTPUT.json [all|chesscom|lichess] [REPEATS >= 3]");
const binary = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const headless = process.env.PROFILE_HEADLESS === "1";
const chromeVersion = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const sites = {
  chesscom: { host: "www.chess.com", route: "/game/live/", ids: ["187138001290", "184641222268"], storage: "accounts" },
  lichess: { host: "lichess.org", route: "/game/", ids: ["BYvvanic", "oiuCrb3L", "jXSW5txW"], storage: "accounts:lichess" },
};
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const callbacks = await Promise.all(["callback_187138001290.json", "callback_promo_capture.json"]
  .map(file => readJson(join(web, "test/fixtures", file))));
for (const [i, { game }] of callbacks.entries()) {
  assert.ok(game.isFinished && String(game.id) === sites.chesscom.ids[i]);
}
sites.chesscom.user = callbacks[0].game.pgnHeaders.White;
const parity = await readJson(join(web, "test/fixtures/lichess_parity.json"));
sites.lichess.user = parity.exports.BYvvanic.players.white.user.id;

const work = await mkdtemp(join(tmpdir(), "chess-check-recaps-"));
const extension = join(work, "extension");
function command(file, args, options = {}) {
  return execFileSync(file, args, { cwd: root, ...options });
}

async function buildExtension() {
  for (const name of ["manifest.json", "offscreen.html", "icons"]) {
    await cp(join(root, "extension", name), join(extension, name), { recursive: true });
  }
  const engine = join(extension, "engine");
  command("bash", [join(root, "scripts/build_engine_wasm.sh"), engine], { stdio: "inherit" });
  const config = { absWorkingDir: web, bundle: true, minify: true, target: "es2022", define: { __CC_PROFILE__: "true" } };
  await build({ ...config, entryPoints: ["src/extension/offscreen.ts", "src/extension/background.ts"], format: "esm",
    splitting: true, outdir: join(extension, "dist") });
  await build({ ...config, entryPoints: ["src/extension/content.ts"], format: "iife", loader: { ".css": "text" },
    outfile: join(extension, "dist/content.js") });
  await build({ ...config, entryPoints: ["src/browser/tacticsWorker.ts"], format: "esm", outfile: join(engine, "tacticsWorker.js") });
  await stop();
  command(process.execPath, [join(web, "scripts/patchStockfish.mjs"), engine]);
  await writeFile(join(extension, "dist/build.json"), JSON.stringify({ built: new Date().toISOString() }));
  await writeFile(join(extension, "benchmark-bootstrap.html"), "<!doctype html><title>Recap timing setup</title>");
}

class Chrome {
  next = 0;
  buffered = "";
  pending = new Map();
  constructor(process) {
    this.process = process;
    this.closed = once(process, "exit");
    process.stdio[4].setEncoding("utf8").on("data", chunk => {
      const messages = (this.buffered + chunk).split("\0");
      this.buffered = messages.pop();
      for (const text of messages) {
        const message = JSON.parse(text);
        this.pending.get(message.id)?.(message);
        if (message.method === "Fetch.requestPaused") this.onNavigation?.(message.params, message.sessionId);
      }
    });
    process.stdio[3].on("error", () => {});
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome timed out on ${method}`)); }, 10_000);
      this.pending.set(id, message => {
        this.pending.delete(id);
        clearTimeout(timeout);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.process.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }
  async attach(match) {
    const { targetInfos } = await this.send("Target.getTargets");
    const target = targetInfos.find(match);
    if (target) return (await this.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  }
  async evaluate(sessionId, expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function waitFor(label, read, timeout = 180_000) {
  const until = performance.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(150);
  } while (performance.now() < until);
  throw new Error(`Timed out waiting for ${label}`);
}

const engineRuns = `(() => {
  const searches = performance.getEntriesByName("cc:uci search");
  return performance.getEntriesByName("cc:engine timing complete").map(({ duration, detail }) => {
    let sentMs = 0, stockfishMs = 0, timed = 0, missing = 0;
    for (const search of searches) if (search.detail.run === detail.id) {
      if (search.detail.stockfishMs === null) missing++;
      else { sentMs += search.duration; stockfishMs += search.detail.stockfishMs; timed++; }
    }
    return { ...detail, duration, sentMs, stockfishMs, timed, missing };
  });
})()`;

async function sample(name, site, index) {
  const profile = await mkdtemp(join(work, "chrome-"));
  const chrome = new Chrome(spawn(binary, [
    ...(headless ? ["--headless=new"] : []), "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync",
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }));
  const out = {};
  try {
    const { id } = await chrome.send("Extensions.loadUnpacked", { path: extension });
    const tab = await chrome.attach(t => t.type === "page");
    await chrome.send("Page.navigate", { url: `chrome-extension://${id}/benchmark-bootstrap.html` }, tab);
    await waitFor("the extension setup page", () => chrome.evaluate(tab,
      `globalThis.chrome?.runtime?.id === ${JSON.stringify(id)}`).catch(() => false), 10_000);
    await chrome.evaluate(tab, `chrome.storage.local.set(${JSON.stringify({ [site.storage]: [site.user] })})`);
    const { frameTree } = await chrome.send("Page.getFrameTree", {}, tab);
    let navigationError;
    chrome.onNavigation = ({ requestId, request, frameId }, session) => {
      const url = new URL(request.url);
      const safe = frameId !== frameTree.frame.id || (url.protocol === "https:" && url.hostname === site.host &&
        site.ids.some(id => [site.route + id, `/game/${id}`, `/live/game/${id}`].includes(url.pathname)));
      if (!safe) navigationError = new Error("The site redirected away from the allowed finished games");
      void chrome.send(safe ? "Fetch.continueRequest" : "Fetch.failRequest",
        safe ? { requestId } : { requestId, errorReason: "BlockedByClient" }, session).catch(() => {});
    };
    await chrome.send("Fetch.enable", { patterns: [{ resourceType: "Document" }] }, tab);
    const open = async (id, reload = false) => {
      navigationError = undefined;
      const previous = await chrome.evaluate(tab, "performance.timeOrigin");
      const { errorText } = reload ? await chrome.send("Page.reload", {}, tab)
        : await chrome.send("Page.navigate", { url: `https://${site.host}${site.route}${id}` }, tab);
      if (errorText) throw navigationError ?? new Error(errorText);
      let blockedSince;
      return waitFor("the full recap", async () => {
        if (navigationError) throw navigationError;
        const value = await chrome.evaluate(tab, `({
          timeOrigin: performance.timeOrigin,
          blocked: /just a moment|attention required|access denied|403 forbidden/i.test(document.title)
            || !!document.querySelector("#challenge-running"),
          report: document.querySelector("[data-chess-check-recap-timing]")?.dataset.chessCheckRecapTiming
        })`).catch(() => null);
        if (!value || value.timeOrigin === previous) return false;
        if (value.blocked) blockedSince ??= performance.now();
        else blockedSince = undefined;
        if (blockedSince !== undefined && performance.now() - blockedSince >= 25_000) {
          const error = new Error("A browser access challenge blocked the finished game");
          error.blocked = true;
          throw error;
        }
        const report = value?.report && JSON.parse(value.report);
        return report?.stages.complete !== undefined && report;
      });
    };
    const a = site.ids[index % site.ids.length], b = site.ids[(index + 1) % site.ids.length];
    out.cold = { game: a, ...await open(a) };
    assert.ok(!out.cold.cached);
    const offscreen = await chrome.attach(t => t.url === `chrome-extension://${id}/offscreen.html`);
    assert.ok(offscreen, "The recap needs an offscreen page");
    const profileRun = await waitFor("a saved 150-game profile", () => chrome.evaluate(offscreen,
      `performance.getEntriesByName("cc:engine timing complete")
        .find(({ detail }) => detail.requested === 150 && detail.games === 150)?.detail.id`));
    out.profile = (await chrome.evaluate(offscreen, engineRuns)).find(run => run.id === profileRun);
    // The finished fixture may already be in the user's history. Keep its profile, but give
    // this one game the empty engine cache it would have had when first played.
    const cacheId = name === "lichess" ? `lichess:${b}` : b;
    await chrome.evaluate(offscreen, `new Promise((resolve, reject) => {
      const open = indexedDB.open("chess-check-engine-cache", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("games", "readwrite");
        const store = tx.objectStore("games");
        for (const key of ${JSON.stringify([`v1_${cacheId}_d8`, `deep_v1_${cacheId}_d14`])}) store.delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    })`);
    out.warm = { game: b, ...await open(b) };
    assert.ok(out.warm.games === 150 && !out.warm.cached, "The new game must use the saved profile");
    out.reopen = { game: b, ...await open(b, true) };
    assert.ok(out.reopen.cached, "Reopening must reuse the existing recap");
    out.engines = (await chrome.evaluate(offscreen, engineRuns)).filter(run => run.kind === "recap");
    for (const id of [a, b]) assert.ok(out.engines.some(run => run.gameId === id && run.timed + run.missing > 0),
      "Expected the game to run fresh searches");
  } catch (e) {
    out.error = e.message;
    out.blocked = !!e.blocked;
  } finally {
    chrome.process.kill("SIGTERM");
    await chrome.closed.catch(() => {});
  }
  return out;
}

function describe(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n ? { n, median: (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2, min: sorted[0], max: sorted[n - 1] } : null;
}
function share(runs) {
  const total = key => runs.reduce((sum, run) => sum + run[key], 0);
  const sentMs = total("sentMs"), stockfishMs = total("stockfishMs"), overheadMs = sentMs - stockfishMs;
  const timed = total("timed");
  // Stockfish subtracts two integer millisecond timestamps and reports at least 1 ms.
  const clockAllowanceMs = Math.min(sentMs, Math.max(0, overheadMs + timed));
  return { sentMs, stockfishMs, overheadMs, percent: sentMs ? 100 * overheadMs / sentMs : null,
    clockAllowancePercent: sentMs ? 100 * clockAllowanceMs / sentMs : null, timed, missing: total("missing") };
}

const report = { chromeVersion, mode: headless ? "headless" : "headed", method: "live", sites: {} };
try {
  await buildExtension();
  for (const [name, site] of Object.entries(sites)) {
    if (selected !== "all" && selected !== name) continue;
    const samples = [];
    for (let i = 0; i < +repeats; i++) {
      const run = await sample(name, site, i);
      samples.push(run);
      console.log(name, i + 1, JSON.stringify(run));
      if (run.blocked) break;
    }
    const stages = Object.fromEntries(["cold", "warm", "reopen"].map(kind =>
      [kind, Object.fromEntries(["confirmed", "result", "turning", "opponent", "complete"].map(stage =>
        [stage, describe(samples.map(s => s[kind]?.stages[stage]))]))]));
    report.sites[name] = { samples, stages, engine: { recap: share(samples.flatMap(s => s.engines ?? [])),
      profile150: share(samples.flatMap(s => s.profile ? [s.profile] : [])) } };
    if (samples.length < +repeats || samples.some(s => s.error)) process.exitCode = 1;
  }
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n");
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 5 });
}
