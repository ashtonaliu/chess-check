// The layout mirrors chesscheck/neural_find_rate.py and the Phase B methods.
import { Chess, type Move, type Square } from "chess.js";
import { moveFeatures } from "./findRate";

const BOARD_PLANES = 21, SQUARES = 64, CHANNELS = 32, HIDDEN = 32;
const PIECES = "pnbrqk";
const SPEEDS = ["ultraBullet", "bullet", "blitz", "rapid", "classical", "daily"] as const;
const SCALAR_FEATURES = 1 + SPEEDS.length + 3;
const MOVE_FEATURES = 21;
const squareIndex = (square: Square) => (Number(square[1]) - 1) * 8 + square.charCodeAt(0) - 97;

type Source = "chesscom" | "lichess";
interface RatingScale { mean: number; std: number }
export interface FindRateContext {
  rating: number;
  speed: typeof SPEEDS[number];
  clockFrac: number | null;
  source: Source;
}

/** Encode the position before the given legal move. Planes run from the mover's home rank upward. */
export function encodeNeuralBoard(fen: string, best: string): Float32Array | null {
  let board: Chess, move: Move;
  try {
    board = new Chess(fen);
    const uci = /^([a-h][1-8])([a-h][1-8])([nbrq])?$/.exec(best);
    move = uci ? board.move({ from: uci[1], to: uci[2], promotion: uci[3] }) : board.move(best, { strict: true });
    if (move.san === "--" || (uci && move.promotion !== uci[3])) return null;
    board.undo();
  } catch {
    return null;
  }

  const mover = board.turn(), opponent = mover === "w" ? "b" : "w";
  const flip = mover === "b" ? 56 : 0;
  const index = (square: Square) => squareIndex(square) ^ flip;
  const planes = new Float32Array(BOARD_PLANES * SQUARES);
  for (const rank of board.board()) {
    for (const piece of rank) {
      if (!piece) continue;
      const channel = PIECES.indexOf(piece.type) + (piece.color === mover ? 0 : 6);
      planes[channel * SQUARES + index(piece.square)] = 1;
    }
  }
  planes[12 * SQUARES + index(move.from)] = 1;
  planes[13 * SQUARES + index(move.to)] = 1;
  for (let square = 0; square < SQUARES; square++) {
    const name = `${String.fromCharCode(97 + square % 8)}${1 + Math.floor(square / 8)}` as Square;
    planes[14 * SQUARES + (square ^ flip)] = Number(board.isAttacked(name, mover));
    planes[15 * SQUARES + (square ^ flip)] = Number(board.isAttacked(name, opponent));
  }
  const rights = ([mover, opponent] as const).flatMap(color => {
    const flags = board.getCastlingRights(color);
    return [flags.k, flags.q];
  });
  rights.forEach((allowed, i) => planes.fill(Number(allowed), (16 + i) * SQUARES, (17 + i) * SQUARES));
  const ep = board.fen().split(" ")[3];
  if (ep !== "-") planes[20 * SQUARES + index(ep as Square)] = 1;
  return planes;
}

export function encodeNeuralScalars(context: FindRateContext, scale: RatingScale): Float32Array {
  const { rating, speed, clockFrac, source } = context;
  return Float32Array.from([
    (rating - scale.mean) / scale.std, ...SPEEDS.map(value => Number(value === speed)),
    clockFrac === null ? 0 : Math.min(1.5, Math.max(0, clockFrac)),
    Number(clockFrac === null), Number(source === "lichess"),
  ]);
}

interface PackedLayer { weights: string; scales: number[]; biases: number[] }
export interface NeuralFindRateWeights {
  version: number;
  ratings: Partial<Record<Source, RatingScale>>;
  moveFeatures?: boolean;
  layers: Record<"conv1" | "conv2" | "hidden" | "output", PackedLayer>;
}
interface Layer { weights: Float32Array; bias: Float32Array }

function unpack(layer: PackedLayer, inputs: number, outputs: number): Layer {
  const bytes = atob(layer.weights);
  if (bytes.length !== inputs * outputs || layer.scales.length !== outputs || layer.biases.length !== outputs ||
      !layer.scales.every(scale => Number.isFinite(scale) && scale > 0) || !layer.biases.every(Number.isFinite)) {
    throw new Error("Invalid neural find-rate layer");
  }
  const weights = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes.charCodeAt(i);
    weights[i] = (byte < 128 ? byte : byte - 256) * layer.scales[Math.floor(i / inputs)];
  }
  return { weights, bias: Float32Array.from(layer.biases) };
}

