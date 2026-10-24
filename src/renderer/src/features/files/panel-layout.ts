import { pathTail, looksLikeWindowsPath } from "../../../../shared/path.ts";

/**
 * 文件面板「标签页 + 文件树开关」的**布局裁决纯函数**（HTML 原型
 * files-panel-prototype.html 的 applyLayout / openTab / closeTab 落地，交互模型
 * 用户已逐条裁决）。独立成模块的理由同 tree-view.ts / preview-view.ts：
 * FilesPanel.tsx 连着 React 与 IPC，`node --test` 进程里没法加载；这里全是
 * 输入 → 输出，直接可测。
 *
 * 边界纪律：这里只裁决**状态**（tabs / active / treeOn / data-* 属性），不裁决
 * 显示形态——树是并排窄列还是浮层，由 styles.css 的 container query 按容器宽度
 * 决定，JS 不量宽度做显示判定；JS 对宽度的唯一感知是 FilesPanel 里那只
 * ResizeObserver 在跨越断点时更新 treeOn（状态 ≠ 显示）。
 */

/**
 * 树列与浮层的分界（px）：容器 ≥ 此值且树开着 → 并排固定窄列；< 此值 → 浮层 +
 * 遮罩。与 styles.css 里 `.files-panel-layout` 的 `@container (min-width: 640px)`
 * 成对改，两边不一致浮层与折叠就会打架。
 *
 * 注意：这只决定树**开着时**的形态（并排 / 浮层），**不再管折叠**——折叠走
 * shouldCollapseOnNarrow（拉窄即折叠），因为它跨不过去（面板下界能高于 640）。
 */
export const TREE_BREAKPOINT = 640;

/**
 * 一个打开的文件标签。path 是绝对路径（附图标签则是原图引用，而者命名空间不同、
 * 不会撞），全面板唯一，就用它当标签的身份——同一张图重复点开自然复用同一个标签。
 */
export interface FileTab {
  /** 文件所在分组的根路径（api.files.read 的白名单参数）；附图标签不走 fs:read，传空串 */
  root: string;
  /** 文件绝对路径，或附图的原图引用 */
  path: string;
  /** 显示名缺省取 path 末段；附图标签传合成名（image-1.png——末段是 uuid，谁也认不出） */
  name?: string;
}

/**
 * 单击文件行：打开（或激活）一个标签。同一文件复用已有标签——不重复、不换位
 * （原型：标签按打开顺序排队）；返回新数组，不改传入值。name 只在新标签落队时
 * 记下（复用标签不改名，与「不换位」同一条纪律）。
 */
export function openTab(
  tabs: readonly FileTab[],
  root: string,
  path: string,
  name?: string,
): FileTab[] {
  if (tabs.some((tab) => tab.path === path)) return [...tabs];
  return [...tabs, name === undefined ? { root, path } : { root, path, name }];
}

export interface CloseTabResult {
  tabs: FileTab[];
  /** 关闭后的激活标签；全关完 = null，面板回到纯树 */
  activePath: string | null;
}

/**
 * 关闭一个标签。关的是当前激活标签时激活它的右邻（没有右邻给左邻，原型 closeTab
 * 同一语义）；关掉最后一个 = 没有激活文件。关的不是激活标签时激活不动。
 * targetPath 不在队列里（并发点了两下 ✕ 之类）按无事发生处理。
 */
export function closeTab(
  tabs: readonly FileTab[],
  activePath: string | null,
  targetPath: string,
): CloseTabResult {
  const index = tabs.findIndex((tab) => tab.path === targetPath);
  if (index === -1) return { tabs: [...tabs], activePath };
  const next = tabs.filter((tab) => tab.path !== targetPath);
  if (activePath !== targetPath) return { tabs: next, activePath };
  const neighbour = next[Math.min(index, next.length - 1)];
  return { tabs: next, activePath: neighbour === undefined ? null : neighbour.path };
}

/**
 * 丢掉「根已经不在了」的标签（专注 / 浏览态结束或换工作区）。
 *
 * 预览的 fs:read 只认会话根 + extraWorkspaceId（shared/files.ts）：专注一结束，
 * 之前那个额外根就从白名单里消失，留着的标签会重新读一次并变成常驻报错卡
 * （2026-10-22 发版前验收实测）。与「换会话 / 换工作区清标签」同一条纪律——
 * 旧的根在新形态里没有意义。
 *
 * 只丢 root 恰好是这一次失去的根的标签：同一工作区里的会话根、工作台根不受影响。
 * 丢的若是激活标签，激活它在原队列里右边的第一个幸存者，没有就退左边（同 closeTab
 * 的相邻语义）；全丢完 = 没有激活文件。
 */
