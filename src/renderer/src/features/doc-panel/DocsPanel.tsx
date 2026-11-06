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

/**
 * 在这个会话+类型里用户明确关掉过文件：回到面板时不要又自动打开最近一份（模块级，面板重挂也记得）。
 * 键 = 工作区 + 类型；打开 / 新建任何文件就清掉。
 */
const dismissed = new Set<string>();

/**
 * 右栏的「文档」「演示文稿」面板（同一个组件，`kind` 决定列哪一类、新建哪一类）。
 * 点开 = 打开这个工作区里这一类**最近改过**的一份；没有就是空态：新建一份，或从已有的里挑。
 * 编辑本身是 `DocEditPane`——与文件面板里 .md 预览的「编辑」模式是同一个组件，两条路通到同一处。
 */
export function DocsPanel(props: {
  kind: DocKind;
  sessionId: string | null;
  workspaceId: string | null;
  onQuote?: (quote: TextQuote) => void;
}) {
  const t = useT();
  const { kind, sessionId, workspaceId } = props;
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

  // 打开面板：列出这一类，自动打开最近一份（用户这次关掉过的除外）
  useEffect(() => {
    let alive = true;
    setOpenPath(null);
    setEntries(null);
    void reload().then((mine) => {
      if (!alive || dismissed.has(scope)) return;
      const latest = mine[0];
      if (latest !== undefined) setOpenPath(latest.path);
    });
    return () => {
      alive = false;
    };
  }, [reload, scope]);

  const open = (path: string): void => {
    dismissed.delete(scope);
    setActionError(null);
    setOpenPath(path);
  };
  const close = (): void => {
    dismissed.add(scope);
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
