"""Export a neural find-rate checkpoint to ONNX and the TypeScript weight format."""
import argparse
import base64
import copy
from dataclasses import asdict
import json
from pathlib import Path
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chesscheck.neural_find_rate import (ARTIFACT_VERSION, BOARD_PLANES, CHANNELS, LAYER_NAMES, MOVE_FEATURES, SCALAR_FEATURES,
                                       SOURCES, NeuralFindRate, RatingScale)


def load_checkpoint(path: Path):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    state = checkpoint["state_dict"]
    extra = state["hidden.weight"].shape[1] - CHANNELS * 64 - SCALAR_FEATURES
    variant = checkpoint.get("variant")
    if extra not in (0, MOVE_FEATURES) or (variant and not (variant["board"] and variant["context"])):
        raise ValueError("Export requires the board and context model, optionally with move features")
    model = NeuralFindRate(extra)
    model.load_state_dict(state)
    ratings = {source: RatingScale(**value) for source, value in checkpoint["ratings"].items()}
    return model.eval(), ratings


@torch.inference_mode()
def export_model(model: NeuralFindRate, ratings: dict[str, RatingScale], directory: Path,
                 precision: str = "int8") -> None:
    """Write a float graph and a packed-weight graph with the same float operations."""
    if precision not in ("int8", "float16"):
        raise ValueError(f"Unsupported precision: {precision}")
    if not ratings or not set(ratings).issubset(SOURCES):
        raise ValueError("The checkpoint must supply ratings for its training sources")
    model = copy.deepcopy(model).cpu().float().eval()
    directory.mkdir(parents=True, exist_ok=True)
    float_path = directory / "model.onnx"
    scalar_count = model.hidden.in_features - CHANNELS * 64
    torch.onnx.export(
        model, (torch.zeros((1, BOARD_PLANES, 8, 8)), torch.zeros((1, scalar_count))),
        str(float_path), dynamo=False, opset_version=17, input_names=["board", "scalars"],
        output_names=["probability"], dynamic_axes={name: {0: "batch"}
                                                   for name in ("board", "scalars", "probability")},
    )

    graph = onnx.load(float_path)
    initializers = {tensor.name: tensor for tensor in graph.graph.initializer}
    dequant = []
    layers = {}
    for name in LAYER_NAMES:
        layer = getattr(model, name)
        weight, bias = layer.weight.detach().numpy(), layer.bias.detach().numpy()
        if not np.isfinite(weight).all() or not np.isfinite(bias).all():
            raise ValueError(f"{name} contains non-finite parameters")
        if precision == "float16":
            packed_layer = {}
            for field, key, values in (("weight", "weights", weight), ("bias", "biases", bias)):
                parameter = f"{name}.{field}"
                packed = values.astype("<f2")
                if not np.isfinite(packed).all():
                    raise ValueError(f"{parameter} overflows float16")
                encoded = f"{parameter}.float16"
                graph.graph.initializer.remove(initializers[parameter])
                graph.graph.initializer.append(numpy_helper.from_array(packed, encoded))
                dequant.append(helper.make_node("Cast", [encoded], [parameter], to=onnx.TensorProto.FLOAT))
                packed_layer[key] = base64.b64encode(packed.tobytes()).decode("ascii")
            layers[name] = packed_layer
            continue
        peak = np.max(np.abs(weight).reshape(weight.shape[0], -1), axis=1)
        scale = np.where(peak > 0, np.maximum(peak / 127, np.finfo(np.float32).tiny), 1).astype(np.float32)
        divisor = scale.reshape((-1,) + (1,) * (weight.ndim - 1))
        packed = np.rint(weight / divisor).clip(-127, 127).astype(np.int8)
        weight_name = f"{name}.weight"
        graph.graph.initializer.remove(initializers[weight_name])
        packed_name, scale_name = f"{weight_name}.int8", f"{weight_name}.scale"
        graph.graph.initializer.extend([numpy_helper.from_array(packed, packed_name),
                                        numpy_helper.from_array(scale, scale_name)])
        dequant.append(helper.make_node("DequantizeLinear", [packed_name, scale_name], [weight_name], axis=0))
        layers[name] = {"weights": base64.b64encode(packed.tobytes()).decode("ascii"),
                        "scales": scale.tolist(), "biases": bias.tolist()}
    for index, node in enumerate(dequant):
        graph.graph.node.insert(index, node)
    onnx.checker.check_model(graph)
    onnx.save(graph, directory / f"model.{precision}.onnx")
    payload = {"version": ARTIFACT_VERSION if precision == "int8" else 2,
               "ratings": {key: asdict(scale) for key, scale in ratings.items()},
               "moveFeatures": scalar_count > SCALAR_FEATURES,
               "layers": layers}
    (directory / "weights.json").write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--precision", choices=("int8", "float16"), default="int8")
    args = parser.parse_args()
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    model, ratings = load_checkpoint(args.checkpoint)
    export_model(model, ratings, args.directory, args.precision)


if __name__ == "__main__":
    main()
