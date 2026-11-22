// Attribute the CPU samples in a Chrome Performance trace to their outer chess.js caller.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { SourceMap } from "node:module";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";

const [dir] = process.argv.slice(2);
if (!dir) throw new Error("Usage: node scripts/summarize_offscreen_profile.mjs OUTPUT_DIR");
const read = path => JSON.parse(readFileSync(path, "utf8"));
const chessSource = readFileSync(new URL("../web/node_modules/chess.js/src/chess.ts", import.meta.url), "utf8").split("\n");
const maps = new Map(["dist/offscreen.js", "engine/tacticsWorker.js", "dist/content.js"].map(name => {
  const payload = read(join(dir, "site", name + ".map"));
  const lines = new Map(payload.sources.map((source, i) => [source, payload.sourcesContent[i]?.split("\n")]));
  return ["/" + name, { map: new SourceMap(payload), lines }];
}));
const ms = usec => usec / 1000;

function frameInfo(frame) {
  const name = frame.functionName || "(anonymous)";
  if (!frame.url || frame.lineNumber === undefined) return { source: "", name };
  const script = maps.get(new URL(frame.url).pathname);
  const entry = script?.map.findEntry(frame.lineNumber, Math.max(0, (frame.columnNumber ?? 1) - 1));
  if (!entry?.originalSource) return { source: "", name };
  const { originalSource: source, originalLine } = entry;
  const lines = script.lines.get(source) ?? (source.endsWith("/node_modules/src/chess.ts") ? chessSource : undefined);
  const line = lines?.[originalLine];
  const declaration = line?.match(/^\s*(?:export )?(?:async )?(?:const|function|class) (\w+)/)?.[1];
  const resolved = line?.trimStart().startsWith("constructor(") ? "constructor" : declaration;
  return { source, line, name: resolved ?? (entry.name && entry.name !== "__name" ? entry.name : name) };
}

function stackGroup(stack) {
  const frames = stack.map(frameInfo);
  // esbuild follows chess.js's own map, which locates its main module at node_modules/src/chess.ts.
  const isChess = source => source.includes("/node_modules/chess.js/") || source.endsWith("/node_modules/src/chess.ts");
  const outer = frames.findLastIndex(frame => isChess(frame.source));
  if (outer < 0) return null;
  const caller = frames.findIndex(({ source }, i) => i > outer && source && !isChess(source));
  if (caller < 0) return "unknown caller";
  const { source, name, line } = frames[caller];
  const file = basename(source, ".ts");
  if (file === "engine" && line?.includes("runPool(tasks.length")) return "engine.recheckBlunders";
  if (file === "engine" && (name === "analyseOne" || name === "evalWhite")) {
    return `engine.${name} → ${frames[outer].name}`;
  }
  return `${file}.${name}`;
}

function cpuSamples(events, windowStart, windowEnd, busy) {
  const header = events.find(e => e.name === "Profile");
  const nodes = new Map(), owners = new Map();
  const samples = [];
  const groups = new Map();
  let stamp = header.args.data.startTime;
  for (const { args } of events.filter(event => event.name === "ProfileChunk")) {
    const data = args.data;
    for (const node of data.cpuProfile?.nodes ?? []) nodes.set(node.id, node);
    for (const [i, nodeId] of (data.cpuProfile?.samples ?? []).entries()) {
      stamp += data.timeDeltas[i];
      samples.push({ stamp, nodeId });
    }
  }
  // V8 can flush samples out of order. Rebuild the timestamps, then sort like DevTools.
  samples.sort((a, b) => a.stamp - b.stamp);
  let sampled = 0, task = 0;
  for (let i = 0; i + 1 < samples.length; i++) {
    const { stamp, nodeId } = samples[i];
    const start = Math.max(stamp, windowStart), end = Math.min(samples[i + 1].stamp, windowEnd);
    if (end <= start) continue;
    sampled += end - start;
    if (!owners.has(nodeId)) {
      const stack = [];
      for (let n = nodes.get(nodeId); n; n = nodes.get(n.parent)) stack.push(n.callFrame);
      owners.set(nodeId, stackGroup(stack));
    }
    const group = owners.get(nodeId);
    if (!group) continue;
    while (task < busy.length && busy[task][1] <= start) task++;
    for (let j = task; j < busy.length && busy[j][0] < end; j++) {
      const [from, to] = busy[j];
      const duration = Math.min(to, end) - Math.max(from, start);
      groups.set(group, (groups.get(group) ?? 0) + duration);
    }
  }
  assert.ok(sampled > 0, "Expected V8 CPU samples in the build interval");
  return { groups, sampled };
}

function busyIntervals(events, start, end) {
  // Trace task intervals can nest. Take their union inside the selected range.
  const tasks = events.filter(e => e.name === "RunTask" && e.ph === "X" && e.ts < end && e.ts + e.dur > start)
    .sort((a, b) => a.ts - b.ts);
  const busy = [];
  for (const { ts, dur } of tasks) {
    const begin = Math.max(ts, start), finish = Math.min(ts + dur, end);
    const last = busy.at(-1);
    if (last && last[1] >= begin) last[1] = Math.max(last[1], finish);
    else busy.push([begin, finish]);
  }
  assert.ok(busy.length > 0, "Expected busy main-thread intervals");
  return busy;
}

