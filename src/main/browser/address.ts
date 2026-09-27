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
  const url = normalizeAddress(input);
  if (url !== null) return { url, search: null };
  const text = input.trim().replace(/\s+/g, " ");
  if (text === "" || BLOCKED_SCHEME.test(text)) return null;
  return { url: `${SEARCH_URL}${encodeURIComponent(text)}`, search: text };
}
