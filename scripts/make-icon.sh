#!/usr/bin/env bash
# 生成 macOS 应用图标 build/icon.icns（electron-builder 默认从 build/ 取）。
# 原稿是设计系统的 assets/app-icon.svg（稿纸：绿格上一枚红圈印「璇玑」）；母版由
# scripts/icon/render-icon.swift 缩进 macOS 图标网格绘出，再用系统自带的 sips 缩出 iconset
# 各档、iconutil 合成 icns——不引入任何 npm 依赖。
# 只在 macOS 上跑；产物入库，打包本身不依赖 Swift 工具链。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

master="$work/master.png"
swift "$root/scripts/icon/render-icon.swift" "$root/Orbita Design System/assets/app-icon.svg" "$master"

iconset="$work/icon.iconset"
mkdir -p "$iconset"
for px in 16 32 128 256 512; do
  sips -z "$px" "$px" "$master" --out "$iconset/icon_${px}x${px}.png" >/dev/null
  sips -z "$((px * 2))" "$((px * 2))" "$master" --out "$iconset/icon_${px}x${px}@2x.png" >/dev/null
done

mkdir -p "$root/build"
iconutil -c icns "$iconset" -o "$root/build/icon.icns"
echo "已生成 $root/build/icon.icns"
