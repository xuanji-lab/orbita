/**
 * 右栏底部应用入口（Archived / Carryovers）的点亮判定与点击落点。
 *
 * 单独成文件只为**可测**：`node --test` 只加载 `.ts`，这套判定写在 App.tsx 里就没法直接跑。
 *
 * 侧栏同一时刻只显示一块列表：设置（盖层）、Archived、Carryovers 或主列表，
 * 且设置的渲染优先级高于两个子视图（见 Sidebar.tsx 的分支顺序）。因此点击落点
 * 必须保证「打开子视图必退出设置」：此前入口只在底下翻转开关，设置页里点它
 * 界面纹丝不动（看起来就是没反应），底下已开的子视图还会被悄悄翻关——
 * 退出设置后落回主列表，而不是用户以为会回到的地方。
 */

/** 侧栏视图态：设置盖层开没开 + 两个子视图开没开（App 持有，本模块只做纯计算） */
export interface RailSubviewState {
  /** 与 Sidebar 的 `Overlay` 同构；不是 import 是为了让本模块零依赖、可直接加载 */
  overlay: "settings" | null;
  showArchived: boolean;
  showCarryovers: boolean;
}

/** 右栏底部哪个子视图入口被点 */
export type RailSubview = "archived" | "carryovers";

/** 入口亮不亮：它的子视图正占着侧栏。设置盖着或另一子视图开着时都不亮。 */
export function railSubviewLit(state: RailSubviewState, which: RailSubview): boolean {
  if (state.overlay !== null) return false;
  return which === "archived"
    ? state.showArchived && !state.showCarryovers
    : state.showCarryovers && !state.showArchived;
}

/**
 * 点一下入口后的落点：没亮 = 打开它（必退出设置）；亮着 = 收起回主列表。
 * 打开总是把另一个子视图一并收掉——两块子视图互斥，切换就是先收再开。
 */
export function toggleRailSubview(state: RailSubviewState, which: RailSubview): RailSubviewState {
  if (railSubviewLit(state, which)) {
    return { overlay: null, showArchived: false, showCarryovers: false };
  }
  return {
    overlay: null,
    showArchived: which === "archived",
    showCarryovers: which === "carryovers",
  };
}
