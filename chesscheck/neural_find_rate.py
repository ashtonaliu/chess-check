"""Input encoding and model for neural find-rate prediction."""
from dataclasses import dataclass
import math

import chess
import numpy as np
import torch
from torch import nn

BOARD_PLANES = 21
SPEEDS = ("ultraBullet", "bullet", "blitz", "rapid", "classical", "daily")
SOURCES = ("chesscom", "lichess")
SCALAR_FEATURES = 1 + len(SPEEDS) + 3
MOVE_FEATURES = 21
CHANNELS = 32
HIDDEN = 32
ARTIFACT_VERSION = 1
LAYER_NAMES = ("conv1", "conv2", "hidden", "output")


@dataclass(frozen=True)
class RatingScale:
    mean: float
    std: float

    def __post_init__(self):
        if not math.isfinite(self.mean) or not math.isfinite(self.std) or self.std <= 0:
            raise ValueError("Rating standardization requires a finite mean and positive standard deviation")


def encode_board(fen: str, best: str) -> np.ndarray:
    """Encode a standard-chess position and a legal best move given in UCI or SAN."""
    board = chess.Board(fen)
    if not board.is_valid():
        raise ValueError("The position is invalid")
    try:
        move = board.parse_uci(best)
    except ValueError:
        move = board.parse_san(best)
    if not move:
        raise ValueError("The best move must be a played move")

    # Python chess indexes a1 first. Reflect ranks for Black so the mover's home rank is first.
    flip = 0 if board.turn == chess.WHITE else 56
    planes = np.zeros((BOARD_PLANES, 64), dtype=np.float32)
    for side, color in enumerate((board.turn, not board.turn)):
        occupied = board.occupied_co[color]
        attacks = 0
        for square in chess.scan_forward(occupied):
            piece = board.piece_type_at(square)
            planes[6 * side + piece - 1, square ^ flip] = 1
            attacks |= board.attacks_mask(square)
        for square in chess.scan_forward(attacks):
            planes[14 + side, square ^ flip] = 1
        planes[16 + 2 * side].fill(board.has_kingside_castling_rights(color))
        planes[17 + 2 * side].fill(board.has_queenside_castling_rights(color))
    planes[12, move.from_square ^ flip] = 1
    planes[13, move.to_square ^ flip] = 1
    if board.ep_square is not None and board.has_legal_en_passant():
        planes[20, board.ep_square ^ flip] = 1
    return planes.reshape(BOARD_PLANES, 8, 8)


def encode_scalars(rating: float, speed: str, clock_frac: float | None, source: str,
                   scale: RatingScale) -> np.ndarray:
    """Encode context with the rating statistics fitted for the row's source."""
    if source not in SOURCES or speed not in SPEEDS or not math.isfinite(rating):
        raise ValueError("Expected a finite rating and a supported speed and source")
    if clock_frac is not None and not math.isfinite(clock_frac):
        raise ValueError("The clock fraction must be finite or missing")
    scaled_rating = (rating - scale.mean) / scale.std
    clock = 0 if clock_frac is None else min(1.5, max(0, clock_frac))
    return np.array([scaled_rating, *(speed == value for value in SPEEDS),
                     clock, clock_frac is None, source == "lichess"], dtype=np.float32)


class NeuralFindRate(nn.Module):
    def __init__(self, extra_features: int = 0):
        super().__init__()
        self.conv1 = nn.Conv2d(BOARD_PLANES, CHANNELS, kernel_size=3, padding=1)
        self.conv2 = nn.Conv2d(CHANNELS, CHANNELS, kernel_size=3, padding=1)
        self.hidden = nn.Linear(CHANNELS * 64 + SCALAR_FEATURES + extra_features, HIDDEN)
        self.output = nn.Linear(HIDDEN, 1)

    def logits(self, board: torch.Tensor, scalars: torch.Tensor) -> torch.Tensor:
        x = torch.relu(self.conv1(board))
        x = torch.relu(self.conv2(x)).flatten(1)
        x = torch.relu(self.hidden(torch.cat((x, scalars), dim=1)))
        return self.output(x).squeeze(-1)

    def forward(self, board: torch.Tensor, scalars: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.logits(board, scalars))
