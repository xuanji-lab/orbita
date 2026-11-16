/**
 * LaTeX 上下文的**纯裁决**（2026-11-16 现场 bug 的修复）。
 *
 * 文件面板的编译条与问题抽屉只在「这个文件属于一个 LaTeX 项目」时出现。项目探测要
 * 授权上下文（root + path + 会话 / 工作区），所以上下文本身必须**先**是能用的：
 *
 * - 没有打开文件（树就是整个面板）→ 没有可编的东西；
 * - 附件标签（name 是合成名、path 是原图引用）→ 不可能是项目里的文件；
 * - **没有绑定会话（sessionId === null）**→ 不发上下文。这一条是那次 bug 的根：
 *   上下文照样构造出来 → 主进程探测成功 → 编译条出现 → 点编译把
 *   `sessionId: null` 发过去 → `SessionStore.workbenchPath` 抛
 *   `invalid session id "undefined"`，而界面上什么也没显示（「点了没反应」）。
 *   没有会话就没有工作台授权，编译本来就不该出现，而不是给一个点不动的按钮。
 *
 * 独立成模块的理由同 latex-workbench.ts：FilesPanel 连着 React 与 IPC，`node --test`
 * 加载不了；这里全是输入 → 输出。
 */
import type { LatexFileContext } from "../../../../shared/latex.ts";
import type { FileTab } from "./panel-layout.ts";

export interface LatexContextInput {
  /** 当前激活的标签；null = 没打开文件 */
  activeTab: FileTab | null;
  /** 会话 id：活会话优先、退盘上打开的那条；null = 没有绑定会话 */
  sessionId: string | null;
  workspaceId: string | null;
  /** 专注 / 浏览态的额外根（与 fs:* 同义） */
  focusWorkspaceId?: string | null;
}

/** 可用的当前文件上下文；null = 这套工作台不该启动（不探测、不画编译条） */
export function latexContextOf(input: LatexContextInput): LatexFileContext | null {
  const tab = input.activeTab;
  if (tab === null) return null;
  // 附图标签：name 是合成名、path 是原图引用，不在任何工作区里
  if (tab.name !== undefined) return null;
  // 没有会话 = 没有工作台授权（编译要主进程记住这次编译属于哪条会话）
  if (input.sessionId === null) return null;
  const extra = input.focusWorkspaceId ?? null;
  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    ...(extra === null ? {} : { extraWorkspaceId: extra }),
    root: tab.root,
    path: tab.path,
  };
}
