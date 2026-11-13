/**
 * 星云卡片（neb-card-anchor）的落位纯函数：从云的 rect 与视口尺寸算出 fixed 锚点
 * 的 left / bottom / maxHeight / 尾巴 x。从 NebCardPortal 抽出来是为了可测——组件里
 * 只剩「什么时候重量」，几何全在这里。
 *
 * 卡片宽 min(360, 视口−16)：水平居中于云心、两端各留 8px 夹回视口；底边钉在云顶
 * 上方 8px，向上生长；maxHeight = 云顶到视口顶的余量再减 24（卡头留一点呼吸），
 * 内容区自己滚。
 */

/** 卡片落位：NebCardPortal 以它为 state，fixed 定位 + 尾巴位置全由这四个数决定 */
export interface NebCardSpot {
  /** 锚点左缘（px，相对视口） */
  left: number;
  /** 锚点底边距视口底的偏移（px）——钉在云顶上方 8px */
  bottom: number;
  /** 内容区最大高度（px） */
  maxHeight: number;
  /** 尾巴（云心相对卡左缘）的水平位置，夹在 [14, 卡宽−14]，免得贴边出卡 */
  tailX: number;
}

export function nebCardSpot(
  pet: { left: number; width: number; top: number },
  viewport: { width: number; height: number },
): NebCardSpot {
  const width = Math.min(360, viewport.width - 16);
  const center = pet.left + pet.width / 2;
  const left = Math.max(8, Math.min(Math.round(center - width / 2), viewport.width - width - 8));
  return {
    left,
    bottom: Math.max(8, viewport.height - pet.top + 8),
    maxHeight: Math.max(120, pet.top - 24),
    tailX: Math.max(14, Math.min(width - 14, Math.round(center - left))),
  };
}

/** 落位没变就不换对象——setSpot 靠它挡掉无意义的重渲染 */
export function sameNebCardSpot(a: NebCardSpot, b: NebCardSpot): boolean {
  return a.left === b.left && a.bottom === b.bottom && a.maxHeight === b.maxHeight && a.tailX === b.tailX;
}
