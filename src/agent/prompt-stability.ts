/**
 * 系统提示词稳定性指纹：每轮对分段与工具名单算短哈希，同一会话里发生变化时
 * 由 runtime 打 `[prompt-stability]` 日志。用于归因前缀缓存为何失效；进程重启后
 * 第一轮只重新立基线，不伪报一次变化。纯模块，可由 node --test 直接加载。
 */
import { createHash } from "node:crypto";

export const TOOLS_FINGERPRINT_KEY = "tools";

export function promptFingerprints(
  segments: readonly { name: string; text: string }[],
  toolNames: readonly string[],
): Record<string, string> {
  const prints: Record<string, string> = {};
  for (const segment of segments) {
    prints[segment.name] = createHash("sha256").update(segment.text, "utf8").digest("hex").slice(0, 16);
  }
  // 工具注册顺序没有语义；内容相同但顺序抖动不该误报。
  prints[TOOLS_FINGERPRINT_KEY] = createHash("sha256")
    .update([...toolNames].sort().join("\n"), "utf8")
    .digest("hex")
    .slice(0, 16);
  return prints;
}

/** 空数组 = 所有段与工具名单逐字节相同；消失的段以 -name 报告。 */
export function diffFingerprints(
  prev: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): string[] {
  const changed: string[] = [];
  for (const [name, hash] of Object.entries(next)) {
    if (prev[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(prev)) {
    if (!(name in next)) changed.push(`-${name}`);
  }
  return changed;
}

export function stabilityLogLine(sessionId: string, changed: readonly string[]): string {
  return `session=${sessionId} 前缀变化: ${changed.join(", ")}`;
}
