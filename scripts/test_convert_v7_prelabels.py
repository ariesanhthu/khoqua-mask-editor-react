import json
import tempfile
import unittest
from pathlib import Path

from convert_v7_prelabels import convert_dataset


ROOT = Path(__file__).resolve().parents[1]


class ConverterIntegrationTest(unittest.TestCase):
    def test_real_v7_sample_keeps_labels_ids_and_counts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "dataset"
            counts = convert_dataset(
                ROOT / "drive/SAM3_BitterMelon_V7",
                ROOT / "drive/prelabel-dataset/images",
                output,
            )
            self.assertEqual(counts.images, 11)
            self.assertEqual(counts.v7_main_polygons, counts.web_main_polygons)
            self.assertEqual(counts.v7_wart_polygons, counts.web_wart_polygons)
            payload = json.loads((output / "prelabels/8582_01.json").read_text(encoding="utf-8"))
            polygons = payload["maskOperations"][0]["polygons"]
            self.assertEqual({polygon["label"] for polygon in polygons}, {"main_flesh_band", "wart_flesh"})
            self.assertTrue(all(polygon["meta"]["source"] == "model" for polygon in polygons))
            self.assertTrue(all(node["id"].startswith(polygon["id"]) for polygon in polygons for node in polygon["nodes"]))


if __name__ == "__main__":
    unittest.main()
