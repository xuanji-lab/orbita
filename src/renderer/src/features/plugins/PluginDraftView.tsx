/**
 * 「正在做」视图（设计稿 v5 屏 3）：和智能体一起做一个插件时，右栏插件页显示这份**还没安装**的草稿——
 * 就是详情那张长页，标题下写「正在做 · 还没装」；清单里还没写的节画虚线框「还没聊到」，聊到哪填到哪，
 * 智能体改文件，几秒内这里跟着刷新、刚变的节亮一下（`plugin:draft-load` 轮询）。
 * 点「打开看板」换成看板视图（用样例数据先出卡），返回回到这张页。
 *
 * 只给右栏版：页头住工具栏的右栏胶囊（返回 + 「正在做 · 插件名」）。草稿没装，所以没有开关、没有设置，
 * 卡里点的按钮也不记录（BoardGrid 的 actionName 为 null）。
 */
import { useState } from "react";
import { basename } from "./draft-path.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { PanelIconButton, RightPanelFrame } from "../../shell/RightPanel";
import { PluginBoardView } from "./PluginBoardView.tsx";
import { PluginDetail } from "./PluginDetail.tsx";
import { useDraftScan } from "./useBoardFeed.ts";
import "./plugins.css";

export function PluginDraftView(props: { path: string; workspaceId: string | null; onBack: () => void }) {
  const messages = useT();
  const t = messages.pluginPanel;
  const scan = useDraftScan(props.path, props.workspaceId);
  const [boardOpen, setBoardOpen] = useState(false);
  // 名字：清单里的显示名；还没有清单时退回文件夹名
  const name = scan.kind === "ready" ? scan.view.name : basename(props.path);
  const header = boardOpen ? (
    <>
      <PanelIconButton title={t.boardBack} onClick={() => setBoardOpen(false)}>
        <Icon name="chevron-left" size={16} strokeWidth={2} />
      </PanelIconButton>
      <strong className="cap-title">{t.boardTitle(name)}</strong>
    </>
  ) : (
    <>
      <PanelIconButton title={t.draftBack} onClick={props.onBack}>
        <Icon name="chevron-left" size={16} strokeWidth={2} />
      </PanelIconButton>
      <strong className="cap-title">{name === "" ? t.draftTitleFallback : t.draftTitle(name)}</strong>
    </>
  );
  return (
    <RightPanelFrame header={header} contentKey={`plugin-draft:${props.path}:${boardOpen ? "board" : "detail"}`}>
      <div className="pl-page" data-chrome="rail">
        <div className="pl-body">
          {boardOpen ? (
            <PluginBoardView target={{ kind: "draft", path: props.path, workspaceId: props.workspaceId }} />
          ) : scan.kind === "ready" ? (
            <PluginDetail
              view={scan.view}
              workspaces={[]}
              currentWorkspaceId={props.workspaceId}
              draftPath={props.path}
              onOpenBoard={() => setBoardOpen(true)}
              showBack={false}
              onBack={props.onBack}
              onScope={async () => undefined}
              onChanged={async () => undefined}
              onUninstalled={props.onBack}
            />
          ) : scan.kind === "loading" ? (
            <p className="pl-empty">{t.loading}</p>
          ) : (
            <div className="pl-note danger" role="alert">
              <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
              <span>{scan.kind === "error" ? scan.message : t.unavailable[scan.reason]}</span>
            </div>
          )}
        </div>
      </div>
    </RightPanelFrame>
  );
}