function convolve(input: Float32Array, layer: Layer, channels: number): Float32Array {
  const output = new Float32Array(layer.bias.length * SQUARES);
  for (let o = 0; o < layer.bias.length; o++) {
    for (let row = 0; row < 8; row++) {
      for (let file = 0; file < 8; file++) {
        let sum = layer.bias[o];
        for (let c = 0; c < channels; c++) {
          const kernel = (o * channels + c) * 9;
          for (let y = Math.max(0, 1 - row); y < Math.min(3, 9 - row); y++) {
            for (let x = Math.max(0, 1 - file); x < Math.min(3, 9 - file); x++) {
              const square = (row + y - 1) * 8 + file + x - 1;
              sum += input[c * SQUARES + square] * layer.weights[kernel + y * 3 + x];
            }
          }
        }
        output[o * SQUARES + row * 8 + file] = Math.max(0, sum);
      }
    }
  }
  return output;
}

function linear(input: Float32Array, layer: Layer, relu: boolean): Float32Array {
  const output = new Float32Array(layer.bias.length);
  for (let o = 0; o < output.length; o++) {
    let sum = layer.bias[o];
    for (let i = 0; i < input.length; i++) sum += input[i] * layer.weights[o * input.length + i];
    output[o] = relu ? Math.max(0, sum) : sum;
  }
  return output;
}

export function encodeNeuralInputs(fen: string, best: string, context: FindRateContext, artifact: NeuralFindRateWeights) {
  const ratings = artifact.ratings[context.source];
  if (!ratings || !SPEEDS.includes(context.speed) || !Number.isFinite(context.rating) ||
      (context.clockFrac !== null && !Number.isFinite(context.clockFrac))) return null;
  const board = encodeNeuralBoard(fen, best);
  if (!board) return null;
  const contextScalars = encodeNeuralScalars(context, ratings);
  if (!artifact.moveFeatures) return { board, scalars: contextScalars };
  const f = moveFeatures(fen, best);
  if (!f) return null;
  const scalars = new Float32Array(SCALAR_FEATURES + MOVE_FEATURES);
  scalars.set(contextScalars);
  scalars.set([
    f.is_capture, f.gives_check, f.is_promotion, f.is_castle, f.backward, f.sideways, f.was_attacked,
    f.lands_attacked, f.in_check, f.captured_value / 9, Math.log1p(f.legal_moves), Math.log1p(f.captures_available),
    Math.log1p(f.checks_available), f.non_pawn_material / 62, Math.min(Math.max(f.material_balance, -15), 15) / 15,
    ...[1, 2, 3, 4, 5, 6].map(piece => Number(f.piece === piece)),
  ], SCALAR_FEATURES);
  return { board, scalars };
}

/** Decode the int8 export once and run inference on encoded positions. */
export function createNeuralForward(artifact: NeuralFindRateWeights) {
  if (artifact.version !== 1) throw new Error("Unsupported neural find-rate weights version");
  if (!artifact.ratings.chesscom && !artifact.ratings.lichess) throw new Error("Missing rating scales");
  for (const { mean, std } of Object.values(artifact.ratings)) {
    if (!Number.isFinite(mean) || !Number.isFinite(std) || std <= 0) throw new Error("Invalid rating scale");
  }
  const first = unpack(artifact.layers.conv1, BOARD_PLANES * 9, CHANNELS);
  const second = unpack(artifact.layers.conv2, CHANNELS * 9, CHANNELS);
  const scalarCount = SCALAR_FEATURES + (artifact.moveFeatures ? MOVE_FEATURES : 0);
  const hidden = unpack(artifact.layers.hidden, CHANNELS * SQUARES + scalarCount, HIDDEN);
  const output = unpack(artifact.layers.output, HIDDEN, 1);
  return (board: Float32Array, scalars: Float32Array): number => {
    if (board.length !== BOARD_PLANES * SQUARES || scalars.length !== scalarCount) {
      throw new Error("Invalid neural find-rate inputs");
    }
    const spatial = convolve(convolve(board, first, BOARD_PLANES), second, CHANNELS);
    const input = new Float32Array(CHANNELS * SQUARES + scalarCount);
    input.set(spatial);
    input.set(scalars, spatial.length);
    const logit = linear(linear(input, hidden, true), output, false)[0];
    return 1 / (1 + Math.exp(-logit));
  };
}

export function createNeuralFindRate(artifact: NeuralFindRateWeights) {
  const forward = createNeuralForward(artifact);
  return (fen: string, best: string, context: FindRateContext): number | null => {
    const input = encodeNeuralInputs(fen, best, context, artifact);
    return input && forward(input.board, input.scalars);
  };
}