export function dropTabsAtRoot(
  tabs: readonly FileTab[],
  activePath: string | null,
  root: string,
): CloseTabResult {
  const next = tabs.filter((tab) => tab.root !== root);
  if (next.length === tabs.length) return { tabs: [...tabs], activePath };
  if (activePath === null || next.some((tab) => tab.path === activePath)) {
    return { tabs: next, activePath };
  }
  const index = tabs.findIndex((tab) => tab.path === activePath);
  if (index === -1) return { tabs: next, activePath };
  for (let at = index + 1; at < tabs.length; at++) {
    const candidate = tabs[at];
    if (candidate !== undefined && candidate.root !== root) return { tabs: next, activePath: candidate.path };
  }
  for (let at = index - 1; at >= 0; at--) {
    const candidate = tabs[at];
    if (candidate !== undefined && candidate.root !== root) return { tabs: next, activePath: candidate.path };
  }
  return { tabs: next, activePath: null };
}

/**
 * 这一刻该收哪个工作区的标签：专注 / 浏览态的额外根「失去」或「这一轮专注到点」时
 * 返回它的 id，否则 null。FilesPanel 拿它去映射路径再交给 dropTabsAtRoot。
 *
 * 单独抽成纯函数是因为触发条件不在 id 上：专注自然到点（run → done）时左栏的专注
 * 视图与额外根都还在，focusWorkspaceId 一个字节也不变——只看 id 的 effect 不会跑，
 * 预览标签就留在了已经结束的那一轮里（2026-10-23 验收 files.scope.done 实测）。
 * 回来 null 表示「这一拍不动」：done → done 再渲染多少次也只收一次，effect 依赖
 * 里有 tabs 也不会反复收；再专注一轮（done → run）不误收。
 */
export function focusRootToDrop(
  previousWorkspaceId: string | null,
  nextWorkspaceId: string | null,
  previousDone: boolean,
  nextDone: boolean,
): string | null {
  // 之前就不在专注 / 浏览态：没有额外根可丢（打开面板时可能已经是 done，
  // 但那时候标签原本就是空的，由面板挂载清空负责）
  if (previousWorkspaceId === null) return null;
  // 换了工作区 / 退回会话列表：丢的是上一个根
  if (previousWorkspaceId !== nextWorkspaceId) return previousWorkspaceId;
  // 同一个工作区、这一拍刚走到 done：专注视图还在，但这一轮结束了
  if (!previousDone && nextDone) return nextWorkspaceId;
  return null;
}

/**
 * 白名单里的一条根（`fs:roots` 回执的最小形态）。kind 只为区分「会话自己的工作区」
 * 与「专注带进来的额外 workspace 根」——两者在回执里是同一个 kind。
 */
export interface RootFact {
  kind: string;
  path: string;
}

/**
 * 这一拍要不要收标签：`rootPath` 非 null = 收这个根的标签，并且这一拍就先别渲染
 * （两个动作必须同一拍、同一批标签，见 decideFocusDrop）。null = 不动，照常渲染。
 */
export interface FocusDropDecision {
  rootPath: string | null;
}

/** 不动：没有相位变化，或者失去的根仍在白名单里 */
const NO_DROP: FocusDropDecision = { rootPath: null };

/**
 * 专注 / 浏览态的相位变化 → 这一拍收哪个根的标签（#267 C8 / C9 的联合判决）。
 *
 * **收的口径**：只收「这一轮结束后真正失去白名单」的根。失去的根若仍被另一条幸存根
 * 占着（会话自己的根 / 会话的工作区 / 附加目录 / 附件副本），标签照旧读得动，不收——
 * 专注的工作区恰好也是会话附加目录就是这种（C8）。
 *
 * 判的是**路径相等**，不是包含：主进程的白名单是 `roots.some((root) => root.path ===
 * req.root)`（main/files/list.ts），失去的根即便落在某个幸存根**里面**，请求带的
 * root 也不在清单里、照样被拒——包含关系不能当作「还能读」。
 *
 * 返回路径而不是 id 还有第二个用处：**渲染期**先拿它把待收的标签挡在预览之外（C9）。
 * FilePreviewPane 的读取 effect 是子组件的，先于 FilesPanel 收标签的 effect 跑；不挡
 * 就会拿已经失效的目录再读一次，界面什么都没有、主进程日志多一条被拒绝的记录。
 * 挡与收用同一个判决、同一个路径，不存在「挡了没收」或「收了没挡」的分叉。
 */
export function decideFocusDrop(input: {
  previousWorkspaceId: string | null;
  nextWorkspaceId: string | null;
  previousDone: boolean;
  nextDone: boolean;
  /** 会话自己落脚的根（工作区 id）：它恰好是失去的那个时，那颗根不随专注消失 */
  sessionWorkspaceId: string | null;
  /** 工作区表：失去的根的路径按 id 从这里解（对不上 = 刚被删，按无事发生处理） */
  workspaces: readonly { id: string; path: string }[];
  /** 此刻的白名单（含还没消失的额外根，与不进树的 attachments 根） */
  roots: readonly RootFact[];
}): FocusDropDecision {
  const lost = focusRootToDrop(
    input.previousWorkspaceId,
    input.nextWorkspaceId,
    input.previousDone,
    input.nextDone,
  );
  if (lost === null) return NO_DROP;
  const lostRootPath = input.workspaces.find((workspace) => workspace.id === lost)?.path ?? null;
  if (lostRootPath === null) return NO_DROP;
  const survives = input.roots.some(
    (root) =>
      root.path === lostRootPath &&
      // 同路径的 workspace 根有两个来路：会话自己的（继续留在白名单）与专注带进来的
      // 额外根（随这一轮消失）。后者的 id 与会话的工作区不同，摘掉；前者不能摘。
      (root.kind !== "workspace" || lost === input.sessionWorkspaceId),
  );
  return survives ? NO_DROP : { rootPath: lostRootPath };
}

