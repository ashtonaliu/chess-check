// Bundled Lichess CC0 puzzle picker for finished-game recap patterns.
// Makes no network requests at recap time and picks from a fixed Lichess puzzle rating band
// (1200 to 1799), displaying each puzzle's own Lichess puzzle rating rather than claiming a
// game-rating match.
import index from "./patternPuzzlesIndex.json";

export interface PatternPuzzle {
  id: string;
  rating: number;
  url: string;
}

type Entry = readonly [string, number];
interface PuzzleIndex {
  source: string;
  bands: readonly (readonly [number, number])[];
  motifs: Record<string, readonly (readonly Entry[])[]>;
}

const DATA = index as unknown as PuzzleIndex;
const TRAINING_BASE = ["https:", "", "lichess.org", "training"].join("/");

export const PATTERN_PUZZLE_BAND: readonly [number, number] = [
  DATA.bands[0][0],
  DATA.bands[DATA.bands.length - 1][1],
];

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick up to `count` distinct puzzles for a reported tactic motif, spread across the fixed rating bands. */
export function pickPatternPuzzles(motif: string, seedKey = "", count = 3,
                                   customIndex: PuzzleIndex = DATA): PatternPuzzle[] {
  const buckets = customIndex.motifs[motif];
  if (!buckets || !buckets.length || count <= 0) return [];
  const seed = hashSeed(`${motif}:${seedKey}`);
  const picked: PatternPuzzle[] = [];
  const seen = new Set<string>();

  // First take one puzzle per rating band, then fill any remaining slots from the buckets in order.
  for (let round = 0; picked.length < count; round++) {
    let added = false;
    for (let b = 0; b < buckets.length && picked.length < count; b++) {
      const list = buckets[b];
      if (!list || round >= list.length) continue;
      const start = (seed + b * 31 + round) % list.length;
      for (let step = 0; step < list.length; step++) {
        const [id, rating] = list[(start + step) % list.length];
        if (seen.has(id)) continue;
        seen.add(id);
        picked.push({ id, rating, url: `${TRAINING_BASE}/${id}` });
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return picked;
}
