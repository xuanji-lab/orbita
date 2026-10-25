/**
 * 更新失败的原因分类 —— 纯函数，`node --test` 直接测（不引 electron）。
 *
 * 界面只画一句人话 + 机器原文进 title（见 renderer 的 UpdateCard）；人话按这里的分类出，
 * 因为用户能做的事不同：网络问题要查网络 / 代理，404 与限流只能等，5xx 不是本机的错。
 *
 * 分类只认 `error.code` / `error.statusCode` 与消息里的几个稳定特征：
 * - electron-updater / builder-util-runtime 的 HttpError 带 `statusCode` 与 `code: "HTTP_ERROR_<status>"`；
 * - Electron net 的断网 / DNS 失败是 `net::ERR_*` 或 Node 的 `ENOTFOUND` / `ETIMEDOUT` 一类；
 * - 自己抛的「更新源缺文件」带 `ERR_UPDATER_*` 码（见 github-api-provider.ts）。
 *
 * 认不出来就是 `unknown`：宁可少说一句，也不要把超时误说成「发布没传全」。
 */
import type { UpdateFailureKind } from "../../shared/updater.ts";

/** Node / Electron 里明确的网络失败码（错误码大小写敏感，统一按原样比） */
const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
]);

/** 消息兜底：Electron net 的 `net::ERR_*` 不一定带 code，DNS / 超时的原文也各平台不一 */
const NETWORK_MESSAGE =
  /net::ERR_|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|socket hang up|timed? ?out|getaddrinfo/i;

/** 更新源「没有这一份东西」的码：404、channel 文件缺失、latest.yml 没列文件 */
const NOT_FOUND_CODES = new Set([
  "HTTP_ERROR_404",
  "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  "ERR_UPDATER_ASSET_NOT_FOUND",
  "ERR_UPDATER_NO_FILES_PROVIDED",
]);

interface ErrorFacts {
  code: string | null;
  status: number | null;
  message: string;
}

function factsOf(error: unknown): ErrorFacts {
  if (!(error instanceof Error)) return { code: null, status: null, message: String(error) };
  const record = error as Error & { code?: unknown; statusCode?: unknown };
  return {
    code: typeof record.code === "string" ? record.code : null,
    status: typeof record.statusCode === "number" ? record.statusCode : null,
    message: error.message,
  };
}

export function failureKindOf(error: unknown): UpdateFailureKind {
  const { code, status, message } = factsOf(error);

  if (
    status === 404 ||
    (code !== null && NOT_FOUND_CODES.has(code)) ||
    (/HTTP_ERROR_404|status 404/.test(message))
  ) {
    return "not-found";
  }

  if (status === 429 || code === "HTTP_ERROR_429" || /api rate limit|rate limit exceeded/i.test(message)) {
    return "rate-limit";
  }
  if (status === 403 || code === "HTTP_ERROR_403") {
    // GitHub 的未认证限流也报 403（消息里带 rate limit），没有这个特征就是权限问题，
    // 归到 server 也说不通——留给 unknown，界面只说「稍后重试」。
    return /rate limit/i.test(message) ? "rate-limit" : "unknown";
  }

  if ((status !== null && status >= 500) || (code !== null && /^HTTP_ERROR_5\d\d$/.test(code))) return "server";

  // 下载完 sha512 对不上：更新源 / 中间链路给的字节不是 GitHub 记录的那一份。
  // 不是本机的网络问题，归到 server；界面说“稍后再试”，原始信息仍在 title。
  if (code === "ERR_UPDATER_INVALID_CHECKSUM") return "server";

  if (code !== null && NETWORK_CODES.has(code)) return "network";
  if (NETWORK_MESSAGE.test(message)) return "network";

  return "unknown";
}
