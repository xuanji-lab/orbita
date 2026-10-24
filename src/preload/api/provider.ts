/**
 * provider 域的 contextBridge 面 —— 四层契约的第 3 层。
 * 只依赖 electron 与 src/shared；不 import 主进程模块（分层守卫的红线）。
 * 注意 API 形状：明文密钥只有 renderer → main 这一个方向，回来的永远是 ProviderDto。
 */
import { ipcRenderer } from "electron";
import {
  ipcChannels,
  type BuiltinProvider,
  type OauthDeviceCode,
  type OauthLoginInput,
} from "../../shared/agent-ipc.ts";
import type { ProviderDto, ProviderUpsertInput, ValidationIssue } from "../../shared/provider.ts";

export type UpsertResult =
  | { ok: true; provider: ProviderDto }
  | { ok: false; issues: ValidationIssue[] };

export const providerApi = {
  /** pi 内建 provider 目录：选中名字即拿到官方 baseUrl / 协议 / 模型清单 */
  builtins: (): Promise<BuiltinProvider[]> => ipcRenderer.invoke(ipcChannels.providerBuiltins),
  list: (): Promise<ProviderDto[]> => ipcRenderer.invoke(ipcChannels.providerList),
  upsert: (input: ProviderUpsertInput): Promise<UpsertResult> =>
    ipcRenderer.invoke(ipcChannels.providerUpsert, input),
  remove: (id: string): Promise<void> => ipcRenderer.invoke(ipcChannels.providerRemove, id),
  /** 拖拽排序落盘：载荷是全量 id 的新顺序 */
  reorder: (ids: string[]): Promise<void> => ipcRenderer.invoke(ipcChannels.providerReorder, ids),
  /** 从供应商获取模型（仅 OpenAI 兼容的 /models；内建 provider 的清单来自 pi 目录，不走网络） */
  /** 测试连接：按协议发一个 1 token 的真请求 */
  test: (input: {
    api: string;
    baseUrl: string;
    modelId: string;
    apiKey?: string;
    providerId?: string;
    headers?: Record<string, string>;
  }): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(ipcChannels.providerTest, input),
  /** 显示明文密钥（用户点眼睛时才调，不随 list 下发） */
  reveal: (id: string): Promise<string | null> => ipcRenderer.invoke(ipcChannels.providerReveal, id),
  /**
   * 浏览器登录订阅（Claude / ChatGPT / GitHub Copilot / xAI）：主进程开系统浏览器并等授权，
   * 返回时 provider 已连凭据落盘。promise 会挂着等用户完成授权（上限 10–15 分钟）。
   */
  oauthLogin: (input: OauthLoginInput): Promise<UpsertResult> =>
    ipcRenderer.invoke(ipcChannels.providerOauthLogin, input),
  /** 取消进行中的登录（按 provider id）；oauthLogin 随即以「登录已取消」失败返回 */
  oauthCancel: (id: string): Promise<void> => ipcRenderer.invoke(ipcChannels.providerOauthCancel, id),
  /** 设备码到了（Copilot / xAI）：设置页把码显示出来。返回取消订阅 */
  onOauthDeviceCode: (listener: (code: OauthDeviceCode) => void): (() => void) => {
    const handler = (_e: unknown, code: OauthDeviceCode) => listener(code);
    ipcRenderer.on(ipcChannels.providerOauthDeviceCode, handler);
    return () => ipcRenderer.removeListener(ipcChannels.providerOauthDeviceCode, handler);
  },
  discover: (input: {
    baseUrl: string;
    api: string;
    apiKey?: string;
    providerId?: string;
    headers?: Record<string, string>;
  }): Promise<{ ok: boolean; models: string[]; message: string }> =>
    ipcRenderer.invoke(ipcChannels.providerDiscover, input),
};
