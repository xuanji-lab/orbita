/**
 * React 19 对 `dangerouslySetInnerHTML` 按**对象身份**判断要不要重写
 * `innerHTML`（react-dom `updateProperties`：`nextProp !== lastProp` 才
 * `setProp`，`setProp` 才真的 `domElement.innerHTML = __html`）——不是按
 * `__html` 字符串是否相等判断。`Icon.tsx` 原来每次渲染都 `{ __html: ... }`
 * 字面量新建一个对象，字符串完全相同也会被判定「变了」，于是每次重渲染整棵
 * SVG 都被拆掉重建。流式时 App 的每个增量都会触发侧栏 / 右图标条重渲染：
 * 用户点在图标上（`pointerdown` 落在 svg/path 节点），松手前那个节点已经被
 * 摘掉重建，浏览器收不到 `click`（`pointerdown` 到、`pointerup` 到、没有
 * `click`）——这是流式期间按钮点击丢失的根因。
 *
 * 按 key 缓存同一个 `{ __html }` 对象：只要 key 不变，两次调用拿到的是同一个
 * 引用，React 的身份比较不再触发。缓存是模块级单例——调用方（Icon.tsx）的
 * key 是图标名，图标集固定（ICONS 表），不会无限增长。
 */
const cache = new Map<string, { __html: string }>();

export function iconMarkup(key: string, buildHtml: () => string): { __html: string } {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const next = { __html: buildHtml() };
  cache.set(key, next);
  return next;
}
