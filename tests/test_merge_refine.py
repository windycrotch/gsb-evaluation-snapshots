# Ultralytics 🚀 AGPL-3.0 License - https://ultralytics.com/license
"""Offline tests for the per-image merge + text-refinement audit record."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data_engine_agent import merge_and_refine_sample

SHAPE = [100, 100]  # height, width


def _xywhn(x1, y1, x2, y2):
    """Convert pixel xyxy to normalized xywh for a sample label."""
    h, w = SHAPE
    return [(x1 + x2) / 2 / w, (y1 + y2) / 2 / h, (x2 - x1) / w, (y2 - y1) / h]


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=4), encoding="utf-8")
    return path


def _sample_json(path, boxes, texts, im_file="photo.jpg", caption=None):
    """Write a grounding sample JSON with ``boxes`` as (text, x1, y1, x2, y2) tuples."""
    text_to_cls = {text: index for index, text in enumerate(texts)}
    return _write_json(
        path,
        {
            "im_file": im_file,
            "shape": SHAPE,
            "cls": [text_to_cls[text] for text, *_ in boxes],
            "bboxes": [_xywhn(*coords) for _, *coords in boxes],
            "segments": [],
            "texts": [[text] for text in texts],
            "normalized": True,
            "bbox_format": "xywh",
            "other_data": {"caption": caption},
        },
    )


def _predict_json(path, boxes):
    """Write a model prediction JSON with ``boxes`` as (text, x1, y1, x2, y2) tuples."""
    return _write_json(
        path,
        {
            "im_file": "photo.jpg",
            "instances": [
                {"bbox": list(coords), "text": [text], "conf": [0.9], "embed": None, "other_data": {}}
                for text, *coords in boxes
            ],
        },
    )


def _preference_similarity(preferred):
    """Build a similarity function that scores each box's preferred text highest.

    ``preferred`` maps rounded xyxy tuples to the text that should win for that box.
    """

    def similarity_fn(image_source, bboxes_xyxy, texts):
        matrix = np.zeros((len(bboxes_xyxy), len(texts)), dtype=np.float32)
        for row, bbox in enumerate(bboxes_xyxy):
            text = preferred[tuple(round(float(value), 3) for value in bbox)]
            matrix[row, texts.index(text)] = 1.0
        return matrix

    return similarity_fn


def test_normal_merge_appends_registers_and_refines(tmp_path):
    """Merge keeps non-overlapping predictions, registers new texts, and re-indexes after refinement."""
    sample = _sample_json(
        tmp_path / "a" / "photo.json",
        boxes=[("cat", 10, 10, 40, 40), ("dog", 50, 50, 80, 80), ("cat", 0, 0, 10, 10)],
        texts=["cat", "dog"],
    )
    predict = _predict_json(
        tmp_path / "predict",
        boxes=[("cat", 0, 0, 5, 5), ("cat", 12, 12, 42, 42), ("horse", 60, 0, 90, 30), ("dog", 51, 51, 81, 81)],
    )

    merged = tmp_path / "out" / "photo.json"
    record = merge_and_refine_sample(
        sample,
        predict,
        merged_json=merged,
        caption="A cat and a dog in the garden.",
        similarity_fn=_preference_similarity(
            {
                (10.0, 10.0, 40.0, 40.0): "cat",
                (50.0, 50.0, 80.0, 80.0): "dog",
                (0.0, 0.0, 10.0, 10.0): "cat",
                (0.0, 0.0, 5.0, 5.0): "cat",
                (60.0, 0.0, 90.0, 30.0): "horse",
            }
        ),
    )

    assert record["status"] == "merged"
    assert record["reason"] is None
    assert record["counts"] == {
        "existing_boxes": 3,
        "predictions": 4,
        "dropped": 2,
        "appended": 2,
        "instances_final": 5,
        "texts_before": 2,
        "texts_after_merge": 3,
        "texts_final": 3,
    }
    assert record["texts_before"] == ["cat", "dog"]
    assert record["texts_after_merge"] == ["cat", "dog", "horse"]
    assert record["texts_final"] == ["cat", "dog", "horse"]

    appended_boundary, dropped, appended_new, dropped_second = record["entries"]
    assert dropped["status"] == "dropped"
    assert dropped["reason"] == "overlap"
    assert dropped["matched_existing_index"] == 0
    assert dropped["max_iou"] > 0.5
    assert dropped["bbox_xyxy"] == [12.0, 12.0, 42.0, 42.0]

    assert appended_boundary["status"] == "appended"
    assert appended_boundary["reason"] == "new"
    assert appended_boundary["text_registered"] is False
    assert appended_boundary["cls_merged"] == 0
    assert appended_boundary["cls_final"] == 0
    assert appended_boundary["selected_text"] == "cat"

    assert appended_new["status"] == "appended"
    assert appended_new["text_registered"] is True
    assert appended_new["cls_merged"] == 2
    assert appended_new["cls_final"] == 2
    assert appended_new["selected_text"] == "horse"

    assert dropped_second["status"] == "dropped"
    assert dropped_second["matched_existing_index"] == 1

    assert record["rerank"]["performed"] is True
    assert record["rerank"]["candidates"] == [
        "cat",
        "dog",
        "horse",
        "A",
        "and",
        "a",
        "in",
        "the",
        "garden",
    ]
    assert [box["cls_final"] for box in record["rerank"]["boxes"]] == [0, 1, 0, 0, 2]

    merged_data = json.loads(merged.read_text(encoding="utf-8"))
    assert merged_data["texts"] == [["cat"], ["dog"], ["horse"]]
    assert merged_data["other_data"]["bbox_format"] == "xyxy"
    assert merged_data["other_data"]["normalized"] is False
    assert [instance["cls"] for instance in merged_data["instances"]] == [0, 1, 0, 0, 2]
    np.testing.assert_allclose(merged_data["instances"][3]["bbox"], [0, 0, 5, 5], atol=1e-4)
    assert merged_data["instances"][4]["text"] == ["horse"]

    record_file = json.loads((tmp_path / "out" / "photo.record.json").read_text(encoding="utf-8"))
    assert record_file["entries"] == record["entries"]


def test_iou_exactly_threshold_is_appended_not_dropped(tmp_path):
    """IoU exactly 0.5 is kept while a slightly larger overlap is dropped."""
    sample = _sample_json(tmp_path / "b" / "photo.json", [("cat", 0, 0, 10, 10)], ["cat"])
    predict = _predict_json(
        tmp_path / "predict",
        boxes=[("cat", 0, 0, 10, 5), ("cat", 0, 0, 10, 6)],
    )

    record = merge_and_refine_sample(
        sample,
        predict,
        merged_json=tmp_path / "out" / "photo.json",
        refine=False,
    )

    assert record["iou_threshold"] == 0.5
    boundary, overlapping = record["entries"]
    assert boundary["max_iou"] == pytest.approx(0.5)
    assert boundary["status"] == "appended"
    assert boundary["reason"] == "new"
    assert overlapping["max_iou"] == pytest.approx(0.6)
    assert overlapping["status"] == "dropped"
    assert overlapping["reason"] == "overlap"
    assert record["counts"]["appended"] == 1
    assert record["counts"]["dropped"] == 1
    assert record["rerank"]["performed"] is False
    assert record["rerank"]["reason"] == "refine_disabled"
    assert record["texts_final"] == ["cat"]


def test_missing_prediction_file_is_recorded_not_raised(tmp_path):
    """A missing prediction file yields a skip record with an explicit reason."""
    sample = _sample_json(tmp_path / "c" / "photo.json", [("cat", 10, 10, 40, 40)], ["cat"])
    missing = tmp_path / "predict" / "photo.json"
    assert not missing.exists()

    merged = tmp_path / "out" / "photo.json"
    record = merge_and_refine_sample(sample, missing, merged_json=merged)

    assert record["status"] == "skipped"
    assert record["reason"] == "missing_prediction_file"
    assert record["counts"]["appended"] == 0
    assert record["entries"] == []
    assert record["rerank"]["performed"] is False
    assert record["rerank"]["reason"] == "prediction_file_missing"
    assert any("not found" in note for note in record["notes"])

    merged_data = json.loads(merged.read_text(encoding="utf-8"))
    assert len(merged_data["instances"]) == 1
    assert merged_data["texts"] == [["cat"]]
    assert merged_data["instances"][0]["cls"] == 0


def test_empty_predictions_still_refines_existing_boxes(tmp_path):
    """An empty prediction file merges nothing, records why, and still refines texts."""
    sample = _sample_json(tmp_path / "d" / "photo.json", [("cat", 10, 10, 40, 40)], ["cat"])
    predict = _write_json(tmp_path / "predict" / "photo.json", {"im_file": "photo.jpg", "instances": []})

    record = merge_and_refine_sample(
        sample,
        predict,
        merged_json=tmp_path / "out" / "photo.json",
        caption="a dog runs",
        similarity_fn=_preference_similarity({(10.0, 10.0, 40.0, 40.0): "dog"}),
    )

    assert record["status"] == "merged"
    assert record["reason"] == "empty_predictions"
    assert record["counts"]["predictions"] == 0
    assert record["counts"]["appended"] == 0
    assert record["rerank"]["performed"] is True
    assert record["texts_final"] == ["dog"]
    assert record["rerank"]["boxes"] == [
        {
            "box_index": 0,
            "text_before": "cat",
            "selected_text": "dog",
            "similarity": pytest.approx(1.0),
            "cls_merged": 0,
            "cls_final": 0,
        }
    ]
    assert any("no instances" in note for note in record["notes"])


def test_empty_existing_boxes_appends_every_prediction(tmp_path):
    """With no existing boxes every valid prediction is appended and recorded as such."""
    sample = _sample_json(tmp_path / "e" / "photo.json", [], [])
    predict = _predict_json(tmp_path / "predict", [("cat", 10, 10, 40, 40), ("dog", 50, 50, 80, 80)])

    record = merge_and_refine_sample(
        sample,
        predict,
        merged_json=tmp_path / "out" / "photo.json",
        refine=False,
    )

    assert record["status"] == "merged"
    assert record["reason"] == "empty_existing_boxes"
    assert record["counts"]["existing_boxes"] == 0
    assert record["counts"]["appended"] == 2
    assert record["counts"]["dropped"] == 0
    assert [entry["status"] for entry in record["entries"]] == ["appended", "appended"]
    assert [entry["max_iou"] for entry in record["entries"]] == [0.0, 0.0]
    assert record["texts_after_merge"] == ["cat", "dog"]
    assert any("no existing boxes" in note for note in record["notes"])
