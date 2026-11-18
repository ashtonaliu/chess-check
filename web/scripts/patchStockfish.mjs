// Copy Stockfish.js into a build, with one change to how it pauses.
//
// The single-threaded WebAssembly build pauses during a search (Emscripten's emscripten_sleep, via
// Asyncify) so the worker can read messages such as "stop". It pauses with setTimeout, and browsers
// make a nested setTimeout wait at least 4 ms, so once a search has run for a moment it spends most
// of its time waiting: in Chrome a depth-14 search that took 36.5 s searched the same 941,448 nodes
// in 1.8 s with this change. A sleep of 0 ms now yields through a MessageChannel, which has no such
// minimum; longer sleeps still use setTimeout. The search itself is untouched (same nodes, scores
// and moves). Stockfish.js is GPL-3.0; this file and the copied engine keep that license.
//
//   node scripts/patchStockfish.mjs <output directory>...
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE = "stockfish-19-lite-single";
export const SLEEP = "()=>new Promise(t=>setTimeout(t,e))";
export const YIELD = "()=>new Promise(t=>{if(e>0)setTimeout(t,e);else{var c=new MessageChannel;" +
  "c.port1.onmessage=function(){c.port1.close(),t()},c.port2.postMessage(0)}})";

/** The patched engine source; throws if the sleep is not there exactly once (a different version). */
export function patch(source) {
  const n = source.split(SLEEP).length - 1;
  if (n !== 1) throw new Error(`expected the engine's sleep once, found it ${n} times: check the Stockfish version`);
  return source.replace(SLEEP, YIELD);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "stockfish", "bin");
  const js = patch(readFileSync(join(bin, `${ENGINE}.js`), "utf8"));
  for (const out of process.argv.slice(2)) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${ENGINE}.js`), js);
    copyFileSync(join(bin, `${ENGINE}.wasm`), join(out, `${ENGINE}.wasm`));
  }
}
