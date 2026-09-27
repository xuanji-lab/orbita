/**
 * 地址栏输入 → 可加载的 URL。不是网址回 null（第一刀不做搜索回退，由工具条如实提示）。
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