function workerMeasure(events, name, start, end) {
  const begin = events.find(e => e.name === name && e.ph === "b" && e.ts >= start && e.ts < end);
  assert.ok(begin, `Missing ${name} inside the build`);
  const finish = events.find(e => e.name === name && e.ph === "e" && e.pid === begin.pid &&
    e.tid === begin.tid && e.id2.local === begin.id2.local && e.ts >= begin.ts);
  assert.ok(finish, `Missing end of ${name}`);
  return { thread: begin.tid, start: begin.ts, end: finish.ts, duration: ms(finish.ts - begin.ts) };
}

function readRun(file) {
  const label = file.split(".")[0];
  const run = read(join(dir, label + ".json"));
  const raw = readFileSync(join(dir, file));
  const trace = JSON.parse(file.endsWith(".gz") ? gunzipSync(raw) : raw).traceEvents;
  const begin = trace.find(e => e.name === "cc:build start"), finish = trace.find(e => e.name === "cc:build end");
  assert.ok(begin && finish && begin.tid === finish.tid);
  const start = begin.ts, end = finish.ts;
  const main = trace.filter(e => e.pid === begin.pid && e.tid === begin.tid);
  const profiles = main.filter(e => e.name === "Profile");
  assert.equal(profiles.length, 1, "Expected one main-thread CPU profile");
  const mainProfile = trace.filter(e => e.pid === begin.pid && e.id === profiles[0].id &&
    (e.name === "Profile" || e.name === "ProfileChunk"));
  const wall = ms(end - start);
  const intervals = busyIntervals(main, start, end);
  const busy = ms(intervals.reduce((sum, [from, to]) => sum + to - from, 0));
  const { groups, sampled } = cpuSamples(mainProfile, start, end, intervals);
  const chess = ms([...groups.values()].reduce((a, b) => a + b, 0));
  assert.ok(chess <= busy * 1.05 && Math.abs(wall - ms(sampled)) < wall * 0.1,
    `Invalid trace durations for ${label}: wall=${wall}, busy=${busy}, sampled=${ms(sampled)}, chess=${chess}`);
  const tactics = workerMeasure(trace, "cc:tactics summarize", start, end);
  assert.notEqual(tactics.thread, begin.tid, "Expected tactics on a dedicated worker");
  const worker = workerMeasure(trace, "cc:tactics worker", start, end);
  assert.equal(tactics.thread, worker.thread);
  const sum = name => run.measures.filter(e => e.name === `cc:${name}`).reduce((a, e) => a + e.duration, 0);
  const buildEnd = run.measures.find(e => e.name === "cc:build").startTime + sum("build");
  const features = run.measures.filter(e => e.name === "cc:engine move features" && e.startTime < buildEnd);
  assert.equal(features.length, run.games, "Expected cold Stockfish analyses");
  assert.equal(run.measures.filter(e => e.name === "cc:game parsing").length, run.games + 1);
  assert.equal(run.measures.filter(e => e.name === "cc:find-rate features" && e.startTime < buildEnd).length, 0);
  assert.equal(run.measures.filter(e => e.name === "cc:find-rate features").length, 1);
  return {
    games: run.games, plies: run.plies, cpus: run.cpus, wall, busy, chess,
    chessWall: 100 * chess / wall, chessBusy: 100 * chess / busy,
    parsing: sum("game parsing"), engine: sum("engine pass"), recheck: sum("engine recheck"),
    engineFeatures: features.reduce((a, e) => a + e.detail, 0),
    tacticsRequest: sum("tactics request"), tacticsWorker: worker.duration, summarize: tactics.duration,
    recap: sum("recap"), findRate: sum("find-rate features"),
    callers: Object.fromEntries([...groups].map(([key, usec]) => [key, ms(usec)])),
    label,
  };
}

const runs = readdirSync(dir).filter(name => /^(50|150)-\d+\.trace\.json(?:\.gz)?$/.test(name)).map(readRun);
assert.ok(runs.length > 0, "No profile recordings found");
function stats(values) {
  const xs = values.slice().sort((a, b) => a - b);
  const median = (xs[Math.floor((xs.length - 1) / 2)] + xs[Math.floor(xs.length / 2)]) / 2;
  return [median, xs[0], xs.at(-1)];
}
const results = [];
for (const count of [50, 150]) {
  const group = runs.filter(run => run.games === count);
  if (!group.length) continue;
  const names = Object.keys(group[0]).filter(key => typeof group[0][key] === "number");
  const callers = [...new Set(group.flatMap(run => Object.keys(run.callers)))];
  results.push({
    games: count, runs: group.map(({ label, wall, chessBusy, chessWall }) => ({ label, wall, chessBusy, chessWall })),
    stats: Object.fromEntries(names.map(key => [key, stats(group.map(run => run[key]))])),
    callers: Object.fromEntries(callers.map(key => [key, stats(group.map(run => run.callers[key] ?? 0))])
      .sort((a, b) => b[1][0] - a[1][0])),
  });
}
console.log(JSON.stringify(results, null, 2));
