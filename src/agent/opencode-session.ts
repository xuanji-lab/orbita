/**
 * OpenCode Go 的会话头注入 —— 纯模块，可被 `node --test` 直接测。
 *
 * 为什么要有这一层：OpenCode 官方要求「每个会话一个稳定的会话 id」（`x-opencode-session`），
 * 用于路由与前缀缓存。pi 内核本来就发对了（provider-attribution 的 `getSessionHeaders`，
 * 值为 pi 的 sessionId），但合并顺序是「配置头最后覆盖」——`known-providers.ts` 里那条
 * 静态占位头会把 pi 的正确值盖成同一个常量。所以真实会话在开轮 / 换模型装配前，
 * 用本模块把占位值换成当前会话 id。
 *
 * 判定与 pi 同源：只看 `baseUrl` 的 hostname 是不是 `opencode.ai`（解析失败按「不是」）。
 * **官方 DeepSeek 不走这里**（hostname 是 api.deepseek.com），请求行为一字不变。
 */

/** 与 pi 的 provider-attribution 同一个 host 判定 */
const OPENCODE_HOST = "opencode.ai";

/**
 * 配置里的值是占位（探活用），真实会话 id 在开轮 / 换模型时注入。
 * 返回**新对象**：不改调用方手里那份 provider（配置是共用的，原地写会串会话）。
 * 未命中返回原引用——调用方可以靠引用相等判断「没动过」。
 */
export function withOpencodeSession<T extends { baseUrl: string; headers?: Record<string, string> }>(
  provider: T,
  sessionId: string,
): T {
  if (!isOpencodeProvider(provider.baseUrl)) return provider;
  const headers = { ...provider.headers, "x-opencode-session": sessionId };
  return { ...provider, headers };
}

/** 只认 OpenCode 的 host；非法 URL 不抛，按「不是」处理 */
function isOpencodeProvider(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}
