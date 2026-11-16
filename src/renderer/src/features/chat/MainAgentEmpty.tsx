/**
 * 主智能体的空态（还没跟它说过话）：首页版式不变（口号 + 输入框），输入框下面一行（设计稿 1-empty-after）。
 * - 新工作区：一句「还没有派出去的活」+ 它会怎么处理你的话。
 * - 老工作区升级后第一次打开：一句话说清以前的会话一条没丢、去了哪（没了结的挂在它名下，其余在「以前的会话」）。
 * 说过第一句话就不再出现（会话建出来，就不是空态了）。只一行，不放示例问题、不讲功能。
 */
import type { MainAgentProfile } from "@shared/main-agent";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { workspaceRows } from "../../shell/workspace-rows.ts";
import { runStateOf } from "../notify/completion-notice.ts";
import { useT } from "../../locale.ts";
import type { ChatSession } from "./useChatSession";

export function MainAgentEmpty(props: { session: ChatSession; profile: MainAgentProfile }) {
  const t = useT();
  const { session, profile } = props;
  const rows = workspaceRows(session.sessions, profile.workspaceId, (meta) => runStateOf(session, meta));
  // 档案建立之前就在的会话 = 升级前攒下的（主智能体派出的活都晚于档案）
  const legacy = (meta: { createdAt: number }): boolean => meta.createdAt < profile.createdAt;
  const total = rows.open.filter(legacy).length + rows.earlier.filter(legacy).length;
  if (total === 0) return <PanelEmpty icon="circle-dashed">{t.sidebar.mainEmptyNew}</PanelEmpty>;
  return <PanelEmpty icon="history">{t.sidebar.mainEmptyOld(total, rows.open.filter(legacy).length)}</PanelEmpty>;
}
