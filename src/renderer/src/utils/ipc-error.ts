/**
 * IPC 错误上屏前的整理：剥掉 Electron 的「Error invoking remote method 'x': Error:」
 * 包装（对用户是纯噪音）。需要按界面语言翻译的稳定错误码属于各自的功能面
 * （如外部来源页自定义目录的 IMPORT_CUSTOM_ROOT_INVALID），不走这里。
 * 消费者：聊天会话（useChatSession）与模型服务的浏览器登录（ProvidersView）。
 */
export function ipcErrorText(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
