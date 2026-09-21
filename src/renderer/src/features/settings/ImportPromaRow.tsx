import { useCallback, useState } from "react";
import type { ImportRunReport, ImportScanReport } from "@shared/import";
import { api } from "../../api";
import { Icon, type IconName } from "../../shell/Icon";

/**
 * 设置页 General 的「Import from Proma」行——pi 同构导入器的唯一入口。
 *
 * 流程是「扫描 → 看汇总 → 确认 → 执行 → 报告」五步，本组件就是这台小状态机；
 * 执行在主进程（重新扫描后落盘，见 shared/import.ts），这里只驱动与呈现。
 * 导入完成调 onImported：主界面的会话列表与工作区列表此刻已经变了，
 * 不刷新的话用户要退出设置页再进来才看得到新会话。
 */

type ImportState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "report"; report: ImportScanReport }
  | { kind: "importing"; report: ImportScanReport }
  | { kind: "done"; result: ImportRunReport }
  | { kind: "error"; message: string };

/** 字节数 → 人读的体量。导入是 1.2GB 级的事，用户需要知道要复制多少进盘。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ImportPromaRow(props: { onImported: () => void }) {
  const [state, setState] = useState<ImportState>({ kind: "idle" });

  const scan = useCallback(() => {
    setState({ kind: "scanning" });
    void api.import
      .scan()
      .then((report) => setState({ kind: "report", report }))
      .catch((cause: unknown) =>
        setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) }),
      );
  }, []);

  const run = useCallback(
    (report: ImportScanReport) => {
      setState({ kind: "importing", report });
      void api.import
        .run()
        .then((result) => {
          setState({ kind: "done", result });
          // 落了新会话 / 新工作区：主界面两张列表都要重读
          props.onImported();
        })
        .catch((cause: unknown) =>
          setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) }),
        );
    },
    [props],
  );

  return (
    <div
      style={{
        display: "grid",
        gap: "var(--space-3)",
        padding: "var(--space-3) 0",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-4)" }}>
        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: "var(--font-size-control)", fontWeight: "var(--weight-medium)" }}>
            Import from Proma
          </span>
          <span
            style={{
              fontSize: "var(--font-size-caption)",
              lineHeight: "var(--line-height-caption)",
              color: "var(--color-text-secondary)",
            }}
          >
            Copies this machine's Proma sessions that have a pi session file into orbita — resumable, self-contained, read-only on the Proma side.
          </span>
        </span>
        <span style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
          {state.kind === "idle" && (
            <PrimaryButton icon="download" onClick={scan}>
              Scan
            </PrimaryButton>
          )}
          {state.kind === "scanning" && (
            <PrimaryButton icon="loader-circle" disabled spin>
              Scanning…
            </PrimaryButton>
          )}
          {state.kind === "report" && (
            <>
              <SecondaryButton icon="refresh-cw" onClick={scan}>
                Rescan
              </SecondaryButton>
              {state.report.plan.length > 0 && (
                <PrimaryButton icon="download" onClick={() => run(state.report)}>
                  Import {state.report.plan.length} {state.report.plan.length === 1 ? "session" : "sessions"}
                </PrimaryButton>
              )}
            </>
          )}
          {state.kind === "importing" && (
            <PrimaryButton icon="loader-circle" disabled spin>
              Importing…
            </PrimaryButton>
          )}
          {state.kind === "done" && (
            <SecondaryButton icon="refresh-cw" onClick={scan}>
              Scan again
            </SecondaryButton>
          )}
          {state.kind === "error" && (
            <SecondaryButton icon="refresh-cw" onClick={scan}>
              Retry
            </SecondaryButton>
          )}
        </span>
      </div>
      {state.kind === "report" && <ScanSummary report={state.report} />}
      {state.kind === "done" && <RunSummary result={state.result} />}
      {state.kind === "error" && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--font-size-caption)",
            lineHeight: "var(--line-height-caption)",
            color: "var(--color-text-secondary)",
            wordBreak: "break-word",
          }}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}

/** 扫描汇总：可导多少、去哪、跳过多少、体量与模型兜底——确认前的全部决策信息。 */
function ScanSummary(props: { report: ImportScanReport }) {
  const { report } = props;
  if (report.plan.length === 0) {
    return (
      <SummaryLine>
        {report.skipped.some((s) => s.reason === "already-imported")
          ? "Everything importable is already imported."
          : "No importable sessions found (sessions without a pi source — older formats — are out of scope here)."}
      </SummaryLine>
    );
  }
  const tasks = report.plan.filter((item) => item.workspaceId === null).length;
  const parts = [
    `${tasks} to TASKS`,
    report.mergedWorkspaceIds.length > 0
      ? `${report.mergedWorkspaceIds.length} existing ${report.mergedWorkspaceIds.length === 1 ? "workspace" : "workspaces"} matched by path`
      : null,
    report.newWorkspaces.length > 0 ? `${report.newWorkspaces.length} new ${report.newWorkspaces.length === 1 ? "workspace" : "workspaces"}` : null,
    report.modelFallbackCount > 0 ? `${report.modelFallbackCount} fall back to the default model` : null,
    `≈ ${formatBytes(report.totalBytes)} copied`,
  ].filter((part): part is string => part !== null);
  const alreadyImported = report.skipped.filter((s) => s.reason === "already-imported").length;
  const skippedParts = [
    alreadyImported > 0 ? `${alreadyImported} already imported` : null,
    report.withoutPiSession > 0 ? `${report.withoutPiSession} without a pi source` : null,
    report.skipped.filter((s) => s.reason === "missing-file").length > 0
      ? `${report.skipped.filter((s) => s.reason === "missing-file").length} missing file`
      : null,
    report.skipped.filter((s) => s.reason === "bad-session-file" || s.reason === "bad-index-entry").length > 0
      ? `${report.skipped.filter((s) => s.reason === "bad-session-file" || s.reason === "bad-index-entry").length} unreadable`
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <SummaryLine>
      {parts.join(" · ")}
      {skippedParts.length > 0 ? ` — skipped: ${skippedParts.join(", ")}` : ""}
    </SummaryLine>
  );
}

