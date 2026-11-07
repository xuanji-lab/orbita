/**
 * 页脚「标题 · 页码」：由主题统一画，不落进元素数组（页序一变页码就跟着变，用户拖页不会留下错号）。
 * 画布 / 缩略图 / 播放 / 导出共用这一个函数给出的文字元素，所以各处位置、字号、颜色一致。
 * 只有带色板的新主题文稿才画（老文稿没有主题，保持原样）；页上 `footer: "none"` 则不画，`"right"` 画在右下。
 */
import { CANVAS_SIZE, DEFAULT_BACKGROUND, plainToRichHtml, type Deck, type Slide, type TextElement } from "./slides.ts";
import { contrastRatio, luminance, mixColors, resolveTheme } from "./slides-theme.ts";
import { visualLength } from "./slides-measure.ts";

export const FOOTER_ID = "__footer";

export function footerElement(deck: Pick<Deck, "aspect" | "theme" | "title">, slide: Slide, index: number): TextElement | null {
  if (deck.theme?.palette === undefined || slide.footer === "none") return null;
  const rt = resolveTheme(deck.theme);
  if (!rt.footer) return null;
  const { w: W, h: H } = CANVAS_SIZE[deck.aspect];
  const mx = W >= 1200 ? 96 : 72;
  const bg = slide.background ?? deck.theme.background ?? DEFAULT_BACKGROUND;
  // 在这一页的底色上读得清：先试 muted，再试 ink，都不行就黑 / 白
  const candidates = [rt.colors.muted, rt.colors.ink];
  const readable = candidates.find((color) => contrastRatio(color, bg) >= 3);
  const color = readable ?? (luminance(bg) < 0.5 ? mixColors("#ffffff", bg, 0.85) : mixColors("#000000", bg, 0.85));
  let title = deck.title.trim();
  while (visualLength(title) > 26 && title.length > 1) title = title.slice(0, -1);
  const label = title === "" ? String(index + 1) : `${title}  ·  ${index + 1}`;
  const right = slide.footer === "right";
  const width = Math.round(W * 0.5);
  return {
    id: FOOTER_ID,
    kind: "text",
    x: right ? W - mx - width : mx,
    y: H - 62,
    w: width,
    h: 30,
    html: plainToRichHtml(label),
    fontSize: rt.scale.caption,
    color,
    align: right ? "right" : "left",
    valign: "middle",
    letterSpacing: 1,
  };
}
