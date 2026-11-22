import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { formatSize } from "../files/tree-view";
import { xlsxColumnLabel, xlsxColumnWidths, xlsxGridRows, type XlsxGridSlot } from "./xlsx-grid.ts";
import {
  EMPTY_GRID_EDIT,
  beginEdit,
  canSave,
  cancelEdit,
  cellDisplay,
  cellRawText,
  clearPending,
  commitEdit,
  isDirty,
  moveSelection,
  pendingAt,
  pendingEdits,
  removePending,
  selectCell,
  updateDraft,
  type GridEditState,
  type PendingCellEdit,
} from "./xlsx-edit-state.ts";
import type { FileListRequest } from "@shared/files";
import type { XlsxFingerprint, XlsxPreview, XlsxSheet, XlsxWriteResult } from "@shared/xlsx";
import type { TextQuote } from "@shared/quote";
import {
  OfficeChangesPanel,
  OfficeModeChips,
  OfficePreview,
  OfficeUnavailableNotice,
  useOfficeChanged,
  useOfficeStatus,
} from "../office/OfficePreview.tsx";
import { bumpOfficeReload, OFFICE_RELOAD_INITIAL, type OfficeReloadState } from "../office/reload.ts";

/**
 * `.xlsx` 面板（契约在 `shared/xlsx.ts`）：OfficeCLI 渲染视图 + **可编辑的数据网格**。
 *
 * **不画 Excel 的排版**：列宽、字体、底色、条件格式读不全，照 HTML 表画出来用户会以为
 * 原文件坏了。网格只给「结构化数据 + 坐标（A/B/C、1/2/3）」：合并区按跨行跨列画成一个格、
 * 公式显示缓存值（原文进工具提示）、数值右对齐等宽。排版与打印仍交给 Excel / WPS——
 * 工具栏那个「用默认应用打开」。
 *
 * **编辑只改值 / 公式**（2026-11-22）：单击选中、双击或直接键入进入编辑、公式栏与选区
 * 同步；回车提交并下移、Tab 提交并右移、Esc 取消。改过的格有角标，底部给「状态 / 撤销 /
 * 保存」——**保存只有那一个主操作位**，改动清单只负责「改了什么、能撤哪一条」。
 * 写回在 `main/xlsx/edit.ts`：只动目标格的 XML（样式、合并、条件格式、图片一个
 * 字节不改），临时文件 + rename 原子写，保存前比对指纹（文件在外部被改过就拦下）。
 *
 * **公式不重算**：写进去的公式只有公式文本、没有缓存值，所以这类格显示公式原文并带
 * 「未计算」标记，底部写明数值要 Excel 打开后才更新。我们不假装算过。
 */
