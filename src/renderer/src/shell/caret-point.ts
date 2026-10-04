/**
 * textarea 里某个位置的**插入点坐标**（镜像层量法）。
 *
 * 斜杠面板要「左缘对齐 `/` 字符的横坐标、顶缘在 `/` 所在行下方」，textarea 没有
 * 原生 API 给字符坐标，Range 也进不去 textarea——标准做法是垫一个同样排版的
 * 镜像 div：同样的字体 / 字距 / 行高 / padding / 宽度，灌入光标前的文本，在末尾
 * 放一个零宽标记，量标记的位置。whiteout 的镜像（小学作业主题）同一家族，但那个
 * 常驻渲染且只服务纸面主题，这里按需建、量完即弃。
 *
 * 返回坐标**相对 textarea 的 border box**（镜像同排版，镜像内偏移即 textarea 内偏移；
 * 等价地：border box + 复制来的 padding 就是内容首行）。滚动已补偿（textarea 内部
 * 滚了多少，视觉位置就上移多少）——调用方加上 textarea 自身在卡里的偏移就是卡内坐标。
 */

/** 插入点的位置与该行的行高（都相对 textarea 的 border box、已补偿滚动） */
export interface CaretPoint {
  left: number;
  top: number;
  height: number;
}

const COPIED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontFeatureSettings",
  "letterSpacing",
  "lineHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "boxSizing",
  "textIndent",
  "tabSize",
  "textTransform",
] as const;

export function caretPoint(textarea: HTMLTextAreaElement, index: number): CaretPoint | null {
  const value = textarea.value;
  if (index < 0 || index > value.length) return null;
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const property of COPIED_STYLES) {
    // computed 的值是活的字符串，直接照抄
    mirror.style[property] = computed[property];
  }
  // 换行与折行都照 textarea 的规矩：pre-wrap + 长词断行
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.wordBreak = computed.wordBreak;
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = "auto";
  mirror.style.overflow = "hidden";
  mirror.textContent = value.slice(0, index);
  const marker = document.createElement("span");
  // 零宽字符：文本以 \n 结尾时 div 不出最后一个行盒，标记垫出那一行
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  // 量的基准是镜像自己的 border box，不是 textarea：镜像挂在 body 顶上（absolute
  // 0,0），marker 的 viewport 坐标带着「文档原点到镜像」的那一段；减 mirrorRect 才是
  // 「标记在镜像里第几行」。旧版减 areaRect，textarea 不在视口顶时面板会整段高估
  // ——首页输入卡在窗口中部，量出的 top 是 -355px，面板飘到 slogan 上方
  // （CDP 实测：markerTop=4 / mirrorTop=0 / taTop=395，旧公式 -391，正算 4）。
  // 镜像与 textarea 同排版（同 padding / border / 字体），镜像内偏移 == textarea 内偏移
  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const areaRect = textarea.getBoundingClientRect();
  mirror.remove();
  const lineHeight = Number.parseFloat(computed.lineHeight);
  return {
    left: markerRect.left - mirrorRect.left + textarea.scrollLeft,
    top: markerRect.top - mirrorRect.top + textarea.scrollTop,
    height: Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : markerRect.height,
  };
}
