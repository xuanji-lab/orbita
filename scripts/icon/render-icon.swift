/**
 * 应用图标的 1024px 母版：把设计系统里的图标原稿（SVG，1024 满版、自带 rx 232 的圆角裁切）
 * 缩进 macOS 图标网格——1024 画布里 824 的圆角卡，四周 100 留给系统投影。
 *
 * SVG 由系统自带的 CoreSVG（NSImage）解析，不引入任何 npm 依赖；原稿只用到 path / rect /
 * circle、clip-path、描边虚线与透明度，CoreSVG 都支持（与浏览器渲染逐项对照过）。
 *
 * 用法：swift render-icon.swift <SVG 原稿> <输出 png>（由 scripts/make-icon.sh 调用）
 */
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("用法: swift render-icon.swift <SVG 原稿> <输出 png>\n".data(using: .utf8)!)
  exit(2)
}
guard let art = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write("读不出 SVG 原稿：\(args[1])\n".data(using: .utf8)!)
  exit(1)
}
let output = URL(fileURLWithPath: args[2])

let size = 1024
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// 卡的圆角跟着原稿的裁切等比缩（232 × 824/1024 ≈ 187，与 macOS 的 185 基本一致），投影才贴边
let card = NSRect(x: 100, y: 100, width: 824, height: 824)
let radius = 232 * card.width / 1024
let cardPath = NSBezierPath(roundedRect: card, xRadius: radius, yRadius: radius)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
shadow.shadowBlurRadius = 24
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.set()
NSColor.white.setFill()
cardPath.fill()
NSGraphicsContext.restoreGraphicsState()
art.draw(in: card, from: .zero, operation: .sourceOver, fraction: 1)

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: output)
