// Record Chrome Performance traces of cold profile builds on archived, finished games.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [archiveFile, outputDir, repeats = "3", only] = process.argv.slice(2);
if (!archiveFile || !outputDir || !Number.isInteger(+repeats) || +repeats < 1 || (only && !["50", "150"].includes(only))) {
  throw new Error("Usage: node scripts/profile_offscreen.mjs ARCHIVE_JSON OUTPUT_DIR [REPEATS [50|150]]");
}
const out = resolve(outputDir);
const site = join(out, "site");
const fixture = name => join(root, "web/test/fixtures", name);
const callback = JSON.parse(await readFile(fixture("callback_187138001290.json")));
const reference = JSON.parse(await readFile(fixture("archive_187138001290.json")));
assert.ok(callback.game.isFinished && String(callback.game.id) === reference.url.split("/").at(-1));
const username = callback.game.pgnHeaders.White.toLowerCase();
const archive = JSON.parse(await readFile(archiveFile)).games
  .filter(game => game.end_time < reference.end_time && game.rules === "chess" &&
    game.time_class === reference.time_class && game.pgn && game.white.result && game.black.result &&
    /\[Result "(?:1-0|0-1|1\/2-1\/2)"\]/.test(game.pgn) &&
    [game.white.username, game.black.username].some(name => name.toLowerCase() === username))
  .sort((a, b) => b.end_time - a.end_time).slice(0, 151);
assert.equal(archive.length, 151, "Need 150 finished games plus one for the oldest pregame rating");
assert.equal(new Set(archive.map(game => game.url)).size, archive.length);
const archiveJson = JSON.stringify({ games: archive });
const selection = {
  username, timeClass: reference.time_class, cutoff: reference.end_time,
  games: archive.length, sha256: createHash("sha256").update(archiveJson).digest("hex"),
};
const chromeVersion = execFileSync(chromePath, ["--version"], { encoding: "utf8" }).trim();

await mkdir(join(site, "engine"), { recursive: true });
await cp(join(root, "extension/dev.html"), join(site, "dev.html"));
const bundle = { absWorkingDir: join(root, "web"), bundle: true, minify: true, keepNames: true,
  format: "esm", target: "es2022", sourcemap: "linked", define: { __CC_PROFILE__: "true" } };
await build({ ...bundle, entryPoints: ["src/extension/offscreen.ts"], outfile: join(site, "dist/offscreen.js") });
await build({ ...bundle, format: "iife", loader: { ".css": "text" },
  entryPoints: ["src/extension/content.ts"], outfile: join(site, "dist/content.js") });
await build({ ...bundle, target: "es2020", entryPoints: ["src/browser/tacticsWorker.ts"],
  outfile: join(site, "engine/tacticsWorker.js") });
await stop();
execFileSync(process.execPath, [join(root, "web/scripts/patchStockfish.mjs"), join(site, "engine")]);
await writeFile(join(out, "setup.json"), JSON.stringify({ chromeVersion, ...selection }, null, 2) + "\n");

const mime = { ".js": "text/javascript", ".wasm": "application/wasm", ".map": "application/json", ".html": "text/html" };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname.startsWith("/archive/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(url.pathname === "/archive/list" ? JSON.stringify({ archives: ["/archive/month"] }) : archiveJson);
      return;
    }
    const file = resolve(site, "." + url.pathname);
    if (!file.startsWith(site + sep)) throw new Error("Outside the profiling site");
    res.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

class CDP {
  next = 0;
  pending = new Map();
  events = new Map();

  static async connect(url) {
    const ws = new WebSocket(url);
    await once(ws, "open");
    return new CDP(ws);
  }
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", event => {
      const { id, error, result, method, params } = JSON.parse(event.data);
      if (id) {
        const { method: request, resolve, reject } = this.pending.get(id);
        this.pending.delete(id);
        if (error) reject(new Error(`${request}: ${error.message}`));
        else resolve(result);
      } else if (this.events.has(method)) {
        this.events.get(method)(params);
        this.events.delete(method);
      }
    });
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("Chrome disconnected"));
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  wait(method) { return new Promise(resolve => this.events.set(method, resolve)); }
}

function interferingProcesses() {
  const target = /(?:\b(?:pytest|cargo-(?:build|test|clippy)|rustc|rustup|esbuild|tsc|vitest|jest|ninja|cmake|xcodebuild|clang)\b|cargo (?:build|test|clippy|check)|npm (?:test|ci|run build)|node .*--test\b|train_neural_find_rate\.py|stockfish_lichess\.py|check_engine_core\.sh|build_extension\.sh|benchmark_neural_find_rate\.py)/;
  return execFileSync("ps", ["-axo", "pid=,stat=,command="], { encoding: "utf8" }).trim().split("\n")
    .map(line => line.trim()).filter(line => {
      const [pid, stat, ...command] = line.split(/\s+/);
      const args = command.join(" ");
      return Number(pid) !== process.pid && !/^[ZT]/.test(stat) && !/esbuild --service=/.test(args) && target.test(args);
    });
}

