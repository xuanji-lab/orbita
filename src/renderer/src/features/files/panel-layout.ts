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
