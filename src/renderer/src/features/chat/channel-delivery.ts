/**
 * 通道投递的销账时机：IPC 接受之前不清 pending；失败先恢复队列 / 待讨论，再把错误交给原路径。
 * 普通合并投递与 QueueStrip「立即发送」共用这一道闸门，避免两条路各自忘记恢复。
 */
export async function deliverChannelSubmission(input: {
  submit: () => Promise<void>;
  onAccepted: () => void;
  onFailure: () => void;
}): Promise<void> {
  try {
    await input.submit();
  } catch (cause: unknown) {
    input.onFailure();
    throw cause;
  }
  input.onAccepted();
}
