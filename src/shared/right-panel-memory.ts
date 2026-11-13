/**
 * 右栏按会话记忆的落盘 —— IPC 四层契约的第 1 层（2026-11-07 起）。
 *
 * 用户 2026-11-07：「离开一个 session 它的右侧面板留下的是什么？……我插件面板记住了，
 * 但我明明从插件面板里进了某个插件，他就不记住了。这个树节点要往下探呀。」
 * 之前只在 renderer 内存里记「每条会话离开时开着哪个面板（种类）」；现在记到面板里的
 * 第二层（进了哪个插件 / 哪条自动化 / 哪个页签……），并且重启后保留。
 *
 * 文件：`<userData>/right-panel-memory.json`，原子写。**只存路径数据，不存任何内容**
 * （没有文件内容、没有对话文本）。条目按「最近用过」从旧到新排，超过
 * RIGHT_PANEL_MEMORY_MAX_ENTRIES 条时 renderer 淘汰最旧的。
 *
 * main 只认信封（`version` + 条数 + 体积），**不解读每条的内容**：条目形状（panel / sub）
 * 属于各面板，由 renderer 的 `shell/right-panel-memory.ts` 在读回时逐条校验，对不上的
 * 字段丢掉——读回来的数据不可信（文件可能被手改、可能是旧版本写的）。
 *
 *   right-panel-memory:load   启动时读一次；文件不在 / 坏了回 null（= 从空记忆起步）
 *   right-panel-memory:save   renderer 防抖后整份写回（原子）
 */

export const rightPanelMemoryChannels = {
  load: "right-panel-memory:load",
  save: "right-panel-memory:save",
} as const;

/** 最多记多少条会话（最近用过的优先）：防无限增长 */
export const RIGHT_PANEL_MEMORY_MAX_ENTRIES = 500;

/** 整份文件体积的硬顶（序列化后的字符数）：500 条 × 每条几百字节远低于它，超了说明不是我们写的 */
export const RIGHT_PANEL_MEMORY_MAX_CHARS = 1_000_000;

/** 落盘信封。entries 每项是 renderer 写的一条记忆（形状见 renderer 侧），这里不解读 */
export interface RightPanelMemoryFile {
  version: 1;
  entries: readonly unknown[];
}

/** 信封校验（main 读盘 / 收 save 时用）：版本对、entries 是数组且不超上限。通过则原样返回 */
export function parseRightPanelMemoryFile(raw: unknown): RightPanelMemoryFile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries)) return null;
  // 超上限：只留最新的（数组末尾），不是整份作废
  const entries = record.entries.length > RIGHT_PANEL_MEMORY_MAX_ENTRIES
    ? record.entries.slice(record.entries.length - RIGHT_PANEL_MEMORY_MAX_ENTRIES)
    : record.entries;
  return { version: 1, entries };
}
