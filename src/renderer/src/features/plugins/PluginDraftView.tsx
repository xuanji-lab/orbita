/**
 * 「正在做」视图（设计稿 v4 第 1 屏）：和智能体一起做一个插件时，右栏插件页显示这份**还没安装**的草稿——
 * 面板（用样例数据先出一张卡）+ 下面的模板说明（显示哪些字段、怎么排、数据从哪来）。
 * 左边聊天、右边一点点长出来；智能体改文件，几秒内这里跟着刷新（`plugin:draft-load` 轮询）。
 *
 * 只给右栏版：页头住工具栏的右栏胶囊（返回 + 「正在做 · 插件名」）。草稿没装，所以没有开关、没有设置，
 * 模板里点的按钮也不记录（PluginPanelView 的 draft 模式）。
 */
import { basename } from "./draft-path.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { PanelIconButton, RightPanelFrame } from "../../shell/RightPanel";
import { PluginPanelView } from "./PluginPanel.tsx";
import { usePanelFeed } from "./usePluginPanel.ts";
import "./plugins.css";

export function PluginDraftView(props: { path: string; workspaceId: string | null; onBack: () => void }) {
  const messages = useT();
  const t = messages.pluginPanel;
  const feed = usePanelFeed({ kind: "draft", path: props.path, workspaceId: props.workspaceId });
  // 名字：面板标题（清单里写的）；还没有面板时退回文件夹名
  const name = feed.kind === "ready" ? feed.title : basename(props.path);
  const header = (
    <>
      <PanelIconButton title={t.draftBack} onClick={props.onBack}>
        <Icon name="chevron-left" size={16} strokeWidth={2} />
      </PanelIconButton>
      <strong className="cap-title">{name === "" ? t.draftTitleFallback : t.draftTitle(name)}</strong>
    </>
  );
  return (
    <RightPanelFrame header={header} contentKey={`plugin-draft:${props.path}`}>
      <div className="pl-page pl-draft" data-chrome="rail" data-fill="true">
        <div className="pl-body">
          <PluginPanelView key={props.path} feed={feed} actionName={null} draft specOpen />
        </div>
      </div>
    </RightPanelFrame>
  );
}
