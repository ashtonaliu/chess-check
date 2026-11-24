import chess

from chesscheck.tactics import classify_game


def test_pawn_lost_to_en_passant_is_recorded():
    pgn = "1. e4 a6 2. e5 d5 3. Nf3"
    board = chess.Board()
    rows = []
    for ply, san in enumerate(["e4", "a6", "e5", "d5", "Nf3"]):
        blunder = ply == 3
        rows.append({"ply": ply, "move_no": ply // 2 + 1, "san": san, "is_me": ply % 2 == 1,
                     "phase": "opening", "fen": board.fen(), "cp_before": 0,
                     "cp_after": 300 if blunder else 0, "wp_loss": 30 if blunder else 0,
                     "best": {3: "c6", 4: "exd6"}.get(ply)})
        board.push_san(san)
    [rec] = classify_game(pgn, {"url": "https://www.chess.com/game/live/1", "moves": rows})
    assert rec["refutation"] == "exd6"
    assert rec["lost"] == "pawn"
