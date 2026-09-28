import type { Messages } from "../../messages-en.ts";

/**
 * 没选模型时的发送报错文案（纯函数，`model-required.test.ts` 锚定两种状态的取舍）：
 * - 一个可用服务商都没有 → 引导去配 provider（原文案）；
 * - 有服务商但没选模型 → 「先选一个模型」。打开导入的会话（占位 provider）或
 *   provider 被删的旧会话都落在后者——渠道选择不替用户做（同导入不映射模型的裁决）。
 */
export function modelRequiredText(hasProviders: boolean, t: Messages): string {
  return hasProviders ? t.session.pickModelFirst : t.session.noProvider;
}
