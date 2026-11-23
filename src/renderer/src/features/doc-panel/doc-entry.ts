/**
 * 右栏「文档」「演示文稿」入口的纯逻辑（组件在 DocsPanel.tsx）：点开时开哪份、「新建会放在哪」怎么写。
 * 两个入口是同一套画面，只有 kind 不同。
 */
/**
 * 点开入口时先开哪一份：**只开这个入口自己上次打开过、而且还在的那份**。
 * 不替用户从工作区里挑一份最近改的打开——那可能正是 agent 刚改的 CHANGELOG；
 * 更不在点一下的时候悄悄新建文件。返回 null = 画空态（新建 + 最近几份）。
 * 外部已经要求打开某份（agent 新建 / 聊天里的卡）时让位给它，这里不开。
 */
export function initialOpenPath(input: {
  requested: string | null;
  remembered: string | null;
  rememberedExists: boolean;
}): string | null {
  if (input.requested !== null) return null;
  return input.remembered !== null && input.rememberedExists ? input.remembered : null;
}

/** 文件所在目录（兼容 / 与 \）；没有分隔符 = 原样 */
export function dirOfPath(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? path : path.slice(0, cut);
}

/** 文件名（含扩展名） */
export function baseOfPath(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * 目录写在界面上的两段：前段（太长时由 CSS 在**中间**省略）+ 末级目录名（永远写全，一眼认出是哪个工作区）。
 * 省略交给 CSS 按真实宽度做，不按字数预截：面板宽的时候路径就整条露出来。
 */
export function splitWhere(dir: string): { head: string; tail: string } {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return { head: "", tail: trimmed };
  return { head: trimmed.slice(0, cut + 1), tail: trimmed.slice(cut + 1) };
}
