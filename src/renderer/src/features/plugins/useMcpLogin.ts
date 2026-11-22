/**
 * 「已装」里给需要登录的远程 MCP 发起浏览器登录（同连接目录的同一套流程）。
 * 一次只登录一台；登录中的那一台按钮变「取消」。没成的原因（取消除外）交给调用方显示。
 */
import { useCallback, useState } from "react";
import type { McpOauthLoginResult } from "@shared/mcp-oauth";
import { api } from "../../api";

export interface McpLogin {
  /** 正在登录的 server 名；没有为 null */
  busy: string | null;
  /** 开始登录，等到结束（成功 / 取消 / 失败）才 resolve；结束后先重读列表 */
  start: (serverName: string) => Promise<void>;
  cancel: (serverName: string) => void;
}

export function useMcpLogin(
  /** 登录结束后要做的（重读列表）；成功与否都调，列表状态以重读为准 */
  onFinished: () => Promise<void> | void,
  /** 没成的一句话（取消不算）；null = 不提示 */
  onFailure: (message: string) => void,
  /** 失败结果 → 一句本地化的话；取消返回 null */
  describe: (failure: Exclude<McpOauthLoginResult, { ok: true }>) => string | null,
): McpLogin {
  const [busy, setBusy] = useState<string | null>(null);
  const start = useCallback(
    async (serverName: string): Promise<void> => {
      setBusy(serverName);
      try {
        const result = await api.connector.oauthLogin({ serverName });
        if (!result.ok) {
          const text = describe(result);
          if (text !== null) onFailure(text);
        }
      } catch (cause) {
        onFailure(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
        await onFinished();
      }
    },
    [onFinished, onFailure, describe],
  );
  const cancel = useCallback((serverName: string): void => {
    void api.connector.oauthCancel(serverName);
  }, []);
  return { busy, start, cancel };
}
