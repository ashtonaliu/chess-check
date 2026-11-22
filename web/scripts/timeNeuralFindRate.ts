import {
  createNeuralFindRate, createNeuralForward, encodeNeuralInputs, type FindRateContext, type NeuralFindRateWeights,
} from "../src/browser/neuralFindRate";

interface Position { fen: string; best: string; context: FindRateContext }

export function time(weights: NeuralFindRateWeights, positions: Position[], passes: number) {
  const encoded = positions.map(({ fen, best, context }) => {
    const input = encodeNeuralInputs(fen, best, context, weights);
    if (!input) throw new Error("Invalid benchmark position");
    return input;
  });
  const forward = createNeuralForward(weights);
  const predict = createNeuralFindRate(weights);
  const predictOne = (p: Position) => predict(p.fen, p.best, p.context)!;
  const forwardOne = (input: typeof encoded[number]) => forward(input.board, input.scalars);

  function measure<T>(inputs: T[], evaluate: (input: T) => number) {
    let checksum = 0;
    for (const input of inputs) checksum += evaluate(input);
    const ms: number[] = [];
    for (let pass = 0; pass < passes; pass++) {
      for (const input of inputs) {
        const start = performance.now();
        const probability = evaluate(input);
        ms.push(performance.now() - start);
        checksum += probability;
      }
    }
    if (!(checksum > 0)) throw new Error("Invalid benchmark predictions");
    return { ms, checksum };
  }
  return { forward: measure(encoded, forwardOne), withEncoding: measure(positions, predictOne) };
}
