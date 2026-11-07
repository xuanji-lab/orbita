import { useCallback, useEffect, useState } from "react";
import { docTitle, type DocKind, type DocListEntry } from "@shared/doc";
import type { TextQuote } from "@shared/quote";
import { api } from "../../api";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { PanelIconButton, PanelLine, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import { formatAge } from "../files/tree-view";
import { DocEditPane } from "./DocEditPane";
import { getLast, setLast } from "./view-memory.ts";

/**
 * 右栏的「文档」「演示文稿」面板（同一个组件，`kind` 决定列哪一类、新建哪一类）。
 * 点开 = 打开**上次在这个面板里打开过的**那一份（按工作区 × 类型记）；没有（或那份已不在了）就是空态：
 * 新建一份，或从工作区已有的里挑——不替用户从仓库里随便挑一份 .md 打开（可能正是 agent 刚改的 CHANGELOG）。
 * 编辑本身是 `DocEditPane`——与文件面板里 .md 预览的「编辑」模式是同一个组件，两条路通到同一处。
 */
export function DocsPanel(props: {
  kind: DocKind;
  sessionId: string | null;
  workspaceId: string | null;
  onQuote?: (quote: TextQuote) => void;
}) {
  const t = useT();
  const { kind, workspaceId } = props;
  // 会话 id 只在挂载时取一次：从首页发第一句话、新会话诞生时面板要原地留着（App 的 panelFromHome），
  // 文档用的都是工作区根下的路径，不依赖会话（会话 id 只多出一个工作台根）——别因为 id 从 null 变成真 id
  // 就把文档重读一遍、编辑器重建、光标没了
  const [sessionId] = useState(props.sessionId);
  const scope = `${workspaceId ?? "home"}:${kind}`;
  const [entries, setEntries] = useState<DocListEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<DocListEntry[]> => {
    try {
      const all = await api.docs.list({ sessionId, workspaceId });
      const mine = all.filter((entry) => entry.kind === kind);
      setEntries(mine);
      setListError(null);
      return mine;
    } catch (cause) {
      setListError(ipcErrorText(cause));
      setEntries([]);
      return [];
    }
  }, [sessionId, workspaceId, kind]);

  // 打开面板：列出这一类；上次在这里打开的那份还在就接着开它，否则空态
  useEffect(() => {
    let alive = true;
    setOpenPath(null);
    setEntries(null);
    void reload().then((mine) => {
      if (!alive) return;
      const last = getLast(scope);
      if (last !== null && mine.some((entry) => entry.path === last)) setOpenPath(last);
    });
    return () => {
      alive = false;
    };
  }, [reload, scope]);

  const open = (path: string): void => {
    setLast(scope, path);
    setActionError(null);
    setOpenPath(path);
  };
  const close = (): void => {
    setLast(scope, null);
    setOpenPath(null);
    void reload();
  };
  const create = (): void => {
    setActionError(null);
    void api.docs
      .create({ sessionId, workspaceId, kind })
      .then((created) => {
        open(created.path);
        void reload();
      })
      .catch((cause: unknown) => {
        setActionError(t.doc.newFailed(ipcErrorText(cause)));
      });
  };

  const icon = kind === "slides" ? FEATURE_ICON.slides : FEATURE_ICON.doc;
  const panelName = kind === "slides" ? t.doc.panelSlides : t.doc.panelDoc;

  return (
    <RightPanelFrame
      contentKey={`docs:${kind}`}
      header={<PanelTitle icon={icon} title={openPath === null ? panelName : docTitle(openPath)} />}
      headerExtra={
        <>
          <PanelIconButton title={kind === "slides" ? t.doc.newDeck : t.doc.newDoc} onClick={create}>
            <Icon name="file-plus" size={16} strokeWidth={1.8} />
          </PanelIconButton>
          {openPath !== null && (
            <PanelIconButton title={t.doc.closeDoc} onClick={close}>
              <Icon name="x" size={16} strokeWidth={1.8} />
            </PanelIconButton>
          )}
        </>
      }
    >
      {openPath !== null ? (
        <DocEditPane
          key={openPath}
          sessionId={sessionId}
          workspaceId={workspaceId}
          path={openPath}
          onClose={close}
          onOpenPath={(next) => {
            open(next);
            void reload();
          }}
          {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
        />
      ) : (
        <div className="dp-picker">
          {entries === null ? (
            <PanelEmpty busy>{t.common.loading}</PanelEmpty>
          ) : (
            <PanelEmpty
              icon={icon}
              exit={{ label: kind === "slides" ? t.doc.newDeck : t.doc.newDoc, onClick: create }}
            >
              {kind === "slides" ? t.doc.emptySlides : t.doc.emptyDoc}
            </PanelEmpty>
          )}
          {actionError !== null && (
            <div className="dp-picker-note">
              <PanelLine danger>{actionError}</PanelLine>
            </div>
          )}
          {listError !== null && (
            <div className="dp-picker-note">
              <PanelLine danger>{t.doc.listFailed(listError)}</PanelLine>
            </div>
          )}
          {entries !== null && entries.length > 0 && (
            <div className="dp-picker-list">
              <div className="dp-picker-head">{kind === "slides" ? t.doc.existingSlides : t.doc.existingDoc}</div>
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="option-row dp-picker-row"
                  title={entry.path}
                  onClick={() => open(entry.path)}
                >
                  <Icon name={icon} size={14} strokeWidth={1.8} />
                  <span className="dp-picker-name">{docTitle(entry.path)}</span>
                  <span className="dp-picker-age row-trailing">{formatAge(entry.modifiedAt, Date.now(), t)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </RightPanelFrame>
  );
}
