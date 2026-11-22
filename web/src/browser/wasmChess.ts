// The extension installs its local wasm-bindgen bundle lazily. The website and
// unsupported archive records can continue using the existing chess.js path.
export interface PositionInfo {
  fen: string;
  turn: "w" | "b";
  legal: number;
  captures: number;
  check: boolean;
  balance: number;
  nonPawn: number;
  mate: boolean;
  over: boolean;
}

export interface ReplayPly extends PositionInfo { capture: boolean }
export interface ParsedPgn { moves: string[]; eco?: string; ecoUrl?: string; startFen?: string }
export interface MoveAt { fen: string; move: string }

interface ReplayBinding {
  free(): void;
  positions(): string;
  formatUci(batch: string): string;
}
export interface ChessBindings {
  GameReplay: new (fen: string | undefined, history: string) => ReplayBinding;
  positionBatch(batch: string): string;
  formatUciBatch(batch: string): string;
  advanceBatch(batch: string): string;
  moveFeaturesBatch(batch: string): string;
  parsePgnBatch(batch: string): string;
}
interface ChessModule extends ChessBindings { default(): Promise<unknown> }

function call<T>(operation: (batch: string) => string, rows: unknown[]): T[] {
  return JSON.parse(operation(JSON.stringify(rows))) as T[];
}

export class WasmChess {
  constructor(private bindings: ChessBindings) {}

  replay(fen: string | undefined, moves: readonly string[]) {
    if (moves.some(move => /[\r\n]/.test(move))) return null;
    let replay: ReplayBinding;
    try { replay = new this.bindings.GameReplay(fen, moves.join("\n")); }
    catch { return null; }
    return {
      plies: (): ReplayPly[] => JSON.parse(replay.positions()),
      san: (moves: (string | null)[]) => call<string | null>(batch => replay.formatUci(batch), moves),
      free: () => replay.free(),
    };
  }

  positions(fens: string[]): (PositionInfo | null)[] {
    return call(this.bindings.positionBatch, fens);
  }

  san(moves: MoveAt[]): (string | null)[] {
    return call(this.bindings.formatUciBatch, moves);
  }

  advance(moves: MoveAt[]): (PositionInfo | null)[] {
    return call(this.bindings.advanceBatch, moves);
  }

  features(moves: MoveAt[]): (number[] | null)[] {
    return call(this.bindings.moveFeaturesBatch, moves);
  }

  parsePgns(pgns: string[]): (ParsedPgn | null)[] {
    return call(this.bindings.parsePgnBatch, pgns);
  }
}

let asset: string | undefined;
let ready: Promise<WasmChess | null> | undefined;

export function configureWasmChess(assetUrl: string): void {
  asset = assetUrl;
  ready = undefined;
}

export function getWasmChess(): Promise<WasmChess | null> | undefined {
  if (!asset) return undefined;
  ready ??= import(asset).then(async (module: ChessModule) => {
    await module.default();
    return new WasmChess(module);
  }).catch(() => null);
  return ready;
}
