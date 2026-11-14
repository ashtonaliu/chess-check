// Chess.com's compact move encoding ("TCN"), used by the game endpoint the game page loads.
// Each move is two characters: from-square and to-square as indexes into this alphabet
// (a1 = 0, b1 = 1, ... h8 = 63). A to-character past 63 is a promotion: it names the piece
// and whether the pawn moved straight, or captured left or right.
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=";
const PROMO = "qnrbkp";

const square = (i: number) => "abcdefgh"[i % 8] + (Math.floor(i / 8) + 1);

export interface TcnMove { from: string; to: string; promotion?: string }

export function decodeTcn(tcn: string): TcnMove[] {
  const out: TcnMove[] = [];
  for (let i = 0; i + 1 < tcn.length; i += 2) {
    const from = ALPHABET.indexOf(tcn[i]);
    let to = ALPHABET.indexOf(tcn[i + 1]);
    if (from < 0 || to < 0 || from > 63) throw new Error(`Unreadable move code "${tcn.slice(i, i + 2)}".`);
    let promotion: string | undefined;
    if (to > 63) {
      promotion = PROMO[Math.floor((to - 64) / 3)];
      to = from + (from < 16 ? -8 : 8) + ((to - 1) % 3) - 1;
    }
    out.push({ from: square(from), to: square(to), ...(promotion ? { promotion } : {}) });
  }
  return out;
}