async function inspectArchiveInPage(cdp, session, games) {
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const deadline = performance.now() + 10000;
      while (!window.__ccProfile) {
        if (performance.now() > deadline) throw new Error("Development harness did not start");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const result = await window.__ccProfile(${JSON.stringify(username)}, ${games}, ${JSON.stringify(callback)});
      return { ...result, cpus: navigator.hardwareConcurrency,
        measures: performance.getEntriesByType("measure").filter(e => e.name.startsWith("cc:"))
          .map(({name, startTime, duration, detail}) => ({name, startTime, duration, detail})) };
    })()`,
  }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function run(games, label) {
  const path = await mkdtemp(join(out, "chrome-"));
  const chrome = spawn(chromePath, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${path}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-sync", "--disable-extensions", "--disable-component-update", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const closed = once(chrome, "exit");
  let cdp, monitor;
  try {
    let active;
    for (let i = 0; i < 100 && !active; i++) {
      active = await readFile(join(path, "DevToolsActivePort"), "utf8").catch(() => null);
      if (!active) await delay(100);
    }
    assert.ok(active, "Chrome did not open its debugging port");
    const [port, endpoint] = active.trim().split("\n");
    cdp = await CDP.connect(`ws://127.0.0.1:${port}${endpoint}`);
    const { targetInfos } = await cdp.send("Target.getTargets");
    const { targetId } = targetInfos.find(info => info.type === "page");
    const { sessionId: session } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, session);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `{
        const fetchLocal = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input, location.href);
          const base = "/pub/player/" + ${JSON.stringify(username)} + "/games/";
          if (url.origin === "https://api.chess.com" && url.pathname === base + "archives") return fetchLocal("/archive/list", init);
          if (url.origin !== location.origin) throw new Error("Only archived games from localhost are allowed");
          return fetchLocal(input, init);
        };
      }`,
    }, session);
    await cdp.send("Page.navigate", { url: origin + "/dev.html" }, session);
    const categories = ["toplevel", "devtools.timeline", "blink.user_timing",
      "disabled-by-default-devtools.timeline", "disabled-by-default-v8.cpu_profiler"];
    await cdp.send("Tracing.start", { traceConfig: { includedCategories: categories, excludedCategories: ["*"],
      recordMode: "recordAsMuchAsPossible" }, transferMode: "ReturnAsStream", streamCompression: "gzip" }, session);
    const overlap = new Set(interferingProcesses());
    if (overlap.size) return { overlap };
    monitor = setInterval(() => interferingProcesses().forEach(line => overlap.add(line)), 500);
    const result = await inspectArchiveInPage(cdp, session, games);
    interferingProcesses().forEach(line => overlap.add(line));
    clearInterval(monitor);
    const complete = cdp.wait("Tracing.tracingComplete");
    await cdp.send("Tracing.end", {}, session);
    const { stream, dataLossOccurred } = await complete;
    assert.ok(!dataLossOccurred, "Chrome dropped Performance trace events");
    if (overlap.size) return { overlap };
    const chunks = [];
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle: stream }, session);
      chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
      if (chunk.eof) break;
    }
    await cdp.send("IO.close", { handle: stream }, session);
    await writeFile(join(out, label + ".trace.json.gz"), Buffer.concat(chunks));
    await writeFile(join(out, label + ".json"), JSON.stringify(result) + "\n");
    const ms = result.measures.find(e => e.name === "cc:build").duration;
    console.log(`${label}: ${(ms / 1000).toFixed(3)} s, ${result.plies} plies`);
    return { overlap };
  } finally {
    clearInterval(monitor);
    cdp?.ws.close();
    chrome.kill("SIGTERM");
    await closed;
    await rm(path, { recursive: true, force: true, maxRetries: 5 });
  }
}

try {
  const counts = only ? [+only] : [50, 150];
  for (let i = 1; i <= +repeats; i++) {
    for (const games of counts) {
      const label = `${games}-${i}`;
      for (;;) {
        const blockers = interferingProcesses();
        if (blockers.length) {
          console.log(`Waiting before ${label}: ${blockers.length} training, test or build processes`);
          await delay(5000);
          continue;
        }
        console.log(`Recording ${label} in a fresh Chrome profile`);
        const { overlap } = await run(games, label);
        if (!overlap.size) break;
        console.log(`Discarding ${label} after detecting ${overlap.size} overlapping processes`);
      }
    }
  }
} finally {
  server.close();
}
