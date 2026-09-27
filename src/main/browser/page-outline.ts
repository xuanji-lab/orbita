/**
 * CDP 无障碍树 → 给模型看的缩进大纲（browser_observe）。纯函数，按行预算截断。
 *
 * 取舍：
 * - **只印有意义的节点**：地标（导航 / 主体 / 表单…）、标题、链接、按钮、表单控件、带名字的图片、
 *   对话框。纯排版容器（generic / group / 无名 section）不印，也不加缩进——它们只会把大纲撑深。
 * - **不印正文**（StaticText）：读文字走 browser_extract，大纲只讲结构，控制 token。
 * - 被忽略（ignored）的节点自己不印，子节点照常下钻——很多真实控件挂在 ignored 包装之下。
 * - **可交互的节点带元素引用**（`[ref=e12]`），browser_click / browser_type 拿它定位。引用背后是 CDP 的
 *   backendDOMNodeId——同一个文档里稳定，布局变了也指得准；只在换文档（跨文档导航）时作废。
 *   同一个节点在多次 observe 之间保持同一个编号（ElementRefs 的反查表），模型手里的旧引用不会被新的一次
 *   observe 悉悉改指别的元素。读「你的」tab 时不发引用：agent 不操作它。
 */

/** CDP `Accessibility.getFullAXTree` 返回节点里我们用到的字段 */
export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  childIds?: string[];
  parentId?: string;
  /** 对应的 DOM 节点；元素引用就是它的别名 */
  backendDOMNodeId?: number;
}

/**
 * 一个文档里发出去的元素引用：`e1`、`e2`…… ↔ backendDOMNodeId。挂在 tab 上，跨文档导航时整张换掉。
 */
export interface ElementRefs {
  byRef: Map<string, number>;
  byNode: Map<number, string>;
  next: number;
}

export function emptyElementRefs(): ElementRefs {
  return { byRef: new Map(), byNode: new Map(), next: 1 };
}

/** 这个节点的引用；发过就复用，没发过就取下一个号 */
export function refForNode(refs: ElementRefs, backendNodeId: number): string {
  const existing = refs.byNode.get(backendNodeId);
  if (existing !== undefined) return existing;
  const ref = `e${refs.next}`;
  refs.next += 1;
  refs.byRef.set(ref, backendNodeId);
  refs.byNode.set(backendNodeId, ref);
  return ref;
}

/** 地标与容器：印出来，并让子节点缩进一层 */
const CONTAINER_ROLES = new Set([
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "region",
  "dialog",
  "alertdialog",
  "list",
  "listbox",
  "menu",
  "menubar",
  "tablist",
  "tree",
  "table",
  "grid",
]);

/** 叶子式的有意义节点：印一行，子节点通常只是它名字的来源，不再下钻 */
const LEAF_ROLES = new Set([
  "heading",
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "image",
  "img",
  "alert",
  "status",
]);

/** 能点、能输、能选的角色：印出来时带元素引用。标题、图片、提示只是看的，不发引用（省 token） */
const INTERACTIVE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
]);

/** 列表 / 表格容器没有名字时印出来只是噪音：只作缩进锚，本身不占一行 */
const SILENT_WHEN_UNNAMED = new Set(["list", "table", "grid", "region", "form", "listbox", "menu", "tree", "tablist"]);

const NAME_MAX = 120;
const VALUE_MAX = 80;

/**
 * @param refs 传了就给可交互节点发引用（agent 自己的 tab）；不传就只印结构（「你的」tab，只读）。
 * 只给真正印出来的行发——行预算外的节点模型看不到，发了也没人用。
 */
export function formatAxOutline(
  nodes: readonly AxNode[],
  maxLines: number,
  refs?: ElementRefs,
): { text: string; lines: number; omitted: number } {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => node.parentId === undefined) ?? nodes[0];
  const lines: string[] = [];
  let omitted = 0;

  const visit = (node: AxNode, depth: number): void => {
    const role = str(node.role?.value);
    const name = clip(str(node.name?.value), NAME_MAX);
    const printable = node.ignored !== true && (LEAF_ROLES.has(role) || CONTAINER_ROLES.has(role));
    // 没名字的图片与无名链接/按钮（纯图标）也印——结构上它们在那里；图片无名则跳过
    const skipUnnamed = (role === "image" || role === "img") && name === "";
    const silent = SILENT_WHEN_UNNAMED.has(role) && name === "";
    let childDepth = depth;
    if (printable && !skipUnnamed) {
      if (!silent) {
        if (lines.length < maxLines) {
          const ref = refs !== undefined ? refLabel(node, role, refs) : "";
          lines.push(`${"  ".repeat(depth)}- ${describe(node, role, name)}${ref}`);
        } else omitted += 1;
      }
      if (LEAF_ROLES.has(role)) return;
      childDepth = depth + 1;
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child !== undefined) visit(child, childDepth);
    }
  };
  if (root !== undefined) visit(root, 0);
  return { text: lines.join("\n"), lines: lines.length, omitted };
}

/** ` [ref=e12]`；不可交互、被禁用或没有 DOM 节点的回空串 */
function refLabel(node: AxNode, role: string, refs: ElementRefs): string {
  if (!INTERACTIVE_ROLES.has(role) || node.backendDOMNodeId === undefined) return "";
  const disabled = (node.properties ?? []).some((p) => p.name === "disabled" && p.value?.value === true);
  return disabled ? "" : ` [ref=${refForNode(refs, node.backendDOMNodeId)}]`;
}

function describe(node: AxNode, role: string, name: string): string {
  const parts = [name === "" ? role : `${role} "${name}"`];
  const props = new Map((node.properties ?? []).map((p) => [p.name, p.value?.value]));
  const level = props.get("level");
  if (role === "heading" && typeof level === "number") parts.push(`[level ${level}]`);
  const value = clip(str(node.value?.value), VALUE_MAX);
  if (value !== "" && value !== name) parts.push(`value="${value}"`);
  for (const flag of ["checked", "selected", "expanded", "pressed"] as const) {
    const state = props.get(flag);
    if (state === true || state === "true") parts.push(`[${flag}]`);
    else if (flag === "expanded" && (state === false || state === "false")) parts.push("[collapsed]");
  }
  if (props.get("disabled") === true) parts.push("[disabled]");
  if (props.get("required") === true) parts.push("[required]");
  return parts.join(" ");
}

function str(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
