import { fitLogReg } from "./model";

declare const CHESS_CHECK_RUST_RISK: number;
type Fit = typeof fitLogReg;

export async function createWasmRiskModel(bytes: ArrayBuffer): Promise<Fit> {
  const { instance } = await WebAssembly.instantiate(bytes);
  const { memory, reserve_training, fit_training } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof reserve_training !== "function"
      || typeof fit_training !== "function") {
    throw new Error("Invalid risk model exports");
  }
  return (features, outcomes, penalty = 1, iterations = 50) => {
    const dimensions = features[0].length;
    const width = dimensions + 1;
    const size = width * features.length;
    const inputPointer = reserve_training(size);
    const input = new Float64Array(memory.buffer, inputPointer, size);
    features.forEach((row, i) => {
      input.set(row, i * width);
      input[i * width + dimensions] = outcomes[i];
    });
    const outputPointer = fit_training(width, penalty, iterations);
    const output = new Float64Array(memory.buffer, outputPointer, 3 * dimensions + 1);
    return {
      mean: Array.from(output.subarray(0, dimensions)),
      scale: Array.from(output.subarray(dimensions, 2 * dimensions)),
      w: Array.from(output.subarray(2 * dimensions, 3 * dimensions)),
      b: output[3 * dimensions],
    };
  };
}

const models = new Map<string, Promise<Fit | undefined>>();

export function loadWasmRiskModel(engineUrl: string): Promise<Fit | undefined> {
  if (typeof CHESS_CHECK_RUST_RISK === "undefined" || CHESS_CHECK_RUST_RISK !== 1) {
    return Promise.resolve(undefined);
  }
  const url = new URL("chess_check_risk.wasm", engineUrl).href;
  let model = models.get(url);
  if (!model) {
    model = fetch(url).then(async response => {
      if (!response.ok) throw new Error("Could not load risk model");
      const fit = await createWasmRiskModel(await response.arrayBuffer());
      const fitWithFallback: Fit = (...args) => {
        try {
          return fit(...args);
        } catch {
          return fitLogReg(...args);
        }
      };
      return fitWithFallback;
    }).catch(() => {
      models.delete(url);
      return undefined;
    });
    models.set(url, model);
  }
  return model;
}
