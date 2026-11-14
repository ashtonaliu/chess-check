"""Test motif-specific blitz matchups on the fixed engine-odds cohort.

Requires the prior study's sample manifest and Chess.com download cache.
Reads both offline. Depth-10 motif counts are cached separately by game ID.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
from hashlib import file_digest, sha256
import io
import json
import math
from pathlib import Path
import time

import chess.engine
import chess.pgn
import numpy as np

import eval_engine_features as study
from chesscheck import engine, tactics

MOTIFS = tuple(tactics.MOTIFS)
FIELDS = ('opportunities', 'missed', 'allowed', 'played')
GRID = (0.0001, 0.001, 0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0)


def offline_get(url, cache):
    path = cache / 'downloads' / (sha256(url.encode()).hexdigest() + '.json')
    return json.loads(path.read_bytes()) if path.is_file() else {}


def plan(source, cache, manifest_path):
    manifest = json.loads(manifest_path.read_bytes())
    data = (source / 'targets.json').read_bytes()
    if sha256(data).hexdigest() != manifest['targets_sha256']:
        raise ValueError('Target source differs from the original sample')
    selected = study.sample_targets(json.loads(data), manifest['sampled'])
    if [study.game_id(t['url']) for t in selected] != manifest['sample_ids']:
        raise ValueError('Sample IDs differ from the original sample')
    previous_get = study.get
    try:
        study.get = offline_get
        rows, jobs, exclusions = study.plan(selected, source, cache)
    finally:
        study.get = previous_get
    reconstructed = []
    history_ids = set()
    for focal, raw, gid, ratings, histories in rows:
        start = study.game_start(raw)
        reconstructed.append(dict(focal=focal, id=gid, start=start, ratings=ratings,
                                  histories=[[list(entry) for entry in h] for h in histories]))
        for user_history in histories:
            if len(user_history) != study.HISTORY:
                raise ValueError(f'Unexpected history length for {gid}')
            for key, _ in user_history:
                if not 0 < jobs[key]['end_time'] < start:
                    raise ValueError(f'Post-start history for {gid}')
                history_ids.add(key)
    if reconstructed != manifest['eligible_targets'] or exclusions != manifest['exclusions']:
        raise ValueError('Reconstructed histories or ratings differ from the original manifest')
    return rows, {gid: raw for gid, raw in jobs.items() if gid in history_ids}


def count_game(pgn, fish):
    game = chess.pgn.read_game(io.StringIO(pgn))
    board = game.board()
    limit = chess.engine.Limit(depth=study.DEPTH)
    sides = {color: dict(moves=0, **{field: dict.fromkeys(MOTIFS, 0) for field in FIELDS})
             for color in ('white', 'black')}

    def evaluate():
        if board.is_game_over():
            winner = board.outcome().winner
            cp = 0 if winner is None else (3000 if winner else -3000)
            return cp, None
        info = fish.analyse(board, limit)
        return info['score'].white().score(mate_score=3000), next(iter(info.get('pv', ())), None)

    before, best = evaluate()
    for played in game.mainline_moves():
        color = 'white' if board.turn else 'black'
        record = sides[color]
        record['moves'] += 1
        sign = 1 if board.turn else -1
        best_tags = tactics.motifs(board, best) if best else set()
        played_tags = best_tags if played == best else tactics.motifs(board, played)
        board.push(played)
        after, reply = evaluate()
        drop = round(engine.win_pct(before * sign) - engine.win_pct(after * sign), 1)
        for motif in best_tags:
            record['opportunities'][motif] += 1
            if motif not in played_tags and drop >= engine.BLUNDER_DROP:
                record['missed'][motif] += 1
        if drop < engine.BLUNDER_DROP:
            for motif in played_tags:
                record['played'][motif] += 1
        elif reply:
            for motif in tactics.motifs(board, reply):
                record['allowed'][motif] += 1
        before, best = after, reply
    return sides


def analyse_batch(batch, binary, destination):
    with chess.engine.SimpleEngine.popen_uci(binary) as fish:
        fish.configure({'Threads': 1, 'Hash': 32})
        for gid, raw in batch:
            started = time.perf_counter()
            sides = count_game(raw['pgn'], fish)
            study.write_json(destination / f'{gid}.json',
                             dict(sides=sides, engine_seconds=time.perf_counter() - started))
    return len(batch)


def analyse_games(jobs, binary, destination, workers):
    destination.mkdir(parents=True, exist_ok=True)
    pending = [(gid, raw) for gid, raw in jobs.items() if not (destination / f'{gid}.json').is_file()]
    done = len(jobs) - len(pending)
    print(f'Motifs: {done}/{len(jobs)} cached games', flush=True)
    if pending:
        with ProcessPoolExecutor(workers) as pool:
            futures = [pool.submit(analyse_batch, pending[i:i + 32], binary, destination)
                       for i in range(0, len(pending), 32)]
            for finished in as_completed(futures):
                previous = done
                done += finished.result()
                if done // 500 > previous // 500 or done == len(jobs):
                    print(f'Motifs: {done}/{len(jobs)} games', flush=True)
    return {gid: json.loads((destination / f'{gid}.json').read_bytes()) for gid in jobs}


def profile(history, counts):
    games = [counts[gid]['sides'][side] for gid, side in history]
    moves = sum(game['moves'] for game in games)
    features = {}
    for motif in MOTIFS:
        opportunities, missed, allowed, played = [
            sum(game[field][motif] for game in games) for field in FIELDS
        ]
        # Small fixed pseudo-counts shrink sparse rates toward zero equally for every fold.
        features[motif] = np.array([opportunities / (moves + 100), missed / (opportunities + 10),
                                    allowed / (moves + 100), played / (moves + 100)])
    return features


def motif_support(counts):
    """Count events once per history game, even if several targets use it."""
    totals = {motif: dict.fromkeys(FIELDS, 0) for motif in MOTIFS}
    for game in counts.values():
        for side in game['sides'].values():
            for motif, events in totals.items():
                for field in FIELDS:
                    events[field] += side[field][motif]
    return totals


def feature_rows(rows, counts):
    ratings, main, interactions, outcomes, groups = [], [], [], [], []
    for focal, raw, _, pregame, histories in rows:
        color = study.side(raw, focal)
        groups.append(focal)
        outcomes.append(round(2 * study.score_of(raw[color]['result'])))
        elo = min(max(study.expected(*pregame), 1e-4), 1 - 1e-4)
        ratings.append([math.log(elo / (1 - elo)), float(color == 'white')])
        a, b = [profile(history, counts) for history in histories]
        main.append(np.concatenate([a[m] - b[m] for m in MOTIFS]))
        interactions.append(np.array([
            a[m][3] * b[m][vulnerability] - b[m][3] * a[m][vulnerability]
            for m in MOTIFS for vulnerability in (1, 2)
        ]))
    return tuple(np.asarray(values) for values in (ratings, main, interactions, outcomes, groups))


def evaluate(rows, counts):
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import GroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from threadpoolctl import threadpool_limits

    ratings, main, interactions, y, groups = feature_rows(rows, counts)
    outer = GroupKFold(5).split(ratings, y, groups)
    folds = [(train, test, [(train[a], train[b]) for a, b in
               GroupKFold(4).split(ratings[train], y[train], groups[train])]) for train, test in outer]

    def predict(x, train, test, c):
        model = make_pipeline(StandardScaler(), LogisticRegression(C=c, max_iter=5000))
        model.fit(x[train], y[train])
        probabilities = np.zeros((len(test), 3))
        probabilities[:, model.classes_] = model.predict_proba(x[test])
        return probabilities

    def brier(p, labels):
        return (p[:, 2] + 0.5 * p[:, 1] - labels / 2) ** 2

    models = {
        'ratings_color': ratings,
        'ratings_color_motifs': np.column_stack((ratings, main)),
        'ratings_color_motifs_matchups': np.column_stack((ratings, main, interactions)),
    }
    predictions, summary = {}, {}
    with threadpool_limits(limits=1):
        for name, x in models.items():
            out = np.zeros((len(y), 3))
            settings = []
            for train, test, inner in folds:
                c = min(GRID, key=lambda c: np.concatenate(
                    [brier(predict(x, a, b, c), y[b]) for a, b in inner]).mean())
                settings.append(c)
                out[test] = predict(x, train, test, c)
            predictions[name] = {
                'brier': brier(out, y),
                'log_loss': -np.log(np.clip(out[np.arange(len(y)), y], 1e-12, 1)),
            }
            summary[name] = {k: float(v.mean()) for k, v in predictions[name].items()}
            summary[name]['chosen_c'] = settings

    rng = np.random.default_rng(study.SEED)
    comparisons = []
    ratings_only, profiles, matchups = models
    for base, full in ((ratings_only, profiles), (ratings_only, matchups), (profiles, matchups)):
        metrics = {}
        for metric in ('brier', 'log_loss'):
            change = predictions[base][metric] - predictions[full][metric]
            metrics[metric] = dict(improvement=float(change.mean()),
                                  interval_90=study._boot(change, groups, rng).tolist())
        comparisons.append(dict(baseline=base, model=full, metrics=metrics))
    return dict(targets=len(y), focal_players=len(set(groups)), models=summary, comparisons=comparisons)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=study.ROOT / 'data/odds/v3')
    parser.add_argument('--cache', type=Path, default=study.ROOT / 'data/odds/engine')
    parser.add_argument('--manifest', default='sample-84e6d97cc5da-1000.json')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    binary = engine.find_stockfish()
    if not binary or args.workers < 1:
        parser.error('A Stockfish binary and positive worker count are required')
    manifest_path = args.cache / args.manifest
    rows, jobs = plan(args.source, args.cache, manifest_path)
    with Path(binary).open('rb') as handle:
        identity = file_digest(handle, 'sha256').hexdigest()[:16]
    destination = args.cache / f'motifs-v1-d{study.DEPTH}-{identity}'
    started = time.perf_counter()
    counts = analyse_games(jobs, binary, destination, args.workers)
    wall_seconds = time.perf_counter() - started
    result = evaluate(rows, counts)
    result.update(games=len(jobs), depth=study.DEPTH, motifs=MOTIFS, engine_binary=identity,
                  engine_seconds=sum(data['engine_seconds'] for data in counts.values()),
                  engine_stage_wall_seconds=wall_seconds, motif_support=motif_support(counts))
    path = args.cache / f'{manifest_path.stem}-tactic-matchups-{identity}.json'
    study.write_json(path, result)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