/**
 * 拉窄即折叠：树开着时面板被拉窄（任何幅度）→ 收起树。
 *
 * 为什么不用「跨 640px 断点」判：面板宽度的夹取下界是 pane 的 1/3
 * （clampRightPanelWidth），窗口越宽下界越高——2560 屏实测下界 693px >
 * 640px，断点永远跨不过去，规则等于死的（2026-10-10 用户实机指出：
 * 树展开后拉窄不折叠）。拉窄是用户「我要更多内容空间」的信号，与当前
 * 宽度在哪一档无关。1px 容差挡亚像素抖动。
 */
export function shouldCollapseOnNarrow(
  previousWidth: number | null,
  nextWidth: number,
): boolean {
  return previousWidth !== null && nextWidth < previousWidth - 1;
}

/** 面板主体元素的 data-* 属性——CSS 显示形态的唯一输入，见 styles.css 的 container query。 */
export interface PanelLayoutAttrs {
  "data-file": "open" | "none";
  "data-tree": "on" | "off";
}

/**
 * 显隐状态裁决。没打开任何文件时树就是整个面板（solo）：data-tree 恒 off——此刻
 * 标题开关禁用，treeOn 即便残留 true 也不许有显示效果；这是「无文件时开关禁用」
 * 的状态不变式，不靠组件记得清。
 */
export function panelLayoutAttrs(fileOpen: boolean, treeOn: boolean): PanelLayoutAttrs {
  return {
    "data-file": fileOpen ? "open" : "none",
    "data-tree": fileOpen && treeOn ? "on" : "off",
  };
}

/**
 * 标签显示名：路径末段（文件名）。path 恒非空——标签只由树里的真实条目构造；
 * 万一整条都是分隔符，回退还整条路径，不显示空标签。
 */
export function fileTabName(path: string): string {
  const last = pathTail(path);
  return last === "" ? path : last;
}

/**
 * 标签栏把激活标签滚进可视区要落到哪个 scrollLeft；null = 已完整可见，不动。
 * 标签左出界时贴左、右出界时贴右；标签比栏还宽时仍贴右——保 ✕ 可见（名字有
 * 省略号兑底，验证问题正是「新开的标签被截在右沿、连 ✕ 都看不到」）。
 * 纯函数，FilesPanel 量好 offsetLeft / offsetWidth / scrollLeft / clientWidth 再喂。
 */
export function tabScrollTarget(
  bar: { scrollLeft: number; clientWidth: number },
  tab: { offsetLeft: number; offsetWidth: number },
): number | null {
  const left = tab.offsetLeft;
  const right = left + tab.offsetWidth;
  if (left < bar.scrollLeft) return left;
  if (right > bar.scrollLeft + bar.clientWidth) return right - bar.clientWidth;
  return null;
}

/**
 * 预览面包屑的分段：按路径自己的形切（Windows 反斜杠 / POSIX 正斜杠，与
 * shared/path.ts 同一条规则），滤掉空段。末段（文件名）由渲染方加亮。
 */
export function crumbSegments(path: string): string[] {
  return (looksLikeWindowsPath(path) ? path.split(/[\\/]/) : path.split("/")).filter(
    (segment) => segment !== "",
  );
}

/**
 * 预览面包屑的分段，**从所在的根开始**（2026-10-11 验收：绝对路径从 /Users › …
 * 起头，放不下时截掉的偏偏是末尾的文件名）。第一段是根的显示名（workspace /
 * attached 的名字、session 的会话标题——原型同款），其后是根之内的相对段，
 * 末段（文件名）由渲染方加亮。path 不在 rootPath 之内（标签只从根内条目构造，
 * 不该发生）时退全路径分段，诚实兑底。
 */
export function crumbSegmentsFromRoot(rootPath: string, rootLabel: string, path: string): string[] {
  if (path !== rootPath) {
    for (const sep of ["/", "\\"] as const) {
      if (path.startsWith(rootPath + sep)) {
        const below = path.slice(rootPath.length + sep.length);
        return [rootLabel, ...below.split(/[\\/]/).filter((segment) => segment !== "")];
      }
    }
  }
  return crumbSegments(path);
}

/**
 * 分组折叠态的切换：session / workspace / attached 三组根的组头整行可点，折起 /
 * 展开该组。键用根的绝对路径（随会话 / 工作区切换整表重置）。返回新 Set，不改传入值。
 */
export function toggleGroupCollapsed(collapsed: ReadonlySet<string>, rootPath: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(rootPath)) next.delete(rootPath);
  else next.add(rootPath);
  return next;
}
