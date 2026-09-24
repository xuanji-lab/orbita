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
      .scan({ sources: ["proma"] })
      .then((report) => setState({ kind: "report", report }))
      .catch((cause: unknown) =>
        setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) }),
      );
  }, []);

  const run = useCallback(
    (report: ImportScanReport) => {
      setState({ kind: "importing", report });
      // 这一行是「全部导入」的旧入口：勾选全部可选条目、去向全用默认（Migration 页替代它之前的过渡）
      const ids = new Set(report.plan.map((item) => item.sessionId));
      const sessions = report.plan
        .filter((item) => item.parentId === null || !ids.has(item.parentId))
        .map((item) => item.sourceFile);
      void api.import
        .run({ sources: ["proma"], sessions, destinations: [] })
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
            Copies this machine's Proma sessions into orbita — pi-native ones as-is, Claude Code-era ones converted — resumable, self-contained, read-only on the Proma side.
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
          : "No importable sessions found (sessions in older formats without a convertible transcript are out of scope here)."}
      </SummaryLine>
    );
  }
  // TASKS 只数根会话：子会话跟着母会话走，不进左栏，数进来会把 TASKS 说大
  const tasks = report.plan.filter((item) => item.workspaceId === null && item.parentId === null).length;
  const parts = [
    `${tasks} to TASKS`,
    report.subSessionCount > 0
      ? `${report.subSessionCount} ${report.subSessionCount === 1 ? "sub-session" : "sub-sessions"} nested under ${report.subSessionCount === 1 ? "its parent" : "their parents"}`
      : null,
    // 母会话导不了、只好按根会话导的子会话：不该发生，发生了要让人看见（它们会出现在左栏）
    report.orphanedSubSessions > 0
      ? `${report.orphanedSubSessions} ${report.orphanedSubSessions === 1 ? "sub-session" : "sub-sessions"} without an importable parent, imported as top-level`
      : null,
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
    report.withoutPiSession > 0 ? `${report.withoutPiSession} in older formats` : null,
    report.skipped.filter((s) => s.reason === "missing-file").length > 0
      ? `${report.skipped.filter((s) => s.reason === "missing-file").length} missing file`
      : null,
    report.skipped.filter(
      (s) =>
        s.reason === "bad-session-file" ||
        s.reason === "bad-index-entry" ||
        s.reason === "unsupported-format",
    ).length > 0
      ? `${report.skipped.filter(
          (s) =>
            s.reason === "bad-session-file" ||
            s.reason === "bad-index-entry" ||
            s.reason === "unsupported-format",
        ).length} unconvertible`
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
  const disabled = props.disabled === true;
  return (
    <button
      type="button"
      className="btn-accent import-primary-btn"
      disabled={disabled}
      onClick={props.onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        border: 0,
        borderRadius: "var(--radius-md)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        whiteSpace: "nowrap",
      }}
    >
      <Icon name={props.icon} size={12} spin={props.spin} />
      {props.children}
    </button>
  );
}

/** 次要动作（Rescan / Scan again / Retry）：中性，不与主操作抢色。 */
function SecondaryButton(props: { icon: IconName; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  const disabled = props.disabled === true;
  return (
    <button
      type="button"
      className="quiet-control import-secondary-btn"
      disabled={disabled}
      onClick={props.onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        border: 0,
        borderRadius: "var(--radius-md)",
        boxShadow: "inset 0 0 0 1px var(--color-border-subtle)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        whiteSpace: "nowrap",
        // 局部覆盖：这里禁用是 default 光标，不是安静控件默认的 not-allowed
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <Icon name={props.icon} size={12} />
      {props.children}
    </button>
  );
}
