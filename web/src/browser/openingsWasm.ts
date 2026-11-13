import type { ShrinkOpenings } from "./stats";

declare const CHESS_CHECK_RUST_OPENINGS: number;

export async function createWasmOpeningModel(bytes: ArrayBuffer): Promise<ShrinkOpenings> {
  const { instance } = await WebAssembly.instantiate(bytes);
  const { memory, reserve_groups, shrink_groups } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof reserve_groups !== "function"
      || typeof shrink_groups !== "function") {
    throw new Error("Invalid opening model exports");
  }
  return (groups, sigma2, mu) => {
    if (!groups.length) return [];
    const inputPointer = reserve_groups(groups.length);
    const input = new Float64Array(memory.buffer, inputPointer, 2 * groups.length);
    groups.forEach(({ n, mean_resid }, i) => input.set([n, mean_resid], 2 * i));
    const pointer = shrink_groups(sigma2, mu);
    const output = new Float64Array(memory.buffer, pointer, 5 * groups.length);
    return groups.map((_, i) => {
      const [shrunk, post_sd, ci_low, ci_high, p_below] = output.subarray(5 * i, 5 * i + 5);
      return { shrunk, post_sd, ci_low, ci_high, p_below };
    });
  };
}

const models = new Map<string, Promise<ShrinkOpenings | undefined>>();

export function loadWasmOpeningModel(engineUrl: string): Promise<ShrinkOpenings | undefined> {
  if (typeof CHESS_CHECK_RUST_OPENINGS === "undefined" || CHESS_CHECK_RUST_OPENINGS !== 1) {
    return Promise.resolve(undefined);
  }
  const url = new URL("chess_check_openings.wasm", engineUrl).href;
  let model = models.get(url);
  if (!model) {
    model = fetch(url).then(async response => {
      if (!response.ok) throw new Error("Could not load opening model");
      return createWasmOpeningModel(await response.arrayBuffer());
    }).catch(() => {
      models.delete(url);
      return undefined;
    });
    models.set(url, model);
  }
  return model;
}
