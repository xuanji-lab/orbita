/**
 * 登录状态导入的网站清单：「全选 / 全不选」只作用于**当前显示的**网站（搜索过滤之后的那些）。
 *
 * 这样「搜 nus → 全选」只勾中匹配的几个；没显示出来的网站原样不动——既不会被悄悄勾上，
 * 也不会把之前勾好的清掉。默认仍是一个都不勾：全选是用户显式的一步。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载。
 */

/** 显示中的网站是否都已勾上（没有显示任何网站时为 false：按钮这时不出现） */
export function allShownTicked(shown: readonly string[], ticked: ReadonlySet<string>): boolean {
  return shown.length > 0 && shown.every((site) => ticked.has(site));
}

/** 把显示中的网站一起勾上（on）或一起取消；不显示的网站保持原状 */
export function setShown(ticked: ReadonlySet<string>, shown: readonly string[], on: boolean): Set<string> {
  const next = new Set(ticked);
  for (const site of shown) {
    if (on) next.add(site);
    else next.delete(site);
  }
  return next;
}
