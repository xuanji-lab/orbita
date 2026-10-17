/**
 * 受管浏览器的 User-Agent：Chromium 原样 UA，去掉 `Electron/x` 与应用名 token，末尾追加
 * `Orbita/<版本>`——诚实报出「这是一个基于 Chromium 的浏览器，叫 Orbita」。
 *
 * 为什么是诚实而不是伪装成 Chrome（2026-10-15）：
 * 以前这里把应用名也去掉，让 UA 看上去是纯 Chrome，想借此躲过 Google 登录对嵌入式浏览器的
 * 拦截。结果反了：`session.setUserAgent()` 一覆写，Chromium 就停发 Sec-CH-UA 头，
 * `navigator.userAgentData` 里也没有 "Google Chrome" 品牌——UA 自称纯 Chrome，却拿不出
 * Chrome 的证据，Google 风控判它在说谎，提交凭据后跳 /v3/signin/rejected。
 * Proma 用的就是「Chromium UA + 自家 token」这一形状，实测能登 Google（用户本人验证）。
 *
 * 被否的方案：补齐 Sec-CH-UA 头 + preload 往页面塞 "Google Chrome" 品牌（PR 229 初版）。
 * 它能过指纹检测，但要关掉网页的 contextIsolation（Electron 内部代码与网页同一个 JS 世界），
 * 且伪装对所有网站生效、跟着 Google 风控的变化无止境地补；诚实身份没有这些代价。
 *
 * `Electron/x` 仍然去掉：它是「嵌入式 webview」的直接信号，部分登录页按它拒绝。
 * 幂等：已经改写过的 UA 再过一遍不变。
 */
export function browserUserAgent(userAgent: string, appName: string, appVersion: string): string {
  const app = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = userAgent
    .replace(new RegExp(`\\s(?:Electron|Orbita|${app})\\/\\S+`, "gi"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return `${base} Orbita/${appVersion}`;
}
