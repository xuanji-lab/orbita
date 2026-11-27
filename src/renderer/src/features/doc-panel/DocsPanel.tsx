import { useCallback, useEffect, useRef, useState } from "react";
import { DOC_PICKER_LIMIT, docTitle, type DocKind, type DocListEntry } from "@shared/doc";
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
import { baseOfPath, dirOfPath, initialOpenPath, splitWhere } from "./doc-entry.ts";
import { docScope, getLast, setLast } from "./view-memory.ts";

/** 「<说明> <目录>」一行：目录太长时在中间省略（CSS 按宽度做），末级目录名永远写全；全路径在 title 里 */
function WhereLine(props: { lead: string; dir: string; className: string; role?: "status" }) {
  const { head, tail } = splitWhere(props.dir);
  return (
    <p className={props.className} title={props.dir} {...(props.role === undefined ? {} : { role: props.role })}>
      <span className="dp-where-body">
        <span className="dp-where-lead">{props.lead}</span>
        <span className="dp-where-path">
          <span className="dp-where-head">{head}</span>
          <span className="dp-where-tail">{tail}</span>
        </span>
      </span>
    </p>
  );
}

/**
 * 右栏的「文档」「演示文稿」入口：同一套画面，`kind` 不同。
 * 点开 = 打开**上次从这个入口打开过的**那一份（按工作区 × 类型记）；没有（或那份已不在了）就是空态：
 * 新建一份，或从工作区里最近改的几份里挑——不替用户从仓库里随便挑一份 .md 打开（可能正是 agent 刚改的 CHANGELOG），
 * 也不在点一下入口时悄悄新建文件。空态里写明新建会放在哪个目录；列表只露最近 N 份，更早的去文件面板找。
 * 编辑本身是 `DocEditPane`——与文件面板里 .md 预览的「编辑」模式是同一个组件，两条路通到同一处；
 * 从文件面板的树里点开 .md 仍走文件面板（那是「文件」，这里是「写东西的入口」）。
 */
