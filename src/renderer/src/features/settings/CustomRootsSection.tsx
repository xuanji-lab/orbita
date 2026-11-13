import { useState } from "react";
import type { ImportCustomRoot, ImportCustomRootInvalidReason } from "@shared/import";
import { IMPORT_CUSTOM_ROOT_INVALID_CODE } from "@shared/import";
import { api } from "../../api";
import { Chip } from "../../shell/Chip";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { abbreviateHome } from "./display-format.ts";
import { useT } from "../../locale.ts";

/**
 * 外部来源页的自定义数据目录：自动发现漏掉的散落目录（备份、改过名的旧目录），用户选来源、
 * 粘路径（或开目录选择框），经该来源的检查（聊天记录在不在）后加进来——read_task 与技能 / MCP
 * 的扫描都会读它。行尾可移除（目录本身永不被碰）。原住在迁移页里，导入入口退场后搬到这里。
 */

/** 自定义路径支持的来源（= 有定位规格的那批；agent-skills 是单一共用目录，不支持） */
const CUSTOM_ROOT_SOURCES = [
  "proma",
  "claude-code",
  "kimi-code",
  "opencode",
  "reasonix",
  "zcode",
  "codex",
] as const satisfies readonly ImportCustomRoot["source"][];

/**
 * 主进程错误文本里的稳定码 → 添加失败原因；不认识的码返回 null（照原文显示）。
 * 用 indexOf 而不是 startsWith：Electron 会把 IPC 拒绝包成
 * "Error invoking remote method '…': Error: IMPORT_CUSTOM_ROOT_INVALID:not-found"，
 * 码不在开头而在中段
 */
function customRootInvalidOf(text: string): ImportCustomRootInvalidReason | null {
  const at = text.indexOf(IMPORT_CUSTOM_ROOT_INVALID_CODE);
  if (at < 0) return null;
  const reason = text.slice(at + IMPORT_CUSTOM_ROOT_INVALID_CODE.length).match(/^[a-z-]+/)?.[0] ?? "";
  return reason === "not-found" || reason === "no-data" || reason === "duplicate" ? reason : null;
}

/** 自定义路径的添加 / 删除状态：null = 没在报错 */
type CustomRootError = { reason: ImportCustomRootInvalidReason | null; message: string };

export function CustomRootsSection(props: {
  roots: readonly ImportCustomRoot[];
  home: string;
  disabled: boolean;
  /** 添加 / 移除之后：重探（父组件刷新 detect） */
  onChanged: () => void;
}) {
  const t = useT();
  const [source, setSource] = useState<ImportCustomRoot["source"]>("proma");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CustomRootError | null>(null);
  const locked = props.disabled || busy;

  const add = (): void => {
    const dir = path.trim();
    if (dir === "" || locked) return;
    setBusy(true);
    setError(null);
    void api.import
      .addCustomRoot({ source, dir })
      .then(() => {
        setPath("");
        props.onChanged();
      })
      .catch((cause: unknown) => {
        const message = errorText(cause);
        setError({ reason: customRootInvalidOf(message), message });
      })
      .finally(() => setBusy(false));
  };

  const remove = (root: ImportCustomRoot): void => {
    if (locked) return;
    setBusy(true);
    setError(null);
    void api.import
      .removeCustomRoot({ source: root.source, dir: root.dir })
      .then(props.onChanged)
      .catch((cause: unknown) => setError({ reason: null, message: errorText(cause) }))
      .finally(() => setBusy(false));
  };

  const pick = (): void => {
    if (locked) return;
    // 取消返回 null：不动已粘的路径
    void api.import.pickDirectory().then((picked) => {
      if (picked !== null) setPath(picked);
    });
  };

  return (
    <div className="mg-custom">
      <p className="mg-caption mg-caption-lead">
        <Icon name="folder-plus" size={12} strokeWidth={1.8} />
        {t.migration.customRootsNote}
      </p>
      <div className="mg-block">
        {props.roots.map((root) => (
          <div className="mg-custom-row" key={`${root.source}:${root.dir}`} aria-label={t.migration.customRootsAddedFor(t.migration.sources[root.source])}>
            <Icon name="folder" size={12} strokeWidth={1.8} />
            <span className="mg-custom-src">{t.migration.sources[root.source]}</span>
            <span className="mg-custom-path" title={root.dir}>
              {abbreviateHome(root.dir, props.home)}
            </span>
            <button
              type="button"
              className="quiet-control mg-custom-x row-trailing"
              aria-label={t.migration.customRootsRemove}
              title={t.migration.customRootsRemoveTip}
              disabled={locked}
              onClick={() => remove(root)}
            >
              <Icon name="x" size={12} strokeWidth={1.8} />
            </button>
          </div>
        ))}
        <form
          className="mg-custom-form"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Menu
            items={CUSTOM_ROOT_SOURCES.map((id): MenuItem => ({
              id,
              label: t.migration.sources[id],
              checked: id === source,
              onSelect: () => setSource(id),
            }))}
            trigger={({ open, toggle }) => (
              <Chip active={open} chevron disabled={locked} title={t.migration.customRootsSourceLabel} onClick={toggle}>
                {t.migration.sources[source]}
              </Chip>
            )}
          />
          <input
            className="text-field mg-custom-field"
            aria-label={t.migration.customRootsPathLabel}
            spellCheck={false}
            placeholder={t.migration.customRootsPathPlaceholder}
            value={path}
            disabled={locked}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="button" className="quiet-control mg-btn" disabled={locked} onClick={pick}>
            <Icon name="folder-open" size={12} strokeWidth={1.8} />
            {t.migration.customRootsBrowse}
          </button>
          <button
            type="submit"
            className="quiet-control mg-btn"
            disabled={locked || path.trim() === ""}
            title={path.trim() === "" ? t.migration.customRootsPathPlaceholder : undefined}
          >
            <Icon name={busy ? "loader-circle" : "plus"} size={12} spin={busy} strokeWidth={1.8} />
            {busy ? t.migration.customRootsAdding : t.migration.customRootsAdd}
          </button>
        </form>
      </div>
      {error !== null && (
        <p className="mg-caption mg-error" role="alert">
          <Icon name="triangle-alert" size={12} />
          {error.reason !== null ? (
            t.migration.customRootsInvalid[error.reason]
          ) : (
            <>
              {t.migration.customRootsAddFailed} {error.message}
            </>
          )}
        </p>
      )}
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
