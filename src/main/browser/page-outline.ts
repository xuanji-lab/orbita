/**
 * CDP 无障碍树 → 给模型看的缩进大纲（browser_observe）。纯函数，按行预算截断。
 *
 * 取舍：
 * - **只印有意义的节点**：地标（导航 / 主体 / 表单…）、标题、链接、按钮、表单控件、带名字的图片、
 *   对话框。纯排版容器（generic / group / 无名 section）不印，也不加缩进——它们只会把大纲撑深。
 * - **不印正文**（StaticText）：读文字走 browser_extract，大纲只讲结构，控制 token。
 * - 被忽略（ignored）的节点自己不印，子节点照常下钻——很多真实控件挂在 ignored 包装之下。
 * - 第二刀不输出元素引用：还没有点击等动作消费它（引用表留到交互工具那一刀）。
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

/** 列表 / 表格容器没有名字时印出来只是噪音：只作缩进锚，本身不占一行 */
const SILENT_WHEN_UNNAMED = new Set(["list", "table", "grid", "region", "form", "listbox", "menu", "tree", "tablist"]);

const NAME_MAX = 120;
const VALUE_MAX = 80;

export function formatAxOutline(
  nodes: readonly AxNode[],
  maxLines: number,
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
        if (lines.length < maxLines) lines.push(`${"  ".repeat(depth)}- ${describe(node, role, name)}`);
        else omitted += 1;
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