export function DocsPanel(props: {
  kind: DocKind;
  sessionId: string | null;
  workspaceId: string | null;
  onQuote?: (quote: TextQuote) => void;
  /** 空态列表尾部「更早的在文件面板里找」：打开文件面板 */
  onOpenFiles?: () => void;
  /** 文档里点双链 / 嵌入：在文件面板里打开解析到的文件；缺席 = 双链只读不跳 */
  onOpenInFiles?: (path: string) => void;
  /** 内置命令（agent 新建 / 打开、聊天里的卡）要求打开某份：nonce 变了就打开 path */
  openRequest?: { path: string; nonce: number } | null;
}) {
  const t = useT();
  const { workspaceId } = props;
  const { kind } = props;
  // 会话 id 只在挂载时取一次：从首页发第一句话、新会话诞生时面板要原地留着（App 的 panelFromHome），
  // 文档用的都是工作区根下的路径，不依赖会话（会话 id 只多出一个工作台根）——别因为 id 从 null 变成真 id
  // 就把文档重读一遍、编辑器重建、光标没了
  const [sessionId] = useState(props.sessionId);
  const scope = docScope(workspaceId, kind);
  const [entries, setEntries] = useState<DocListEntry[] | null>(null);
  const [more, setMore] = useState(false);
  /** 新建会放进的目录（主进程给的工作区根）；null = 还没读到 / 工作区目录不在 */
  const [root, setRoot] = useState<string | null>(null);
  /** 刚在这个面板里新建的那份：编辑器上方写一行「叫什么、放在哪」，换到别的文件或关掉就没了 */
  const [created, setCreated] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 外部要求打开的路径：挂载时的列表回调不能再用「上次打开的」把它盖掉
  const requested = props.openRequest?.path ?? null;
  const requestedRef = useRef<string | null>(requested);
  requestedRef.current = requested;

  const reload = useCallback(async (): Promise<{ rememberedExists: boolean }> => {
    try {
      const listing = await api.docs.list({
        sessionId,
        workspaceId,
        kind,
        limit: DOC_PICKER_LIMIT,
        ...(getLast(scope) === null ? {} : { remembered: getLast(scope) as string }),
      });
      setEntries(listing.entries);
      setMore(listing.more);
      setRoot(listing.root);
      setListError(null);
      return { rememberedExists: listing.rememberedExists };
    } catch (cause) {
      setListError(ipcErrorText(cause));
      setEntries([]);
      setMore(false);
      return { rememberedExists: false };
    }
  }, [sessionId, workspaceId, kind, scope]);

  // 打开面板：列出这一类最近的几份；上次从这里打开的那份还在就接着开它，否则空态
  useEffect(() => {
    let alive = true;
    setOpenPath(null);
    setEntries(null);
    setCreated(null);
    void reload().then(({ rememberedExists }) => {
      if (!alive) return;
      const target = initialOpenPath({ requested: requestedRef.current, remembered: getLast(scope), rememberedExists });
      if (target !== null) setOpenPath(target);
    });
    return () => {
      alive = false;
    };
  }, [reload, scope]);

  const open = (path: string): void => {
    setLast(scope, path);
    setActionError(null);
    setCreated(null);
    setOpenPath(path);
  };
  const nonce = props.openRequest?.nonce ?? null;
  useEffect(() => {
    if (requested !== null) {
      setLast(scope, requested);
      setActionError(null);
      setCreated(null);
      setOpenPath(requested);
      void reload();
    }
    // nonce 是触发器：同一路径再次请求也要重开（比如用户关了又点卡）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
  const close = (): void => {
    setLast(scope, null);
    setCreated(null);
    setOpenPath(null);
    void reload();
  };
  const create = (): void => {
    setActionError(null);
    void api.docs
      .create({ sessionId, workspaceId, kind })
      .then((made) => {
        open(made.path);
        setCreated(made.path);
        void reload();
      })
      .catch((cause: unknown) => {
        setActionError(t.doc.newFailed(ipcErrorText(cause)));
      });
  };

  const isDoc = kind === "doc";
  const icon = isDoc ? FEATURE_ICON.doc : FEATURE_ICON.slides;
  const panelName = isDoc ? t.doc.panelDoc : t.doc.panelSlides;
  const newLabel = isDoc ? t.doc.newDoc : t.doc.newDeck;

  return (
    <RightPanelFrame
      contentKey={`docs:${kind}`}
      header={
        <PanelTitle
          icon={icon}
          title={openPath === null ? panelName : docTitle(openPath)}
          {...(openPath === null ? {} : { tip: openPath })}
        />
      }
      headerExtra={
        <>
          <PanelIconButton title={newLabel} onClick={create}>
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
        <div className="dp-open">
          {created === openPath && (
            <WhereLine
              className="dp-note dp-created"
              role="status"
              lead={t.doc.created(baseOfPath(openPath))}
              dir={dirOfPath(openPath)}
            />
          )}
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
            {...(created === openPath ? { startInEdit: true } : {})}
            {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
            {...(props.onOpenInFiles === undefined || !isDoc
              ? {}
              : { onOpenFile: (target: { path: string }) => props.onOpenInFiles?.(target.path) })}
          />
        </div>
      ) : (
        <div className="dp-picker">
          {entries === null ? (
            <PanelEmpty busy>{t.common.loading}</PanelEmpty>
          ) : (
            <PanelEmpty icon={icon} exit={{ label: newLabel, onClick: create }}>
              {isDoc ? t.doc.emptyDoc : t.doc.emptySlides}
            </PanelEmpty>
          )}
          {entries !== null && root !== null && (
            <WhereLine className="dp-where" lead={t.doc.newHere} dir={root} />
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
              <div className="dp-picker-head">{isDoc ? t.doc.existingDoc : t.doc.existingSlides}</div>
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
              {more && props.onOpenFiles !== undefined && (
                <button type="button" className="option-row dp-picker-row dp-picker-more" onClick={props.onOpenFiles}>
                  <Icon name={FEATURE_ICON.files} size={14} strokeWidth={1.8} />
                  <span className="dp-picker-name">{t.doc.recentOnly(entries.length)}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </RightPanelFrame>
  );
}
