/**
 * 应用图标的 1024px 母版：品牌衬线体排的小写 wordmark「orbita」，压在 macOS 图标网格的圆角卡上。
 *
 * 设计系统明确「Orbita 还没有定稿的 logo，需要标志的地方一律用品牌衬线体排名字」
 * （Orbita Design System/readme.md § No logo）——图标照同一条规矩办，不另造图形标。
 * logo 定稿后换掉本脚本的绘制部分即可，打包配置不用动。
 *
 * 颜色与字体都从设计系统真源现读，不在这里写 hex：
 *  - 卡面 --color-bg-panel、字色 --color-text-primary、描边 --color-border-default（light 档）
 *  - 字体 Literata 可变体，wght 取 500（与侧栏 wordmark 同重）
 *
 * 用法：swift render-wordmark.swift <仓库根> <输出 png>（由 scripts/make-icon.sh 调用）
 */
import AppKit
import CoreText

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("用法: swift render-wordmark.swift <仓库根> <输出 png>\n".data(using: .utf8)!)
  exit(2)
}
let root = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[2])
let ds = root.appendingPathComponent("Orbita Design System")

/// 取 colors.css 里某个 token 的**第一次**声明——第一块是 `:root`（light 档）
func token(_ name: String) -> NSColor {
  let css = try! String(contentsOf: ds.appendingPathComponent("tokens/colors.css"), encoding: .utf8)
  let pattern = "\(NSRegularExpression.escapedPattern(for: name)):\\s*#([0-9a-fA-F]{6});"
  let regex = try! NSRegularExpression(pattern: pattern)
  guard let match = regex.firstMatch(in: css, range: NSRange(css.startIndex..., in: css)),
    let range = Range(match.range(at: 1), in: css), let value = UInt32(css[range], radix: 16)
  else {
    FileHandle.standardError.write("colors.css 里找不到 \(name) 的 hex 声明\n".data(using: .utf8)!)
    exit(1)
  }
  return NSColor(
    srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
    blue: CGFloat(value & 0xff) / 255, alpha: 1)
}

let panel = token("--color-bg-panel")
let ink = token("--color-text-primary")
let hairline = token("--color-border-default")

// Literata 可变体，wght 轴（'wght' = 0x77676874）定到 500
let fontURL = ds.appendingPathComponent("assets/fonts/Literata-Variable.ttf") as CFURL
guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(fontURL) as? [CTFontDescriptor],
  let base = descriptors.first
else {
  FileHandle.standardError.write("读不出 Literata 字体\n".data(using: .utf8)!)
  exit(1)
}
let weighted = CTFontDescriptorCreateCopyWithAttributes(
  base, [kCTFontVariationAttribute: [0x7767_6874: 500]] as CFDictionary)

let size = 1024
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let cg = NSGraphicsContext.current!.cgContext

// macOS 图标网格：1024 画布里 824 的圆角卡，四周 100 留给系统投影
let card = NSRect(x: 100, y: 100, width: 824, height: 824)
let cardPath = NSBezierPath(roundedRect: card, xRadius: 185, yRadius: 185)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = ink.withAlphaComponent(0.28)
shadow.shadowBlurRadius = 24
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.set()
panel.setFill()
cardPath.fill()
NSGraphicsContext.restoreGraphicsState()
hairline.setStroke()
cardPath.lineWidth = 4
cardPath.stroke()

// 字号按字面宽度反推：wordmark 占卡宽约 70%
func line(_ pointSize: CGFloat) -> CTLine {
  let font = CTFontCreateWithFontDescriptor(weighted, pointSize, nil)
  let text = NSAttributedString(
    string: "orbita", attributes: [.font: font, .foregroundColor: ink, .kern: pointSize * 0.01])
  return CTLineCreateWithAttributedString(text)
}
let probe = CTLineGetImageBounds(line(100), cg)
let wordmark = line(100 * (card.width * 0.70) / probe.width)
// 按墨迹包围盒居中（不按基线）：小写字的升部让基线居中看起来偏低
let inkBounds = CTLineGetImageBounds(wordmark, cg)
cg.textPosition = CGPoint(
  x: card.midX - inkBounds.width / 2 - inkBounds.minX,
  y: card.midY - inkBounds.height / 2 - inkBounds.minY)
CTLineDraw(wordmark, cg)

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: output)
