/**
 * 更新出口的代理规则 —— 纯函数，`node --test` 直接测（不引 electron）。
 *
 * electron-updater 用自己的 Electron session（分区名 `electron-updater`，见
 * electron-updater/out/electronHttpExecutor.js），默认跟随系统代理；系统代理没开、
 * 而机器又只能靠代理访问 GitHub 时，更新就会直连失败（issue #283）。这里给一条显式的
 * 环境变量出口：启动应用时带上 `HTTPS_PROXY`（或 `HTTP_PROXY`）即可，不必改代码。
 *
 * **优先级**：HTTPS_PROXY / https_proxy → HTTP_PROXY / http_proxy。`ALL_PROXY` 不认：
 * 它常是 socks，误当 HTTP 代理配上去只会得到更难查的失败。
 *
 * Chromium 的 `proxyRules` 不吃 URL 里的账号密码（认证走 session 的 login 事件，更新器
 * 没有自动填密码这一步），所以带凭据的值直接返回 null——宁可继续直连，也不静默用一个
 * 认证不过的代理。
 */
export type ProxyEnv = Readonly<Record<string, string | undefined>>;

const KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

/**
 * 环境里终究给了代理值吗——即使它因为带凭据 / 协议不认识被上面丢掉了。
 * service 用它区分「没配」与「配了但用不上」：后者静默直连会让用户以为代理生效了。
 */
export function hasProxySetting(env: ProxyEnv): boolean {
  return KEYS.some((key) => (env[key]?.trim() ?? "") !== "");
}

/** 
 * 环境变量 → Chromium `proxyRules`；没配 / 配了不认识的协议 / 带凭据时返回 null。
 *
 * 输出形如 `http=127.0.0.1:7897;https=127.0.0.1:7897`（http 代理同时接管 http 与 https），
 * socks 形如 `socks=127.0.0.1:7897`。不带 scheme 的值按 http 处理（多数客户端的写法）。
 */
export function proxyRulesOf(env: ProxyEnv): string | null {
  const raw = KEYS.map((key) => env[key]?.trim()).find((value) => value !== undefined && value !== "");
  if (raw === undefined) return null;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (url.hostname === "" || url.username !== "" || url.password !== "") return null;

  const host = `${url.hostname}${url.port === "" ? "" : `:${url.port}`}`;
  // socks 规则只认 URL 形态（`socks5=host:port` 会被 Chromium 当成未知 scheme、静默走直连；
  // 2026-10-23 在本机 Electron 43 上用 resolveProxy 实测）
  if (url.protocol === "socks5:") return `socks5://${host}`;
  if (url.protocol === "socks4:") return `socks4://${host}`;
  if (url.protocol === "socks:") return `socks://${host}`;
  if (url.protocol === "http:" || url.protocol === "https:") {
    return `http=${host};https=${host}`;
  }
  return null;
}
