import { release as osRelease } from "node:os";

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

/** client hints 里的操作系统身份；由 hostClientHintsPlatform() 从本机读出 */
export interface ClientHintsHost {
  platform: "Windows" | "macOS" | "Linux";
  platformVersion: string;
  arch: "x86" | "arm";
}

/**
 * 本机的 client hints 操作系统身份。
 *
 * Platform-Version 不是真实系统版本，Chrome 出于防指纹会折算：
 * Windows 按 build 分段（≥26100 → 19，实测校准），macOS 用 Darwin X.Y.Z ↔ (X-9).Y.Z。
 */
export function hostClientHintsHost(
  nodePlatform: NodeJS.Platform = process.platform,
  osVersion: string = osRelease(),
  nodeArch: string = process.arch,
): ClientHintsHost {
  const arch = nodeArch === "arm64" ? "arm" : "x86";
  if (nodePlatform === "win32") {
    const build = Number(osVersion.split(".")[2] ?? "0");
    // 实测校准（26200 → Chromium 自报 19.0.0）：中间档按 Chrome 的版本表对齐
    const major = build >= 26100 ? 19 : build >= 22621 ? 15 : build >= 22000 ? 13 : 10;
    return { platform: "Windows", platformVersion: `${major}.0.0`, arch };
  }
  if (nodePlatform === "darwin") {
    // Darwin X.Y.Z ↔ macOS (X-9).Y.Z（24.6.0 ↔ 15.6.0），minor/patch 直接对齐
    const parts = osVersion.split(".").map(Number);
    const darwinMajor = parts[0] ?? 0;
    return {
      platform: "macOS",
      platformVersion: `${Math.max(darwinMajor - 9, 0)}.${parts[1] ?? 0}.${parts[2] ?? 0}`,
      arch,
    };
  }
  return { platform: "Linux", platformVersion: "", arch };
}

/**
 * 受管浏览器要补发的 `Sec-CH-UA-*` 请求头。
 *
 * 为什么需要：`session.setUserAgent()` 覆写 UA 后，Chromium 干脆停发整个 client hints
 * 系列（HTTP 头一个都没有），而 `navigator.userAgentData` 里也没有 "Google Chrome"
 * 品牌——UA 字符串自称 Chrome/150，两侧证据却对不上，Google 登录的风控就吃这一套
 * （实测：提交凭据后跳 /v3/signin/rejected「此浏览器或应用可能不安全」）。
 * 这里按真 Chrome 的样子把 HTTP 侧补齐；JS 侧由 preload/browser-page.ts 补
 * （Electron 的 setUserAgent 不收 userAgentMetadata，只能分两侧手动对齐）。
 *
 * 注意：这一步跨过了 identity.ts 上方「不冒充别的浏览器」的线—— brands 里的
 * "Google Chrome" 是伪装。渲染引擎虽是真 Chromium，但品牌不是。仅限受管浏览器
 * partition，且是为了让用户本人的账号能登录，不做他用。
 *
 * 返回值键是规范大小写；调用方只在页面没自带同名头（大小写不敏感）时才填。
 */
export function browserClientHints(userAgent: string, host: ClientHintsHost): Record<string, string> {
  const fullVersion = userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "";
  const major = fullVersion.split(".")[0] ?? "";
  // 与本机 Chromium 自产的 GREASE 品牌保持一致（实测该版本就是 "Not;A=Brand";v="8"）
  const hints: Record<string, string> = {
    "Sec-CH-UA": `"Not;A=Brand";v="8", "Chromium";v="${major}", "Google Chrome";v="${major}"`,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"${host.platform}"`,
    "Sec-CH-UA-Arch": `"${host.arch}"`,
    "Sec-CH-UA-Bitness": `"64"`,
    "Sec-CH-UA-Model": `""`,
    "Sec-CH-UA-Platform-Version": `"${host.platformVersion}"`,
    "Sec-CH-UA-Form-Factors": `"Desktop"`,
    "Sec-CH-UA-Full-Version-List": `"Not;A=Brand";v="8.0.0.0", "Chromium";v="${fullVersion}", "Google Chrome";v="${fullVersion}"`,
  };
  if (host.platform === "Windows") hints["Sec-CH-UA-WoW64"] = "?0";
  return hints;
}