export function XlsxView(props: {
  request: FileListRequest;
  /** 面板头部的刷新按钮：同一个文件重读（agent 可能刚改过它） */
  reloadToken: number;
  /** 用系统默认应用打开（与空态那个按钮同一个动作，由 FilePreviewPane 给） */
  onOpenDefault: () => void;
  /** 点单元格出的标注进输入框（Office 渲染视图里；缺席 = 只显示、不引用） */
  onQuote?: (quote: TextQuote) => void;
}) {
  const t = useT();
  // Office 渲染（OfficeCLI）可用时就默认渲染视图；不可用 / 点了渲染却失败 → 数据网格
  const office = useOfficeStatus();
  const canRender = office?.available === true;
  const [mode, setMode] = useState<"render" | "data">("render");
  /**
   * 渲染与数据视图各一个刷新令牌（见 office/reload.ts）：编辑落盘、整批回退、
   * 手动刷新都让**两边一起 +1**，回退不再把用户切到数据视图（2026-11-17 验收 BUG）。
   */
  const [reload, setReload] = useState<OfficeReloadState>(OFFICE_RELOAD_INITIAL);
  const shownMode = canRender ? mode : "data";
  // 换文件由 FilePreviewPane 的 key={path} 重挂载解决，这里不用再「重置表号」——否则旧文件
  // 那张表的号会先发一次请求，新文件再发一次，同一个工作簿白解析两遍
  const [sheet, setSheet] = useState(0);
  const state = useXlsxPreview(props.request, sheet, props.reloadToken + reload.data);
  // agent 改了一份文件（edit_office / 回退）：两种视图一起重读，别让它们各说各话
  useOfficeChanged(props.request.dir, () => setReload(bumpOfficeReload));
  const data = state.data;
  const activeSheet = data !== null && data.kind === "workbook" ? data.sheet : null;

  /**
   * 编辑状态。`editRef` 同步持有最新值：blur 与 Ctrl+S 这类「同一轮事件里晚一步读 state」
   * 的地方必须读它——比如在格子里敲完字直接点「保存」，blur 先提交、click 后读，读 state
   * 会漏掉刚敲的那格。
   */
  const [edit, setEditState] = useState<GridEditState>(EMPTY_GRID_EDIT);
  const editRef = useRef<GridEditState>(EMPTY_GRID_EDIT);
  const setEdit = useCallback((next: GridEditState) => {
    editRef.current = next;
    setEditState(next);
  }, []);
  const applyEdit = useCallback(
    (updater: (current: GridEditState) => GridEditState) => setEdit(updater(editRef.current)),
    [setEdit],
  );
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [notice, setNotice] = useState<XlsxSaveNotice | null>(null);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 网格里那张表的名字（保存 / 清单要用；用 ref 免得回调被 sheet 的引用一直重建） */
  const sheetRef = useRef<XlsxSheet | null>(null);
  useEffect(() => {
    sheetRef.current = activeSheet;
  }, [activeSheet]);
  // 首屏给一个落点（A1）：没有选区的话方向键与「直接键入」都没有作用对象
  useEffect(() => {
    if (activeSheet === null || editRef.current.active !== null) return;
    if (!editableSheet(activeSheet)) return;
    setEdit({ ...editRef.current, active: { row: 0, col: 0 } });
  }, [activeSheet, setEdit]);

  /**
   * 盘上指纹：`fingerprint` 是最新一次读到的（用于显示「外部改过」），
   * `baseFingerprint` 是**开始这批改动时**的（保存时交给主进程比对）。
   * 两者分开是必须的：文件在编辑期间被外部改过时我们会自动重读，如果拿最新指纹去保存，
   * 冲突闸就永远不响——人这边的改动会悄悄盖掉 agent 的改动。
   */
  const [fingerprint, setFingerprint] = useState<XlsxFingerprint | null>(null);
  const fingerprintRef = useRef<XlsxFingerprint | null>(null);
  const baseFingerprintRef = useRef<XlsxFingerprint | null>(null);
  useEffect(() => {
    if (data === null || data.kind !== "workbook" || state.loading) return;
    const next = { mtimeMs: data.modifiedAt, size: data.size };
    fingerprintRef.current = next;
    setFingerprint(next);
  }, [data, state.loading]);

  const dirty = isDirty(edit);
  /**
   * 底部那句「公式不重算」要不要出现：盘上已有未计算的公式（真的没算过），或这次存了公式。
   * 扫整张窗口（最多 10 万格）必须 memo：每敲一个字都重扫一遍会把输入拖慢。
   */
  const uncachedInSheet = useMemo(
    () => (activeSheet === null ? false : hasUncachedFormula(activeSheet)),
    [activeSheet],
  );
  const externallyChanged =
    dirty &&
    baseFingerprintRef.current !== null &&
    fingerprint !== null &&
    (fingerprint.mtimeMs !== baseFingerprintRef.current.mtimeMs || fingerprint.size !== baseFingerprintRef.current.size);

  /** 把当前正在编辑的那格提交进清单（不提交就什么都不做） */
  const commitInto = useCallback((current: GridEditState, next: "down" | "right" | "none"): GridEditState => {
    const target = current.editing;
    const targetSheet = sheetRef.current;
    if (target === null || targetSheet === null) return current;
    const committed = commitEdit(current, {
      sheet: targetSheet.name,
      next,
      bounds: gridBounds(targetSheet),
      original: targetSheet.rows[target.row]?.[target.col] ?? null,
    });
    // 这一批的第一步：记下当时的盘上指纹（保存时用它判「文件在外部被改过」）
    if (current.pending.length === 0 && committed.pending.length > 0) {
      baseFingerprintRef.current = fingerprintRef.current;
    }
    return committed;
  }, []);

  const commitActive = useCallback(
    (next: "down" | "right" | "none") => applyEdit((current) => commitInto(current, next)),
    [applyEdit, commitInto],
  );

  const save = useCallback((): void => {
    if (savingRef.current) return;
    const staged = commitInto(editRef.current, "none");
    if (staged !== editRef.current) setEdit(staged);
    const edits = pendingEdits(staged);
    if (edits.length === 0) return;
    const expected = baseFingerprintRef.current;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    setReloadConfirm(false);
    void api.files
      .writeXlsx({
        sessionId: props.request.sessionId,
        workspaceId: props.request.workspaceId,
        ...(props.request.extraWorkspaceId === undefined
          ? {}
          : { extraWorkspaceId: props.request.extraWorkspaceId }),
        root: props.request.root,
        dir: props.request.dir,
        ...(expected === null ? {} : { expected }),
        edits,
      })
      .then((result) => {
        if (result.kind === "ok") {
          setEdit(clearPending(editRef.current));
          baseFingerprintRef.current = null;
          const next = { mtimeMs: result.modifiedAt, size: result.size };
          fingerprintRef.current = next;
          setFingerprint(next);
          setSavedOnce(true);
          // 缓存值 / 别人改的东西都可能变：两种视图一起重读
          setReload(bumpOfficeReload);
          return;
        }
        setNotice(describeWriteFailure(result, t));
      })
      .catch((cause: unknown) => {
        setNotice({ text: t.files.xlsxSaveFailed(failMessage(cause)), reload: false });
      })
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  }, [commitInto, props.request, setEdit, t]);

  /**
   * 撤销这一批未保存的改动（底栏与改动清单共用这一个动作——两处各写一份
   * `applyEdit` + `clearPending` 就是在维护同一条规矩的两份拷贝）。
   * 保存**只有底栏那一个按钮**：改动清单是「我改了什么、能撤哪一条」的地方，
   * 不是第二个提交入口（2026-11-22 验收：Excel 底部出现两个保存）。
   */
  const undoAll = useCallback((): void => {
    applyEdit(clearPending);
  }, [applyEdit]);

  /** 重新加载：丢掉未保存的改动、重读文件（丢改动要二次点，见 xlsxReloadDiscard） */
  const reloadNow = useCallback(() => {
    setEdit({ active: editRef.current.active, editing: null, pending: [] });
    baseFingerprintRef.current = null;
    setNotice(null);
    setReloadConfirm(false);
    setReload(bumpOfficeReload);
  }, [setEdit]);

  // 改动数变了，上一次的「再点一次丢弃 N 处」就不再指向同一件事：收回确认态
  useEffect(() => {
    setReloadConfirm(false);
  }, [edit.pending.length]);

  // Ctrl/Cmd+S：面板里有焦点就存（输入框里也算——用户在公式栏里敲完随手按一下）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "s") return;
      const root = rootRef.current;
      const target = event.target;
      if (root === null || !(target instanceof Node) || !root.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // 还没有任何数据（首次打开）：只能给一行「正在载入…」——此时没有标签可留
  if (data === null) {
    return state.error !== null ? <XlsxError message={state.error} /> : <XlsxLoading />;
  }

  const workbook = data.kind === "workbook" ? data : null;
  // 切表中的高亮跟着「点的那张」走，而不是上一份回执的 active
  const active = workbook === null ? 0 : state.loading ? sheet : workbook.active;
  return (
    <div className="xlsx-view" ref={rootRef}>
      {/*
       * 工具栏与表标签在加载期间**不卸载**：切表时标签还在，用户看得见自己点的是哪张，
       * 也能接着点别的（后发的请求按 token 丢弃先回的）。首次打开没有标签可留，那种情况
       * 在上面的早返回里。
       */}
      {/*
       * 工具栏的「渲染 / 数据」芯片**不挂在 workbook 上**：结构解析失败（#341 读不动
       * officecli 生成的 xlsx）时，数据视图仍然要能点进去看原因，不能整排消失（B3）。
       * 表标签只在解析成功时才有。
       */}
      <div className="xlsx-toolbar">
        {canRender && (
          <OfficeModeChips
            mode={mode}
            onChange={(next) => {
              // 未保存的改动只在数据视图里看得见（也只在那边能保存）：切走前先拦住，
              // 否则用户会以为改动丢了
              if (next === "render" && isDirty(editRef.current)) {
                setNotice({ text: t.files.xlsxUnsavedInGrid, reload: false });
                return;
              }
              setNotice(null);
              setMode(next);
            }}
            dataLabel={t.office.modeGrid}
          />
        )}
        {shownMode === "data" && workbook !== null && workbook.sheets.length > 1 && (
          <div className="xlsx-sheets" role="group" aria-label={t.files.xlsxSheets}>
            {workbook.sheets.map((tab, index) => (
              <Chip
                key={`${index}:${tab.name}`}
                active={index === active}
                title={tab.name}
                onClick={() => {
                  setSheet(index);
                  // 换表：选区回到 A1（上一张表选到第 800 行，对这张表没有意义）。
                  // 未保存的改动跟着走——每一条都记着自己属于哪张表。
                  setEdit({ active: { row: 0, col: 0 }, editing: null, pending: editRef.current.pending });
                }}
              >
                {tab.name}
              </Chip>
            ))}
          </div>
        )}
        <div className="xlsx-toolbar-actions row-trailing">
          <PanelButton onClick={props.onOpenDefault}>
            <Icon name="external-link" size={14} />
            {t.files.openDefault}
          </PanelButton>
        </div>
      </div>
      {/*
       * 改动清单：人与 agent 的改动是**同一份**（同一份文件的这一批），所以这份面板在
       * 数据视图里也要在——人保存完之后要能在同一处看到自己改了什么。它只读主进程的
       * 记账，不依赖 OfficeCLI 是否可用。
       */}
      {props.request.sessionId !== null && (
        <OfficeChangesPanel
          request={props.request}
          reloadToken={props.reloadToken + reload.render}
          onReverted={() => {
            // 回退 = 一次文件变化：两边令牌 +1，**模式不动**；未保存的改动已经没有意义
            setEdit({ active: editRef.current.active, editing: null, pending: [] });
            baseFingerprintRef.current = null;
            setReloadConfirm(false);
            setNotice(null);
            setReload(bumpOfficeReload);
          }}
        />
      )}
      {canRender && shownMode === "render" ? (
        <OfficePreview
          request={props.request}
          format="xlsx"
          reloadToken={props.reloadToken + reload.render}
          onFallback={() => setMode("data")}
          {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
        />
      ) : state.error !== null ? (
        <XlsxError message={state.error} />
      ) : state.loading ? (
        // 加载落在网格区里：工具栏与标签保持原样，只是内容在等
        <XlsxLoading />
      ) : data.kind === "too-large" ? (
        <div className="file-preview-empty">
          <Icon name="file-spreadsheet" size={24} style={{ color: "var(--color-text-tertiary)" }} />
          <PanelLine>{t.files.tooLarge(formatSize(data.size), formatSize(data.limit))}</PanelLine>
          <OpenDefaultButton onClick={props.onOpenDefault} />
        </div>
      ) : data.kind === "unreadable" ? (
        <div className="file-preview-empty">
          <Icon name="file-spreadsheet" size={24} style={{ color: "var(--color-text-tertiary)" }} />
          {/* corrupt + 渲染可用：先说「是解析器的问题、渲染视图仍可看」，不要先用
              「可能已经损坏」把人吓回去（B3）。密码 / 全是隐藏表这些原因保持原话。 */}
          <PanelLine>
            {data.reason === "corrupt" && canRender
              ? t.files.xlsxRenderStillViewable
              : unreadableMessage(data.reason, t)}
          </PanelLine>
          {/* 技术副行：解压 / 解析失败的原文，读得懂的人据此判断是不是文件本身坏了 */}
          <p className="xlsx-detail" title={data.detail}>
            {data.detail}
          </p>
          {canRender && data.reason !== "corrupt" && <PanelLine>{t.files.xlsxRenderStillViewable}</PanelLine>}
          {canRender && (
            <PanelButton onClick={() => setMode("render")}>
              <Icon name="file-spreadsheet" size={14} />
              {t.office.modeRender}
            </PanelButton>
          )}
          <OpenDefaultButton onClick={props.onOpenDefault} />
        </div>
      ) : (
        <>
          <XlsxFormulaBar
            sheet={data.sheet}
            edit={edit}
            disabled={!editableSheet(data.sheet)}
            onChange={(text) => {
              const activeCell = editRef.current.active;
              if (activeCell === null) return;
              applyEdit((current) => beginEdit(current, activeCell.row, activeCell.col, text));
            }}
            onCommit={(next) => commitActive(next)}
            onCancel={() => applyEdit(cancelEdit)}
          />
          <XlsxGrid
            sheet={data.sheet}
            edit={edit}
            onSelect={(row, col) => applyEdit((current) => selectCell(current, row, col))}
            onBegin={(row, col) => {
              applyEdit((current) => {
                const cell = data.sheet.rows[row]?.[col] ?? null;
                return beginEdit(current, row, col, cellRawText(pendingAt(current, row, col), cell));
              });
            }}
            onCommit={(next) => commitActive(next)}
            onCancel={() => applyEdit(cancelEdit)}
            onDraft={(text) => applyEdit((current) => updateDraft(current, text))}
            onMove={(direction) =>
              applyEdit((current) => moveSelection(current, direction, gridBounds(data.sheet)))
            }
            onBeginActive={() => {
              applyEdit((current) => {
                const activeCell = current.active;
                if (activeCell === null) return current;
                const cell = data.sheet.rows[activeCell.row]?.[activeCell.col] ?? null;
                return beginEdit(
                  current,
                  activeCell.row,
                  activeCell.col,
                  cellRawText(pendingAt(current, activeCell.row, activeCell.col), cell),
                );
              });
            }}
            onTypeFirst={(char) => {
              applyEdit((current) => {
                const activeCell = current.active;
                if (activeCell === null) return current;
                return beginEdit(current, activeCell.row, activeCell.col, char);
              });
            }}
            onSave={save}
          />
          {notice !== null && (
            <XlsxNotice
              text={notice.text}
              {...(notice.reload
                ? {
                    action: reloadConfirm ? t.files.xlsxReloadDiscard(edit.pending.length) : t.files.xlsxReload,
                    onAction: () => {
                      if (isDirty(editRef.current) && !reloadConfirm) {
                        setReloadConfirm(true);
                        return;
                      }
                      reloadNow();
                    },
                  }
                : {})}
            />
          )}
          {edit.pending.length > 0 && (
            <XlsxPendingPanel
              sheetName={data.sheet.name}
              edits={edit.pending}
              onRemove={(row, col) => applyEdit((current) => removePending(current, row, col))}
              onClearAll={undoAll}
            />
          )}
          <XlsxFooter
            sheet={data.sheet}
            normalized={data.normalized === true}
            unsaved={edit.pending.length}
            saved={savedOnce && edit.pending.length === 0}
            saving={saving}
            saveEnabled={canSave(edit, saving)}
            formulaNote={uncachedInSheet || edit.pending.some((item) => item.formula)}
            externallyChanged={externallyChanged}
            onSave={save}
            onUndoAll={undoAll}
          />
        </>
      )}
      {office !== null && !canRender && <OfficeUnavailableNotice status={office} fallback="grid" />}
    </div>
  );
}

/** 这张表能编辑吗：至少得有一行一格（空表没有可点的格，也没有可写的坐标） */
function editableSheet(sheet: XlsxSheet): boolean {
  return sheet.rows.length > 0 && (sheet.rows[0]?.length ?? 0) > 0;
}

/** 网格的边界（0-based 上界交给 moveSelection / commitEdit 夹住） */
function gridBounds(sheet: XlsxSheet): { rows: number; cols: number } {
  return { rows: sheet.rows.length, cols: sheet.rows[0]?.length ?? 0 };
}

/** 这张表里有没有「有公式、没有缓存值」的格（有就要在底部说清不重算） */
function hasUncachedFormula(sheet: XlsxSheet): boolean {
  for (const row of sheet.rows) {
    for (const cell of row) {
      if (cell !== null && cell.formula !== undefined && cell.text === "") return true;
    }
  }
  return false;
}

/** 保存失败的结论 → 一条人话 + 要不要给「重新加载」 */
interface XlsxSaveNotice {
  text: string;
  reload: boolean;
}

function describeWriteFailure(result: XlsxWriteResult, t: ReturnType<typeof useT>): XlsxSaveNotice {
  switch (result.kind) {
    case "conflict":
      return { text: t.files.xlsxConflict, reload: true };
    case "out-of-window":
      return { text: t.files.xlsxOutOfWindow(result.rows, result.cols), reload: false };
    case "too-large":
      return { text: t.files.tooLarge(formatSize(result.size), formatSize(result.limit)), reload: false };
    case "shared-formula":
      return {
        text: t.files.xlsxSharedFormula(`${xlsxColumnLabel(result.col - 1)}${result.row}`),
        reload: false,
      };
    case "unreadable":
      return {
        text:
          result.reason === "sheet-missing"
            ? t.files.xlsxSheetMissing
            : `${unreadableMessage(result.reason, t)} ${result.detail}`,
        reload: result.reason === "sheet-missing",
      };
    case "failed":
      return { text: t.files.xlsxSaveFailed(result.error), reload: false };
    default:
      return { text: t.files.xlsxSaved, reload: false };
  }
}

/** 读不开的三种原因各说各的人话；技术原文留给 detail 副行 */
function unreadableMessage(reason: "password" | "corrupt" | "hidden", t: ReturnType<typeof useT>): string {
  if (reason === "password") return t.files.xlsxPassword;
  if (reason === "hidden") return t.files.xlsxHiddenOnly;
  return t.files.xlsxBroken;
}

function XlsxLoading() {
  const t = useT();
  return (
    <div className="file-preview-loading">
      <Icon name="loader-circle" size={14} spin />
      {t.common.loading}
    </div>
  );
}

function XlsxError(props: { message: string }) {
  return (
    <div className="file-preview-error">
      <PanelLine danger>{props.message}</PanelLine>
    </div>
  );
}

function OpenDefaultButton(props: { onClick: () => void }) {
  const t = useT();
  return (
    <PanelButton onClick={props.onClick}>
      <Icon name="external-link" size={14} />
      {t.files.openDefault}
    </PanelButton>
  );
}

/** 保存失败 / 冲突的提示条。冲突时带「重新加载」（丢改动要二次点，见 xlsxReloadDiscard） */
function XlsxNotice(props: { text: string; action?: string; onAction?: () => void }) {
  return (
    <div className="xlsx-notice-bar" role="alert">
      <Icon name="triangle-alert" size={12} />
      <span className="xlsx-notice-text">{props.text}</span>
      {props.action !== undefined && props.onAction !== undefined && (
        <span className="row-trailing">
          <PanelButton onClick={props.onAction}>
            <Icon name="rotate-ccw" size={12} />
            {props.action}
          </PanelButton>
        </span>
      )}
    </div>
  );
}

/**
 * 公式栏：显示 / 编辑当前格的内容（公式带前导 `=`）。它的值与选区同步——在格子里改了
 * 什么，这里就出现什么；在这里改了，格子上立刻出现未保存的角标。
 */
function XlsxFormulaBar(props: {
  sheet: XlsxSheet;
  edit: GridEditState;
  disabled: boolean;
  onChange: (text: string) => void;
  onCommit: (next: "down" | "right") => void;
  onCancel: () => void;
}) {
  const t = useT();
  const active = props.edit.active;
  const editing = props.edit.editing;
  const pending = active === null ? null : pendingAt(props.edit, active.row, active.col);
  const cell = active === null ? null : (props.sheet.rows[active.row]?.[active.col] ?? null);
  const value = editing !== null ? editing.draft : cellRawText(pending, cell);
  const label = active === null ? "" : `${xlsxColumnLabel(active.col)}${active.row + 1}`;
  return (
    <div className="xlsx-formula-bar">
      <span className="xlsx-formula-ref" aria-label={t.files.xlsxSelection(label)}>
        {label === "" ? "—" : label}
      </span>
      <input
        className="xlsx-formula-input"
        value={value}
        disabled={props.disabled || active === null}
        aria-label={t.files.xlsxCellInput}
        placeholder={t.files.xlsxCellInputPlaceholder}
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onCommit("down");
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            props.onCommit("right");
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
    </div>
  );
}

/** 行高：与 styles.css 的 `--xlsx-row-height` 成对改（TS 算滚动窗口，CSS 定行高） */
const ROW_HEIGHT = 24;
/** 可见区上下各多画这么多行：快速滚动时不留白，重排的开销仍是一小段 */
const OVERSCAN = 12;
/** 首屏先画这么多行（还没量到面板高度前的估计值；量到后立刻校正） */
const FIRST_PAINT_ROWS = 40;

/**
 * 数据网格。行号 + 列标让用户能对着原文件定位（「B17 那格」）；合并区按跨行跨列画成
 * 一个格——被盖住的格子在主进程里已经是 null，这里再由 xlsxGridRows 标成 covered 不画，
 * 否则同一段文字会出现两遍。`title` 带公式原文：数值是缓存值，公式才是文件里写的东西。
 *
 * **只画可见的几十行**（窗口化）：2000 行 × 50 列 = 10 万个 <td>，实测在 Chromium 里
 * 建 DOM + 首帧要好几秒（这就是「打开大表卡死」的根因），而预览面板一屏只看得见 ~30 行。
 * 上下各多画 OVERSCAN 行避免滚动时露白；没画的行用两根占位行把总高度撑住，滚动条长度
 * 与滚动位置都与整张表一致。列宽走 colgroup + `table-layout: fixed`。
 *
 * 键盘与指针：容器自己吃方向键 / 回车 / 可打印字符（输入框里的事件在 GridCell 里就
 * stopPropagation 了），所以「编辑中不翻页、不挪选区」是结构上保证的。
 */
function XlsxGrid(props: {
  sheet: XlsxSheet;
  edit: GridEditState;
  onSelect: (row: number, col: number) => void;
  onBegin: (row: number, col: number) => void;
  onBeginActive: () => void;
  onTypeFirst: (char: string) => void;
  onDraft: (text: string) => void;
  onCommit: (next: "down" | "right" | "none") => void;
  onCancel: () => void;
  onMove: (direction: "up" | "down" | "left" | "right") => void;
  onSave: () => void;
}) {
  const t = useT();
  const columns = props.sheet.rows[0]?.length ?? 0;
  const total = props.sheet.rows.length;
  const labels = useMemo(
    () => Array.from({ length: columns }, (_, index) => xlsxColumnLabel(index)),
    [columns],
  );
  // 列宽按数据估（见 xlsxColumnWidths）：固定列宽既让 50 列的表挤得下，也让换窗口
  // 不必重算整表宽度
  const widths = useMemo(() => xlsxColumnWidths(props.sheet), [props.sheet]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [rowWindow, setRowWindow] = useState({ start: 0, end: Math.min(total, FIRST_PAINT_ROWS + OVERSCAN * 2) });

  const updateWindow = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const visible = Math.max(1, Math.ceil(node.clientHeight / ROW_HEIGHT));
    const first = Math.max(0, Math.floor(node.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(total, first + visible + OVERSCAN * 2);
    setRowWindow((prev) => (prev.start === first && prev.end === last ? prev : { start: first, end: last }));
  }, [total]);

  // 换表：滚动回左上角，窗口回到开头（上一张表滚到的位置对这张表没有意义）
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTo({ top: 0, left: 0 });
    setRowWindow({ start: 0, end: Math.min(total, FIRST_PAINT_ROWS + OVERSCAN * 2) });
    updateWindow();
  }, [props.sheet, total, updateWindow]);

  // 面板拖宽 / 拖窄：可见行数变了，窗口跟着重算
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(updateWindow);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateWindow]);

  // 选区移动 / 进入编辑：把那一行带进视野（回车往下、方向键、点公式栏之后都可能在外面）
  const activeRow = props.edit.editing?.row ?? props.edit.active?.row ?? null;
  useEffect(() => {
    if (activeRow === null) return;
    if (activeRow < rowWindow.start || activeRow >= rowWindow.end) {
      setRowWindow({
        start: Math.max(0, activeRow - OVERSCAN),
        end: Math.min(total, activeRow + OVERSCAN + FIRST_PAINT_ROWS),
      });
    }
    const node = scrollRef.current;
    if (node === null) return;
    const top = activeRow * ROW_HEIGHT;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + ROW_HEIGHT > node.scrollTop + node.clientHeight) {
      node.scrollTop = top + ROW_HEIGHT - node.clientHeight;
    }
  }, [activeRow, rowWindow.start, rowWindow.end, total]);

  const rows = useMemo(
    () => xlsxGridRows(props.sheet, rowWindow.start, rowWindow.end),
    [props.sheet, rowWindow.start, rowWindow.end],
  );

  if (columns === 0 || total === 0) {
    return (
      <div className="xlsx-empty">
        <PanelLine>{t.files.xlsxEmpty}</PanelLine>
      </div>
    );
  }

  return (
    <div
      className="xlsx-scroll"
      ref={scrollRef}
      tabIndex={0}
      role="grid"
      aria-label={props.sheet.name}
      onScroll={updateWindow}
      onMouseDown={(event) => {
        // 点格子也要把焦点交给容器：否则方向键 / 直接键入都没有落点。
        // 点正在编辑的输入框时放过——那里要自己拿焦点才能放光标。
        const target = event.target;
        if (target instanceof Element && target.closest("input") !== null) return;
        scrollRef.current?.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return; // 输入框里的事件归输入框
        if (event.metaKey || event.ctrlKey || event.altKey) {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            props.onSave();
          }
          return;
        }
        switch (event.key) {
          case "ArrowUp":
            event.preventDefault();
            props.onMove("up");
            return;
          case "ArrowDown":
            event.preventDefault();
            props.onMove("down");
            return;
          case "ArrowLeft":
            event.preventDefault();
            props.onMove("left");
            return;
          case "ArrowRight":
            event.preventDefault();
            props.onMove("right");
            return;
          case "Enter":
          case "F2":
            event.preventDefault();
            props.onBeginActive();
            return;
          case "Escape":
            event.preventDefault();
            props.onCancel();
            return;
          default:
            if (event.key.length === 1) {
              event.preventDefault();
              props.onTypeFirst(event.key);
            }
        }
      }}
    >
      <table className="xlsx-table">
        <colgroup>
          <col style={{ width: "var(--xlsx-gutter-width)" }} />
          {labels.map((_, index) => (
            <col key={index} style={{ width: widths[index] ?? 64 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="xlsx-gutter" scope="col" />
            {labels.map((label, index) => (
              <th
                key={index}
                className="xlsx-colhead"
                scope="col"
                data-active={props.edit.active?.col === index ? "true" : undefined}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowWindow.start > 0 && <SpacerRow rows={rowWindow.start} span={labels.length + 1} />}
          {rows.map((slots, index) => {
            const row = rowWindow.start + index;
            return (
              <tr key={row}>
                <th
                  className="xlsx-gutter"
                  scope="row"
                  data-active={props.edit.active?.row === row ? "true" : undefined}
                >
                  {row + 1}
                </th>
                {slots.map((slot, colIndex) => (
                  <GridCell
                    key={colIndex}
                    slot={slot}
                    row={row}
                    col={colIndex}
                    firstRenderedRow={rowWindow.start}
                    edit={props.edit}
                    onSelect={props.onSelect}
                    onBegin={props.onBegin}
                    onDraft={props.onDraft}
                    onCommit={props.onCommit}
                    onCancel={props.onCancel}
                  />
                ))}
              </tr>
            );
          })}
          {rowWindow.end < total && <SpacerRow rows={total - rowWindow.end} span={labels.length + 1} />}
        </tbody>
      </table>
    </div>
  );
}

/** 占位行：把没画的那些行的高度撑起来，滚动条长度与真实表一致。不带边框、不响应指针 */
function SpacerRow(props: { rows: number; span: number }) {
  return (
    <tr className="xlsx-spacer" aria-hidden="true">
      <td colSpan={props.span} style={{ height: props.rows * ROW_HEIGHT }} />
    </tr>
  );
}

/** 一格：选中 / 编辑 / 未保存角标 / 未计算的公式，都在这一处决定怎么画 */
function GridCell(props: {
  slot: XlsxGridSlot;
  /** 0-based */
  row: number;
  col: number;
  firstRenderedRow: number;
  edit: GridEditState;
  onSelect: (row: number, col: number) => void;
  onBegin: (row: number, col: number) => void;
  onDraft: (text: string) => void;
  onCommit: (next: "down" | "right" | "none") => void;
  onCancel: () => void;
}) {
  const t = useT();
  const slot = props.slot;
  if (slot.kind === "covered") {
    // 锚点在本段里：整格不画，位置由锚点那格的 colSpan / rowSpan 占掉
    if (slot.anchorRow >= props.firstRenderedRow) return null;
    // 合并区跨过了窗口上边界（锚点在上方没画）：画个空格子占位，否则这一行会左移
    return <td className="xlsx-cell" />;
  }
  const original = slot.kind === "value" ? slot.cell : null;
  const pending = pendingAt(props.edit, props.row, props.col);
  const display = cellDisplay(pending, original);
  const editing = props.edit.editing;
  const isEditing = editing !== null && editing.row === props.row && editing.col === props.col;
  const selected = props.edit.active?.row === props.row && props.edit.active?.col === props.col;
  const span = slot.kind === "value" ? { colSpan: slot.colSpan, rowSpan: slot.rowSpan } : { colSpan: 1, rowSpan: 1 };

  return (
    <td
      className="xlsx-cell"
      data-selected={selected ? "true" : undefined}
      data-edited={display.edited ? "true" : undefined}
      data-numeric={display.numeric ? "true" : undefined}
      data-error={original?.error === true ? "true" : undefined}
      data-formula={original?.formula === undefined ? undefined : "true"}
      data-uncached={display.uncached ? "true" : undefined}
      title={
        isEditing
          ? undefined
          : display.uncached
            ? `${display.text} · ${t.files.xlsxFormulaUncached}`
            : display.text === ""
              ? undefined
              : display.text
      }
      colSpan={span.colSpan === 1 ? undefined : span.colSpan}
      rowSpan={span.rowSpan === 1 ? undefined : span.rowSpan}
      onClick={(event) => {
        // 点编辑中的输入框只是为了放光标，不是「选中别的格」
        if (event.target instanceof HTMLInputElement) return;
        props.onSelect(props.row, props.col);
      }}
      onDoubleClick={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        props.onBegin(props.row, props.col);
      }}
    >
      {isEditing ? (
        <input
          className="xlsx-cell-input"
          // 换格就重挂载：新输入框自己拿焦点并全选
          key={`${props.row}:${props.col}`}
          autoFocus
          value={editing.draft}
          aria-label={t.files.xlsxCellInput}
          spellCheck={false}
          onChange={(event) => props.onDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => props.onCommit("none")}
          onKeyDown={(event) => {
            // 编辑中不翻页、不挪选区：这些键不许冒泡到网格容器
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              props.onCommit("down");
              return;
            }
            if (event.key === "Tab") {
              event.preventDefault();
              props.onCommit("right");
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              props.onCancel();
              return;
            }
            if (event.key === "PageUp" || event.key === "PageDown") {
              // 这两个键在输入框里会把容器滚走；编辑时它们不该有别的意思
              event.preventDefault();
            }
          }}
        />
      ) : (
        <span className="xlsx-cell-text">{display.text}</span>
      )}
    </td>
  );
}

/**
 * 未保存的改动清单：`表名!B2：旧 → 新`，逐条撤回 + 全部撤回。
 * **这里没有保存**：保存只在底栏那一个主操作按钮（两处都放保存 = 同一件事两个入口，
 * 还会各自绑一份 `save`）。清单负责「改了什么、能撤哪一条」。
 */
function XlsxPendingPanel(props: {
  sheetName: string;
  edits: readonly PendingCellEdit[];
  onRemove: (row: number, col: number) => void;
  onClearAll: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  return (
    <section className="xlsx-pending">
      <div className="xlsx-pending-head">
        <button
          type="button"
          className="xlsx-pending-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
          {t.files.xlsxPendingTitle(props.edits.length)}
        </button>
        <span className="row-trailing">
          <PanelButton onClick={props.onClearAll}>
            <Icon name="undo-2" size={12} />
            {t.files.xlsxUndoAll}
          </PanelButton>
        </span>
      </div>
      {open && (
        <ul className="xlsx-pending-list">
          {props.edits.map((item) => (
            <li key={`${item.row}:${item.col}`} className="xlsx-pending-item">
              <span className="xlsx-pending-ref">
                {props.sheetName}!{xlsxColumnLabel(item.col)}
                {item.row + 1}
              </span>
              <span className="xlsx-pending-values" title={`${item.before} → ${item.after}`}>
                {item.before === "" ? "∅" : item.before} → {item.after === "" ? "∅" : item.after}
              </span>
              <span className="row-trailing">
                <button
                  type="button"
                  className="xlsx-pending-remove"
                  title={t.files.xlsxUndoOne}
                  aria-label={t.files.xlsxUndoOne}
                  onClick={() => props.onRemove(item.row, item.col)}
                >
                  <Icon name="undo-2" size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 底部条：状态（未保存 n 处 / 已保存）+ 「与原文件不一样」的几处提示 + 撤销 / 保存。
 *
 * 提示都是「不说用户会误会」的事：可编辑范围（前 2000 行 × 50 列，不是整表）、原文件
 * 冻结了而这里不冻、兼容模式读取、**公式不重算**、文件在外部被改过（保存会被拦）。
 */
function XlsxFooter(props: {
  sheet: XlsxSheet;
  /** 兼容模式读取（去前缀兜底成功） */
  normalized: boolean;
  unsaved: number;
  saved: boolean;
  saving: boolean;
  saveEnabled: boolean;
  formulaNote: boolean;
  externallyChanged: boolean;
  onSave: () => void;
  onUndoAll: () => void;
}) {
  const t = useT();
  const shownRows = props.sheet.rows.length;
  const shownCols = props.sheet.rows[0]?.length ?? 0;
  const truncated = props.sheet.rowCount > shownRows || props.sheet.colCount > shownCols;
  const frozen = props.sheet.frozen;
  const frozenRows = Math.min(frozen.rows, shownRows);
  const frozenCols = Math.min(frozen.cols, shownCols);
  const hasFrozen = frozenRows > 0 || frozenCols > 0;
  return (
    <div className="xlsx-footer">
      <span className="xlsx-status" data-dirty={props.unsaved > 0 ? "true" : undefined}>
        {props.unsaved > 0 ? t.files.xlsxUnsaved(props.unsaved) : props.saved ? t.files.xlsxSaved : ""}
      </span>
      {props.normalized && (
        <span className="xlsx-notice">
          <Icon name="info" size={11} />
          {t.files.xlsxNormalized}
        </span>
      )}
      {truncated && (
        <span className="xlsx-notice">
          {t.files.xlsxTruncated(shownRows, shownCols, props.sheet.rowCount, props.sheet.colCount)}
        </span>
      )}
      {hasFrozen && (
        <span className="xlsx-notice">
          <Icon name="lock" size={11} />
          {t.files.xlsxFrozen(frozenRows, frozenCols)}
        </span>
      )}
      {props.formulaNote && (
        <span className="xlsx-notice" data-tone="warning">
          <Icon name="info" size={11} />
          {t.files.xlsxFormulaNotCalculated}
        </span>
      )}
      {props.externallyChanged && (
        <span className="xlsx-notice" data-tone="warning">
          <Icon name="triangle-alert" size={11} />
          {t.files.xlsxExternalChange}
        </span>
      )}
      <span className="xlsx-footer-actions row-trailing">
        <PanelButton onClick={props.onUndoAll} disabled={props.unsaved === 0 || props.saving}>
          <Icon name="undo-2" size={13} />
          {t.files.xlsxUndoAll}
        </PanelButton>
        <button
          type="button"
          className="btn-accent xlsx-save"
          onClick={props.onSave}
          disabled={!props.saveEnabled}
          title={`${t.files.xlsxSaveAll} · ${t.files.xlsxSaveShortcut}`}
        >
          <Icon name={props.saving ? "loader-circle" : "save"} size={13} spin={props.saving} />
          {t.files.xlsxSave}
        </button>
      </span>
    </div>
  );
}

type XlsxState = {
  /** 最近一次成功的回执：切表 / 刷新期间留着，工具栏与标签因此不会闪掉 */
  data: XlsxPreview | null;
  loading: boolean;
  error: string | null;
};

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * 预览的数据半边：文件 / 表号 / 刷新 token 变就重拉。竞态按 token 丢弃过期响应——
 * 快速连点工作表标签时，后发的先回也只有它落账。
 *
 * **旧数据不清空**：加载期间 `data` 留着上一份回执（`loading: true`），工具栏与表标签
 * 因此一直在；只有第一次打开时 data 才是 null（那时给一行「正在载入…」）。
 */
function useXlsxPreview(request: FileListRequest, sheet: number, reloadToken: number): XlsxState {
  const [state, setState] = useState<XlsxState>({ data: null, loading: true, error: null });
  const token = useRef(0);
  const { sessionId, workspaceId, extraWorkspaceId, root, dir } = request;
  const extra = extraWorkspaceId ?? null;
  useEffect(() => {
    const id = ++token.current;
    setState((prev) => ({ data: prev.data, loading: true, error: null }));
    api.files
      .readXlsx({ sessionId, workspaceId, ...(extra === null ? {} : { extraWorkspaceId: extra }), root, dir, sheet })
      .then((data) => {
        if (token.current === id) setState({ data, loading: false, error: null });
      })
      .catch((cause: unknown) => {
        if (token.current === id) setState((prev) => ({ data: prev.data, loading: false, error: failMessage(cause) }));
      });
  }, [sessionId, workspaceId, extra, root, dir, sheet, reloadToken]);
  return state;
}
