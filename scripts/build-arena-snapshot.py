#!/usr/bin/env python3
"""生成「价格 · 能力图」的分数快照：src/main/usage/arena-snapshot.json。

数据只取 Arena 官方 Hugging Face 数据集 lmarena-ai/leaderboard-dataset（CC-BY-4.0，
可随应用分发，须署名并注明改动）。arena.ai 网页上的每任务成本、单价、Agent 其余三类
分数受 Arena Terms of Use 约束（禁止复制、分发、抓取），一个数字都不能进这份快照。

快照只做「选子集 + 选列 + 取两位小数」，不做型号映射：榜单名 → Orbita 型号 id × 思考档
的映射在 src/main/usage/arena-board.ts（有测试），白名单加了别名不用重跑本脚本。

用法（需要 pyarrow：python3 -m venv .venv && .venv/bin/pip install pyarrow）：
  .venv/bin/python scripts/build-arena-snapshot.py                 # 拉 HF 当前 revision
  .venv/bin/python scripts/build-arena-snapshot.py --revision <sha> # 钉一个 revision
  .venv/bin/python scripts/build-arena-snapshot.py --raw-dir <dir>  # 用已下载的 parquet
    （<dir> 里放 hf-<subset>-latest.parquet，revision 仍需 --revision 写明）
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pyarrow.parquet as pq

DATASET = "lmarena-ai/leaderboard-dataset"
DATASET_URL = f"https://huggingface.co/datasets/{DATASET}"
OUT = Path(__file__).resolve().parent.parent / "src" / "main" / "usage" / "arena-snapshot.json"

# 六类：Agent 综合（agent 子集只有 overall 一类）+ Text 四类（网页默认开 style control，
# 对应 text_style_control 子集，不是 text）+ WebDev（webdev 子集的 webdev 类）。
# unit：agent 是 net improvement（IPS 因果效应，小数；0 = 平均水平），其余是 Bradley-Terry 分。
CATEGORIES = [
    ("agent", "agent", "overall", "net-improvement"),
    ("overall", "text_style_control", "overall", "rating"),
    ("coding", "text_style_control", "coding", "rating"),
    ("webdev", "webdev", "webdev", "rating"),
    ("math", "text_style_control", "math", "rating"),
    ("instruction_following", "text_style_control", "instruction_following", "rating"),
]


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def current_revision() -> str:
    return json.loads(fetch(f"https://huggingface.co/api/datasets/{DATASET}"))["sha"]


def load_subset(subset: str, revision: str, raw_dir: Path | None):
    if raw_dir is not None:
        return pq.read_table(raw_dir / f"hf-{subset}-latest.parquet").to_pylist()
    url = f"{DATASET_URL}/resolve/{revision}/{subset}/latest-00000-of-00001.parquet"
    return pq.read_table(io.BytesIO(fetch(url))).to_pylist()


def row_of(record: dict, unit: str) -> list:
    """[榜单名, 分数, 置信下界, 置信上界, 样本量, 名次]。agent 的分数是小数，保留 4 位。"""
    if unit == "net-improvement":
        return [record["model_name"], round(record["score"], 4), round(record["score_ci_lower"], 4),
                round(record["score_ci_upper"], 4), int(record["session_count"]), int(record["rank"])]
    return [record["model_name"], round(record["rating"], 2), round(record["rating_lower"], 2),
            round(record["rating_upper"], 2), int(record["vote_count"]), int(record["rank"])]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision")
    parser.add_argument("--raw-dir", type=Path)
    args = parser.parse_args()
    if args.raw_dir is not None and args.revision is None:
        sys.exit("--raw-dir 必须同时给 --revision：快照要写明数据来自哪个 revision")
    revision = args.revision or current_revision()

    subsets: dict[str, list] = {}
    categories = {}
    for key, subset, category, unit in CATEGORIES:
        if subset not in subsets:
            subsets[subset] = load_subset(subset, revision, args.raw_dir)
        rows = [r for r in subsets[subset] if r["category"] == category]
        if not rows:
            sys.exit(f"{subset}/{category} 没有数据：数据集结构变了，先核对再生成")
        rows.sort(key=lambda r: r["rank"])
        dates = sorted({r["leaderboard_publish_date"] for r in rows})
        categories[key] = {
            "subset": subset,
            "category": category,
            "unit": unit,
            "publishDate": dates[-1],
            "rows": [row_of(r, unit) for r in rows],
        }

    snapshot = {
        "dataset": DATASET,
        "url": DATASET_URL,
        "revision": revision,
        "license": "CC-BY-4.0",
        "attribution": f"Scores: Arena (arena.ai), {DATASET}, CC BY 4.0. "
                       "Modified by Orbita: selected subsets and columns, rounded.",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "categories": categories,
    }
    OUT.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(OUT, {k: len(v["rows"]) for k, v in categories.items()}, f"{OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
