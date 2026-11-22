/**
 * 右栏底部「已归档」入口的点亮判定与点击落点。
 *
 * 单独成文件只为**可测**：`node --test` 只加载 `.ts`，这套判定写在 App.tsx 里就没法直接跑。
 *
 * 侧栏同一时刻只显示一块列表：设置（盖层）、Archived 或主列表，
 * 且设置的渲染优先级高于子视图（见 Sidebar.tsx 的分支顺序）。因此点击落点
 * 必须保证「打开子视图必退出设置」：此前入口只在底下翻转开关，设置页里点它
 * 界面纹丝不动（看起来就是没反应）——退出设置后落回主列表，而不是用户以为会回到的地方。
 * （曾经还有「遗留事项」子视图，2026-11-22 随该功能删除，Archived 现在是唯一的子视图。）
 */

/** 侧栏视图态：设置盖层开没开 + 已归档子视图开没开（App 持有，本模块只做纯计算） */
export interface RailSubviewState {
  /** 与 Sidebar 的 `Overlay` 同构；不是 import 是为了让本模块零依赖、可直接加载 */
  overlay: "settings" | "board" | null;
  showArchived: boolean;
}

/** 入口亮不亮：已归档正占着侧栏。设置盖着时不亮。 */
export function archivedEntryLit(state: RailSubviewState): boolean {
  return state.overlay === null && state.showArchived;
}

/** 点一下入口后的落点：没亮 = 打开已归档（必退出设置）；亮着 = 收起回主列表。 */
export function toggleArchivedEntry(state: RailSubviewState): RailSubviewState {
  return archivedEntryLit(state)
    ? { overlay: null, showArchived: false }
    : { overlay: null, showArchived: true };
}
