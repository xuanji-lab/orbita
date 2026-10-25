/**
 * 工作区写操作的「写完广播」外壳。
 *
 * 列表是全局事实：侧栏、技能分组、任务表单读的都是同一份 `workspace:list`，而写入
 * 可以来自任一窗口（面板里的新建、探针的 IPC 调用、将来的导入）。写的人不负责通知
 * 就等于没写——从别的入口建的工作区要整页重载才出现（2026-10-24 探针实测）。
 *
 * 纯模块（不 import electron），可被 `node --test` 直接加载。
 */

/** 跑完 `run` 之后再广播；`run` 抛错就不广播——列表没变，广播只会让所有窗口白读一次盘。 */
export async function afterWorkspaceMutation<T>(
  run: () => Promise<T>,
  onChanged: () => void,
): Promise<T> {
  const result = await run();
  onChanged();
  return result;
}
