import { useEffect, useState } from "react";

/**
 * 量出滚动容器**现在**最高能撑到多少 px（分段预览的行数上限由它算，见 range-view.ts 的
 * `maxBrowsableLines`）。
 *
 * 为什么要现量而不是写常数：Chromium 的布局单位是 1/64 物理像素的 31 位整数，滚动高度的上限
 * 因此是**物理像素**——CSS 像素的上限 = 33.5M ÷（显示器缩放 × 页面缩放）。同一台 Mac（Retina，
 * 缩放 2）上页面缩放 0.5 / 1 / 2 实测是 33.5M / 16.7M / 8.4M（Electron 43，隐藏窗口）；
 * Windows 100% / 125% / 150% / 200% 按同一公式是 33.5M / 26.8M / 22.4M / 16.7M（**未实测**）。
 * 原先写死 33.5M，在 Mac 上放行到 180 万行，后一半滚不到，提示条还说「已打开末尾」。
 *
 * 量法：屏幕外放一个可滚动的盒子，里面塞一个 10 亿 px 高的子元素，读一次 `scrollHeight`——
 * 浏览器把它钳在上限上。只触发一次强制布局，盒子是固定尺寸 + `contain: strict`，布局不外溢。
 *
 * 什么时候重量：页面缩放（Cmd + = / Cmd + -）与换到另一块缩放不同的显示器，都会改变
 * `devicePixelRatio`——监听它（`matchMedia` 的 resolution 查询，一次性，触发后换成新值重挂），
 * 再用 `resize` 兜一道（有的环境缩放只触发 resize）。
 */

/** 探针子元素的高度：远大于任何已知平台的上限，只为让浏览器把 scrollHeight 钳到上限 */
const PROBE_HEIGHT_PX = 1_000_000_000;

/**
 * 探针失败（没有 body、盒子被隐藏读出 0）时的保守值：比 Mac 上页面缩放 2 的实测值（8.4M）还小，
 * 宁可少放行几行也不让用户滚不到底。
 */
const FALLBACK_SCROLL_LIMIT_PX = 8_000_000;

/** 量一次。纯 DOM 操作，同步返回；量不出就给保守值 */
function probeScrollHeightLimit(): number {
  const body = document.body;
  if (body === null) return FALLBACK_SCROLL_LIMIT_PX;
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText =
    "position:fixed;left:-10000px;top:0;width:16px;height:16px;overflow:scroll;visibility:hidden;pointer-events:none;contain:strict;";
  const tall = document.createElement("div");
  tall.style.height = `${PROBE_HEIGHT_PX}px`;
  box.appendChild(tall);
  body.appendChild(box);
  try {
    const measured = box.scrollHeight;
    return Number.isFinite(measured) && measured > 0 ? measured : FALLBACK_SCROLL_LIMIT_PX;
  } finally {
    box.remove();
  }
}

/** 当前可用的滚动高度上限（px）；缩放 / 换屏后自动重量，返回的值随之更新 */
export function useScrollHeightLimit(): number {
  const [limit, setLimit] = useState(probeScrollHeightLimit);

  useEffect(() => {
    let dpr = window.devicePixelRatio;
    let media: MediaQueryList | null = null;
    let disposed = false;

    const remeasure = (): void => {
      if (disposed) return;
      dpr = window.devicePixelRatio;
      const next = probeScrollHeightLimit();
      setLimit((prev) => (prev === next ? prev : next));
    };
    // 一个 resolution 查询只在「离开当前 dpr」时触发一次，所以触发后要按新值重挂
    const watch = (): void => {
      media?.removeEventListener("change", onMediaChange);
      media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", onMediaChange, { once: true });
    };
    function onMediaChange(): void {
      remeasure();
      watch();
    }
    const onResize = (): void => {
      if (window.devicePixelRatio !== dpr) {
        remeasure();
        watch();
      }
    };

    // 挂载时 state 初值已经量过一次；这里再量一次兜住「初值是在缩放生效之前量的」
    remeasure();
    watch();
    window.addEventListener("resize", onResize);
    return () => {
      disposed = true;
      media?.removeEventListener("change", onMediaChange);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return limit;
}
