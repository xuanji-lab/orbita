#!/usr/bin/env python3
"""示例脚本骨架：只用标准库；输出路径相对脚本位置；先写临时文件再改名；失败大声报错。

用法：python3 scripts/example.py [--out data/panel.json]
把 __ 开头的占位和 TODO 换成真实逻辑。别留着这个文件当“示例技能”——不用的脚本删掉。
"""
import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # 插件根


def fetch_items():
    # TODO: 取真实数据。网络/接口失败就抛异常，不要返回编造的数据。
    raise RuntimeError("还没有实现 fetch_items()")


def write_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "data" / "panel.json"))
    args = parser.parse_args()
    try:
        items = fetch_items()
    except Exception as error:  # noqa: BLE001 — 对用户讲人话
        print(f"没取到数据：{error}", file=sys.stderr)
        return 1
    write_atomic(
        Path(args.out),
        {"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "sample": False, "items": items},
    )
    print(f"写入 {len(items)} 条 → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
