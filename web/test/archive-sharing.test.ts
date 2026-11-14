import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGames } from "../src/browser/games";

test("archive readers share pending work and can cancel independently", async t => {
  let finish!: (response: Response) => void;
  const fetch = t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const cancelled = fetchGames("example", 5, "blitz", controller.signal);
  const active = fetchGames("example", 5, "rapid");
  assert.equal(fetch.mock.callCount(), 1);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  finish(Response.json({ archives: [] }));
  assert.deepEqual(await active, []);
  const next = fetchGames("example", 5, null);
  assert.equal(fetch.mock.callCount(), 2);
  finish(Response.json({ archives: [] }));
  assert.deepEqual(await next, []);
});

test("the last cancellation aborts the shared fetch", async t => {
  let sharedSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", (_url: string, options: RequestInit) => {
    sharedSignal = options.signal!;
    return new Promise<Response>((_, reject) => {
      sharedSignal!.addEventListener("abort", () => reject(sharedSignal!.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = fetchGames("example", 5, null, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(sharedSignal?.aborted, true);
});

test("a request that hangs or is rate limited is retried instead of waiting forever", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (u: string) => {
    calls++;
    if (calls === 1) return new Response("", { status: 429 });        // rate limited once
    if (u.endsWith("/archives")) return new Response(JSON.stringify({ archives: [] }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await fetchGames("slowpoke", 10, null), []);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = real; }
});