/** 执行报告：实际导入 / 跳过 / 失败明细（失败的 sourceId + 原因，给人排障）。 */
function RunSummary(props: { result: ImportRunReport }) {
  const { result } = props;
  const head =
    result.failed.length > 0
      ? `Imported ${result.imported}, skipped ${result.skipped}, ${result.failed.length} failed.`
      : `Imported ${result.imported}${result.skipped > 0 ? `, skipped ${result.skipped}` : ""}.`;
  return (
    <div style={{ display: "grid", gap: "var(--space-1)" }}>
      <SummaryLine>{head}</SummaryLine>
      {result.failed.slice(0, 5).map((item) => (
        <SummaryLine key={item.sourceId}>
          {item.sourceId}: {item.error}
        </SummaryLine>
      ))}
      {result.failed.length > 5 && <SummaryLine>… and {result.failed.length - 5} more</SummaryLine>}
    </div>
  );
}

function SummaryLine(props: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: "var(--font-size-caption)",
        lineHeight: "var(--line-height-caption)",
        color: "var(--color-text-secondary)",
        wordBreak: "break-word",
      }}
    >
      {props.children}
    </p>
  );
}

/** accent 只给主操作：Scan / Import（一屏一个 accent，设计系统的硬规则）。 */
function PrimaryButton(props: {
  icon: IconName;
  disabled?: boolean;
  spin?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const disabled = props.disabled === true;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        border: 0,
        borderRadius: "var(--radius-md)",
        background: disabled ? "var(--color-accent)" : hover ? "var(--color-accent-strong)" : "var(--color-accent)",
        color: "var(--color-accent-fg)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        whiteSpace: "nowrap",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: "var(--transition-hover)",
      }}
    >
      <Icon name={props.icon} size={12} spin={props.spin} />
      {props.children}
    </button>
  );
}

/** 次要动作（Rescan / Scan again / Retry）：中性，不与主操作抢色。 */
function SecondaryButton(props: { icon: IconName; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  const disabled = props.disabled === true;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        border: 0,
        borderRadius: "var(--radius-md)",
        background: hover && !disabled ? "var(--option-hover-bg)" : "transparent",
        boxShadow: "inset 0 0 0 1px var(--color-border-subtle)",
        color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        whiteSpace: "nowrap",
        cursor: disabled ? "default" : "pointer",
        transition: "var(--transition-hover)",
      }}
    >
      <Icon name={props.icon} size={12} />
      {props.children}
    </button>
  );
}
