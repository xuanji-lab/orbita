/**
 * 地址栏输入 → 可加载的 URL。`normalizeAddress` 只认网址；`resolveAddressOrSearch` 在它之上
 * 把「不是网址」交给搜索引擎（用户不知道图书馆入口在哪时，先得搜得到）。
 *
 * 只放行 http / https（外加 about:blank）：`file:` 会把用户磁盘交给网页上下文，
 * `javascript:` / `data:` 是注入入口，`chrome:` 之类在受管浏览器里没有意义。
 *
 * 省略协议时：本机与 IP 地址补 `http://`（内网设备、本地开发服务器大多没有证书），
 * 其余域名补 `https://`。
 */
import { looksLikeLocalPath } from "./local-file.ts";

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** `localhost:3000`、`scopus.com:443/x` 形如「协议:」，其实是「主机:端口」 */
const HOST_WITH_PORT = /^[^:/?#]+:\d/;
const LOCAL_HOST = /^(?:localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/;
/** 至少一个点、顶级域至少两个字符：`scopus.com`、`www-scopus-com.ezproxy.xxx.edu` */
const DOMAIN_HOST = /^[^/?#\s]+\.[a-z0-9-]{2,}(?::\d+)?(?:[/?#]|$)/i;

export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (text === "" || /\s/.test(text)) return null;
  if (text.toLowerCase() === "about:blank") return "about:blank";

  if (HAS_SCHEME.test(text) && !HOST_WITH_PORT.test(text)) {
    const url = parse(text);
    return url !== null && (url.protocol === "http:" || url.protocol === "https:") ? url.href : null;
  }

  const plain = LOCAL_HOST.test(text) || IPV4_HOST.test(text);
  if (!plain && !DOMAIN_HOST.test(text)) return null;
  return parse(`${plain ? "http" : "https"}://${text}`)?.href ?? null;
}

/**
 * 界面里点到的外链（聊天里的链接、设置页的文档链接）是不是网页：是就进内置浏览器，
 * 否则（mailto 之类内置浏览器接不了的）交给系统（index.ts 的 openLink）。
 */
export function isWebLink(url: string): boolean {
  const parsed = parse(url.trim());
  return parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:");
}

/**
 * `shell.openExternal` 的系统交接闸：非网页协议里**只放行 mailto**——应用里实际用到的
 * 就只有它（Markdown 链接的过滤白名单同样只认 http(s)+mailto，见 MarkdownBlock 的
 * ExternalAnchor）。file: / javascript: / 自定义 scheme 一律不交：openExternal 对未知
 * 协议各平台行为不一，Windows 上历史攻击面（ms-msdt: 一类）都集中在这里。
 */
export function isSystemHandoffLink(url: string): boolean {
  const parsed = parse(url.trim());
  return parsed !== null && parsed.protocol === "mailto:";
}

function parse(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** 搜索引擎。Google：用户最熟，结果对学术入口（图书馆代理、数据库）也最准 */
const SEARCH_URL = "https://www.google.com/search?q=";

/** 形如某个具体协议的输入：明确不放行，而不是拿去搜索——模型与用户都该知道「这个不行」 */
const BLOCKED_SCHEME = /^(?:file|javascript|data|chrome|chrome-extension|about|blob|vbscript|view-source|devtools):/i;

/**
 * 地址栏 / browser_navigate 的输入 → 要加载的地址。网址照 normalizeAddress；不是网址的文字
 * 拿去搜索（search 带回原词，好让结果里说清「搜了什么」）；空输入与被禁的协议回 null。
 */
export function resolveAddressOrSearch(input: string): { url: string; search: string | null } | null {
  const text = input.trim().replace(/\s+/g, " ");
  // 本地路径先判，不能漏给 normalizeAddress：UNC（\\server\share\…）会被域名规则误认，
  // 拼出 https://server/share/… 这种假网址（Windows 实测）；漏到搜索则整条外泄给搜索引擎。
  // 地址栏不收本地路径：本地网页只走两条专用通道——agent 在自己的 tab 里打开（local-file.ts
  // 按会话目录判），文件面板在你的 tab 里打开（fs:open-in-browser 按文件面板白名单判）
  if (text !== "" && looksLikeLocalPath(text)) return null;
  const url = normalizeAddress(input);
  if (url !== null) return { url, search: null };
  if (text === "" || BLOCKED_SCHEME.test(text)) return null;
  return { url: `${SEARCH_URL}${encodeURIComponent(text)}`, search: text };
}
