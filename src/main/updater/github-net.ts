/**
 * GitHub 出口的 Electron 接线 —— 与下载器同一个 session、同一份代理（`node --test` 不加载本文件）。
 *
 * **为什么必须用这个 session**：下载（`resilient-executor.ts`）与 electron-updater 的
 * `downloadToBuffer`（blockmap）都走分区 `electron-updater`（`NET_SESSION_NAME`）；
 * 元数据请求若另走全局 fetch，就绕开了这份 session，`HTTPS_PROXY` 对列表与检查更新不生效
 * ——那正是返工前「历史版本列表另用一套网络不走代理」的问题。
 *
 * **代理**：库与 Chromium 的 `net` 都跟随系统代理，但系统代理没开、机器只能靠显式代理
 * 访问 GitHub 时，更新与列表都会直连失败（issue #283）。启动时把 `HTTPS_PROXY` /
 * `HTTP_PROXY` 应用到该 session（规则见 proxy.ts）；没配就保持默认。
 *
 * 重定向交给 Chromium 跟随：资产端点先 302 到 `release-assets.githubusercontent.com`
 * 的签名地址，元数据读取只需要最终字节。
 */
import { net, session, type Session } from "electron";
import { NET_SESSION_NAME } from "electron-updater/out/electronHttpExecutor.js";
import type { GitHubRequest, GitHubResponse, GitHubTransport } from "./github-client.ts";
import { hasProxySetting, proxyRulesOf, type ProxyEnv } from "./proxy.ts";

/** 元数据 / 小文件的整体上限：断网或挂着不走时不能把设置页的展开体永远转下去 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 与下载器同一个分区（代理、证书策略都挂在它身上） */
function githubSession(): Session {
  return session.fromPartition(NET_SESSION_NAME, { cache: false });
}

export function electronGitHubTransport(): GitHubTransport {
  return async (request: GitHubRequest): Promise<GitHubResponse> => {
    return await new Promise<GitHubResponse>((resolve, reject) => {
      const url = request.url;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (error: Error | null, response?: GitHubResponse): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (error !== null) reject(error);
        else if (response !== undefined) resolve(response);
      };

      const client = net.request({
        url: url.href,
        method: "GET",
        session: githubSession(),
        redirect: "follow",
        headers: request.headers,
      });
      timer = setTimeout(() => {
        // 消息里保留 ETIMEDOUT：failure.ts 按这个特征把超时归到「网络」
        settle(new Error(`GitHub 请求超时（ETIMEDOUT）：${url.href}`));
        client.abort();
      }, REQUEST_TIMEOUT_MS);

      client.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          settle(null, {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", (error: Error) => settle(error));
      });
      client.on("error", (error: Error) => settle(error));
      client.end();
    });
  };
}

/**
 * 把 `HTTPS_PROXY` / `HTTP_PROXY` 应用到 GitHub 出口（下载与元数据共用这个 session）。
 * 没配就什么都不做；配了却用不上（带账号密码 / 协议不认识）要出声——静默直连会让用户
 * 以为代理已经生效。代理值本身不写日志（可能带内网地址）。
 */
export async function applyEnvProxy(env: ProxyEnv = process.env): Promise<void> {
  const rules = proxyRulesOf(env);
  if (rules === null) {
    if (hasProxySetting(env)) {
      console.warn(
        "[更新] HTTPS_PROXY / HTTP_PROXY 的值不能当更新出口（无法解析、协议不认识，或带账号密码），GitHub 请求继续直连",
      );
    }
    return;
  }
  try {
    await githubSession().setProxy({ proxyRules: rules });
    console.info("[更新] GitHub 出口（检查更新 + 历史版本）已按 HTTPS_PROXY / HTTP_PROXY 设置代理");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[更新] HTTPS_PROXY / HTTP_PROXY 没能应用到 GitHub 出口，继续直连：", message);
  }
}
