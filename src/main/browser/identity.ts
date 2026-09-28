/**
 * 受管浏览器的 User-Agent：去掉 `Electron/x` 与应用名 token，只剩 Chromium 本色。
 *
 * 不改的话，一部分登录页（典型是 Google 账号，机构 SSO 的上游常会经过它）按 UA
 * 识别出「嵌入式浏览器」并拒绝登录——而交接登录正是受管浏览器存在的理由之一。
 * 渲染引擎本来就是同版本 Chromium，去掉这两个 token 不是冒充别的浏览器。
 *
 * 幂等：已经改写过的 UA 再过一遍不变。
 */
export function browserUserAgent(userAgent: string, appName: string): string {
  const app = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return userAgent
    .replace(new RegExp(`\\s(?:Electron|${app})\\/\\S+`, "gi"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
