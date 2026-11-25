import type { Site } from "../site";
import { history } from "../games";
import { gameFromCallback, isStandardCallback, nameCallbackOpening } from "../callbackGame";
import { chesscomPages, isFinishedCallback, type ChesscomEvidence } from "./chesscomPages";

const callbackEvidence = (value: unknown): Partial<ChesscomEvidence> => (value ?? {}) as Partial<ChesscomEvidence>;

export const chesscom: Site = {
  ...chesscomPages,
  history,
  // The archive cannot be filtered by color, and the pregame ratings need the games in between.
  opponentHistory: (user, _color, timeClass, signal) => history(user, timeClass, 100, signal),
  nameOpening: nameCallbackOpening,
  isFinishedGame: (id, evidence) => isFinishedCallback(id, callbackEvidence(evidence).callback),
  finishedGame(id, user, evidence) {
    const { callback, kind } = callbackEvidence(evidence);
    if (!callback || !isFinishedCallback(id, callback)) return "pending";
    if (!isStandardCallback(callback)) throw new Error("Chess Check only reviews standard chess games.");
    return gameFromCallback(callback, user, kind ?? "live", []);
  },
};
