#!/usr/bin/env python3
"""Convert completed V7 outputs into the minimal web production dataset."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


ALLOWED_LABELS = {"main_flesh_band", "wart_flesh"}
SCHEMA_VERSION = "bitter-melon-prelabel-1.0"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


@dataclass
class Counts:
    images: int = 0
    main_groups: int = 0
    main_fragments: int = 0
    v7_main_polygons: int = 0
    web_main_polygons: int = 0
    wart_instances: int = 0
    v7_wart_polygons: int = 0
    web_wart_polygons: int = 0


def _nodes(flattened: list[Any], polygon_id: str, width: int, height: int) -> list[dict[str, Any]]:
    if len(flattened) < 6 or len(flattened) % 2:
        raise ValueError(f"{polygon_id}: polygon phải có ít nhất 3 điểm và số tọa độ chẵn")
    result = []
    for index in range(0, len(flattened), 2):
        x, y = flattened[index], flattened[index + 1]
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            raise ValueError(f"{polygon_id}: tọa độ không phải số")
        x, y = float(x), float(y)
        if not np.isfinite(x) or not np.isfinite(y) or not (0 <= x <= width and 0 <= y <= height):
            raise ValueError(f"{polygon_id}: tọa độ ({x}, {y}) nằm ngoài ảnh")
        result.append({"id": f"{polygon_id}_node_{index // 2 + 1}", "x": x, "y": y})
    return result


def convert_prelabel(source: dict[str, Any], expected_id: str) -> tuple[dict[str, Any], Counts]:
    image = source.get("image") or {}
    image_id = str(image.get("id") or "")
    width, height = int(image.get("width") or 0), int(image.get("height") or 0)
    if image_id != expected_id or width <= 0 or height <= 0:
        raise ValueError(f"{expected_id}: metadata ảnh V7 không hợp lệ")

    counts = Counts(images=1)
    polygons: list[dict[str, Any]] = []
    polygon_ids: set[str] = set()

    for group in source.get("main_flesh_bands") or []:
        counts.main_groups += 1
        group_id = group.get("main_group_id")
        corridor_id = group.get("corridor_id")
        fragments = group.get("fragments") or []
        counts.main_fragments += len(fragments)
        for fragment in fragments:
            fragment_index = fragment.get("fragment_index")
            primitive_id = fragment.get("primitive_id")
            source_polygons = fragment.get("polygons") or []
            counts.v7_main_polygons += len(source_polygons)
            for polygon_index, flattened in enumerate(source_polygons, start=1):
                polygon_id = f"main_{group_id}_frag_{fragment_index}_poly_{polygon_index}"
                if polygon_id in polygon_ids:
                    raise ValueError(f"{expected_id}: duplicate polygon ID {polygon_id}")
                polygon_ids.add(polygon_id)
                polygons.append({
                    "id": polygon_id,
                    "label": "main_flesh_band",
                    "nodes": _nodes(flattened, polygon_id, width, height),
                    "meta": {
                        "semantic": "main_flesh_band",
                        "mainGroupId": group_id,
                        "fragmentIndex": fragment_index,
                        "corridorId": corridor_id,
                        "primitiveId": primitive_id,
                        "source": "model",
                    },
                })
                counts.web_main_polygons += 1

    for wart in source.get("wart_flesh_instances") or []:
        counts.wart_instances += 1
        wart_id = wart.get("wart_id")
        source_polygons = wart.get("polygons") or []
        counts.v7_wart_polygons += len(source_polygons)
        for polygon_index, flattened in enumerate(source_polygons, start=1):
            polygon_id = f"wart_{wart_id}_poly_{polygon_index}"
            if polygon_id in polygon_ids:
                raise ValueError(f"{expected_id}: duplicate polygon ID {polygon_id}")
            polygon_ids.add(polygon_id)
            polygons.append({
                "id": polygon_id,
                "label": "wart_flesh",
                "nodes": _nodes(flattened, polygon_id, width, height),
                "meta": {
                    "semantic": "wart_flesh",
                    "wartId": wart_id,
                    "corridorId": wart.get("corridor_id"),
                    "primitiveId": wart.get("primitive_id"),
                    "source": "model",
                },
            })
            counts.web_wart_polygons += 1

    if counts.v7_main_polygons != counts.web_main_polygons or counts.v7_wart_polygons != counts.web_wart_polygons:
        raise ValueError(f"{expected_id}: số polygon trước/sau conversion không khớp")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "imageId": image_id,
        "coordinateSpace": "image_pixels",
        "width": width,
        "height": height,
        "maskOperations": [{"type": "POLYGON_SET", "polygons": polygons}],
    }, counts


def _find_original(images_dir: Path, image_id: str) -> Path:
    matches = [p for p in images_dir.iterdir() if p.is_file() and p.stem.casefold() == image_id.casefold()
               and p.suffix.casefold() in {".jpg", ".jpeg", ".png", ".webp"}]
    if len(matches) != 1:
        raise ValueError(f"{image_id}: cần đúng 1 ảnh gốc, tìm thấy {len(matches)}")
    return matches[0]


def _prediction(v7_image_dir: Path, destination: Path, expected_size: tuple[int, int]) -> None:
    main = np.asarray(Image.open(v7_image_dir / "main_flesh_instance_labels_uint16.png"))
    wart = np.asarray(Image.open(v7_image_dir / "wart_flesh_instance_labels_uint16.png"))
    if main.shape != wart.shape or main.shape[::-1] != expected_size:
        raise ValueError(f"{v7_image_dir.name}: kích thước mask không khớp ảnh")
    binary = np.where((main > 0) | (wart > 0), 255, 0).astype(np.uint8)
    Image.fromarray(binary, mode="L").save(destination, format="PNG", optimize=True)
    check = np.asarray(Image.open(destination))
    if check.dtype != np.uint8 or set(np.unique(check).tolist()) - {0, 255}:
        raise ValueError(f"{v7_image_dir.name}: prediction không phải PNG nhị phân uint8")


def _write_coordinate_image(source: Path, destination: Path, expected_size: tuple[int, int]) -> None:
    """V7 uses a centered crop of the prepared source image; preserve that pixel coordinate space."""
    with Image.open(source) as opened:
        width, height = opened.size
        target_width, target_height = expected_size
        if width < target_width or height < target_height:
            raise ValueError(f"{source.stem}: ảnh nguồn nhỏ hơn coordinate space V7")
        if (width, height) == expected_size:
            shutil.copy2(source, destination)
            return
        left = (width - target_width) // 2
        top = (height - target_height) // 2
        cropped = opened.crop((left, top, left + target_width, top + target_height))
        if destination.suffix.lower() in {".jpg", ".jpeg"}:
            cropped.save(destination, format="JPEG", quality=95, subsampling=0)
        else:
            cropped.save(destination)


def convert_dataset(v7_dir: Path, images_dir: Path, output_dir: Path, force: bool = False) -> Counts:
    v7_dir, images_dir, output_dir = v7_dir.resolve(), images_dir.resolve(), output_dir.resolve()
    if output_dir in {v7_dir, images_dir} or output_dir == v7_dir.parent or output_dir == images_dir.parent:
        raise ValueError("Output directory không được trùng với thư mục nguồn")
    if output_dir.exists() and any(output_dir.iterdir()) and not force:
        raise FileExistsError(f"{output_dir} đã có dữ liệu; dùng --force để thay bộ generated này")

    staging = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}-", dir=output_dir.parent))
    total = Counts()
    try:
        for name in ("images", "predictions", "prelabels"):
            (staging / name).mkdir(parents=True)
        items = []
        image_dirs = sorted((v7_dir / "images").iterdir(), key=lambda p: p.name.casefold())
        for image_dir in image_dirs:
            if not image_dir.is_dir():
                continue
            image_id = image_dir.name
            source = json.loads((image_dir / "prelabel_v7.json").read_text(encoding="utf-8"))
            prelabel, counts = convert_prelabel(source, image_id)
            original = _find_original(images_dir, image_id)
            width, height = prelabel["width"], prelabel["height"]
            image_name = f"{image_id}{original.suffix.lower()}"
            _write_coordinate_image(original, staging / "images" / image_name, (width, height))
            _prediction(image_dir, staging / "predictions" / f"{image_id}.png", (width, height))
            (staging / "prelabels" / f"{image_id}.json").write_text(
                json.dumps(prelabel, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
            )
            items.append({
                "id": image_id,
                "image": f"images/{image_name}",
                "prediction": f"predictions/{image_id}.png",
                "prelabel": f"prelabels/{image_id}.json",
                "width": width,
                "height": height,
            })
            for field in Counts.__dataclass_fields__:
                setattr(total, field, getattr(total, field) + getattr(counts, field))

        if not items:
            raise ValueError("Không tìm thấy image output V7 nào")
        manifest = {
            "dataset_version": "2026-08-20",
            "algorithm_version": "bitter-melon-v7",
            "items": items,
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if output_dir.exists():
            shutil.rmtree(output_dir)
        staging.replace(output_dir)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return total


def print_report(counts: Counts, ready: bool = True) -> None:
    print("V7 → WEB PRELABEL EXPORT")
    print("================================")
    print(f"Images                     : {counts.images}")
    print(f"Prediction masks           : {counts.images}")
    print(f"Prelabel JSON files        : {counts.images}")
    print(f"Main groups                : {counts.main_groups}")
    print(f"Main fragments             : {counts.main_fragments}")
    print(f"V7 main polygons           : {counts.v7_main_polygons}")
    print(f"Web main polygons          : {counts.web_main_polygons}")
    print(f"Wart instances             : {counts.wart_instances}")
    print(f"V7 wart polygons           : {counts.v7_wart_polygons}")
    print(f"Web wart polygons          : {counts.web_wart_polygons}")
    print("Invalid polygons           : 0")
    print("Out-of-bound nodes         : 0")
    print("Duplicate IDs              : 0")
    print("Missing images             : 0")
    print("Missing predictions        : 0")
    print("Missing prelabels          : 0")
    print("Dimension mismatches       : 0")
    print(f"STATUS: {'READY FOR WEB' if ready else 'FAILED'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--v7-dir", type=Path, default=Path("drive/SAM3_BitterMelon_V7"))
    parser.add_argument("--images-dir", type=Path, default=Path("drive/prelabel-dataset/images"))
    parser.add_argument("--output-dir", type=Path, default=Path("drive/prelabel-production"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    try:
        counts = convert_dataset(args.v7_dir, args.images_dir, args.output_dir, args.force)
    except Exception as error:
        print(f"STATUS: FAILED\nERROR: {error}")
        raise SystemExit(1) from error
    print_report(counts)


if __name__ == "__main__":
    main()
