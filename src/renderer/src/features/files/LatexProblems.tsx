/**
 * 问题抽屉 —— 文件面板底部一行「问题 / 无问题」，点开列出本次编译的问题。
 *
 * 默认收起（安静态只有一行）；用户自己点的编译失败时由 FilesPanel 自动展开——
 * 失败要看得见，但不占常驻高度。每行「文件:行 + 消息」，缺宏包单列一类并给它
 * 自己的动作（在终端安装）；每条都能「交给 agent」（进输入框的引用，不直接发送）。
 * 版式提示（Overfull）默认排最后、退灰：真实论文几乎每篇都有，不该抢错误的视线。
 *
 * 缺宏包这一行**不猜包名**：`x.sty` 的文件名往往不是安装包的名字（`ctexart.cls`
 * 属于 `ctex`），反查由主进程做（kpsewhich / tlmgr / mpm，见 main/latex/packages.ts）。
 * 反查没回来之前只显示文件名；回来且没查到，就明说「未知包」，不给安装按钮——
 * 猜一条装不上的命令比不给更坏。
 */
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import type { LatexIssue, LatexResolvedPackage } from "@shared/latex";
import type { CiteVerification } from "@shared/cite";
import {
  issueLocation,
  packageLabel,
  packageNoteKind,
  type LatexIssueGroups,
  type MissingPackage,
} from "./latex-workbench.ts";

/** 交给 agent 时的分类：决定引用里的前缀文案 */
export type ProblemLevel = "error" | "warning" | "layout" | "package" | "pending" | "verify";

/**
 * 引文核验面板的数据（`cite:verify` 的结局）。**只在用户点「核验」时联网**，
 * 所以这里带着「查过没有 / 查了几条 / 项目里一共几条」，不只给一串结论。
 */
export interface VerifyView {
  running: boolean;
  /** 本次核对的结果（只显示需要人看的：mismatch / not-found / error） */
  rows: readonly CiteVerification[];
  /** 项目里可核验（有 DOI / arXiv 号 / 标题）的条目总数 */
  total: number;
  /** 本次真正核验了几条 */
  checked: number;
  /** 通道失败的一句话；成功时 null */
  error: string | null;
  onRun: () => void;
}

export type ProblemItem = { level: ProblemLevel; file: string | null; line: number | null; message: string };

export function LatexProblems(props: {
  groups: LatexIssueGroups;
  open: boolean;
  onToggle: () => void;
  onHandToAgent: (item: ProblemItem) => void;
  /** 缺文件名 → 反查结果；还在查 / 通道失败时查不到（按「正在反查」显示） */
  resolved: ReadonlyMap<string, LatexResolvedPackage>;
  /**
   * 点一条带文件 / 行号的问题：在编辑器里打开并跳到那一行（没有行号时只打开文件）。
   * 没有文件名的条目（例如「N 份 .bib 没读」）不给这个动作——点了也无处可去。
   */
  onJump: (item: ProblemItem) => void;
  /** 引文核验（项目里没有 .bib 时缺席） */
  verify?: VerifyView;
  /** 把安装命令填进可见终端（不按回车） */
  onInstall: (command: string) => void;
}) {
  const t = useT();
  const { groups } = props;
  const verifyRows = props.verify?.rows ?? [];
  const total =
    groups.errorCount + groups.warningCount + groups.layout.length + groups.pending.length + verifyRows.length;
  /** 没有编译问题也允许打开抽屉：核验文献常常发生在「编译全绿」之后、投稿之前 */
  const openable = total > 0 || props.verify !== undefined;
  const rows: { item: ProblemItem; pkg?: MissingPackage }[] = [
    // 引擎在等用户确认：排在缺包前面——它不是「缺了什么」，是「编译正卡在这里」
    ...groups.pending.map((item) => ({ item: toItem(item, "pending") })),
    ...groups.packages.map((item) => ({ item: toItem(item, "package"), pkg: item })),
    ...groups.errors.map((item) => ({ item: toItem(item, "error") })),
    ...groups.warnings.map((item) => ({ item: toItem(item, "warning") })),
    ...groups.layout.map((item) => ({ item: toItem(item, "layout") })),
  ];

  return (
    <div className="latex-problems" data-open={props.open ? "true" : undefined}>
      <button
        type="button"
        className="latex-problems-head quiet-control"
        aria-expanded={openable ? props.open : undefined}
        disabled={!openable}
        onClick={props.onToggle}
      >
        <Icon name="circle-help" size={14} />
        <span>{t.latex.problems}</span>
        <span className="row-trailing latex-problem-counts">
          {total === 0 ? (
            <>
              <Icon name="circle-check" size={12} style={{ color: "var(--color-success)" }} />
              {t.latex.noProblems}
            </>
          ) : (
            <>
              {groups.errorCount > 0 && (
                <span className="latex-count err">
                  <Icon name="octagon-x" size={12} style={{ color: "var(--color-danger)" }} />
                  {t.latex.errorCount(groups.errorCount)}
                </span>
              )}
              {groups.warningCount > 0 && (
                <span className="latex-count warn">
                  <Icon name="triangle-alert" size={12} style={{ color: "var(--color-warning)" }} />
                  {t.latex.warningCount(groups.warningCount)}
                </span>
              )}
              {groups.pending.length > 0 && (
                <span className="latex-count">
                  <Icon name="clock" size={12} style={{ color: "var(--color-warning)" }} />
                  {t.latex.pendingCount(groups.pending.length)}
                </span>
              )}
              {verifyRows.length > 0 && (
                <span className="latex-count">
                  <Icon name="shield-check" size={12} style={{ color: "var(--color-warning)" }} />
                  {t.citeVerify.unverifiedCount(verifyRows.length)}
                </span>
              )}
              <Icon name={props.open ? "chevron-down" : "chevron-up"} size={12} />
            </>
          )}
        </span>
      </button>
      {props.open && openable && (
        <div className="latex-problem-list">
          {props.verify !== undefined && (
            <VerifySection view={props.verify} onHandToAgent={props.onHandToAgent} />
          )}
          {rows.map(({ item, pkg }) => {
            const resolution = pkg === undefined ? undefined : props.resolved.get(pkg.missing);
            const command = resolution?.command ?? null;
            const label = pkg === undefined ? item.message : t.latex.missingPackage(
              packageLabel(pkg.missing, resolution?.packageName ?? null),
            );
            const note = pkg === undefined ? null : packageNote(pkg, resolution, t);
            return (
              <div
                key={`${item.level}:${item.file ?? ""}:${item.line ?? 0}:${item.message}:${pkg?.missing ?? ""}`}
                className="latex-problem"
                data-level={item.level}
              >
                <Icon name={iconOf(item.level)} size={13} style={{ color: tintOf(item.level) }} />
                {item.file === null ? (
                  <>
                    <span className="latex-problem-loc mono">{issueLocation(item)}</span>
                    <span className="latex-problem-msg" title={item.message}>
                      <span>{item.level === "pending" ? t.latex.engineWaiting : label}</span>
                      {item.level === "pending" && <span className="latex-problem-note">{item.message}</span>}
                      {note !== null && <span className="latex-problem-note">{note}</span>}
                    </span>
                  </>
                ) : (
                  // 有文件的方法行本身是个按钮：点一下就把编辑器切到那一行（与 PDF 双击
                  // 反查用同一条「跳过去并闪一下」的通道）。动作键仍是兄弟节点，不嵌套按钮
                  <button
                    type="button"
                    className="latex-problem-main"
                    title={item.line === null ? item.message : `${issueLocation(item)} · ${item.message}`}
                    onClick={() => props.onJump(item)}
                  >
                    <span className="latex-problem-loc mono">{issueLocation(item)}</span>
                    <span className="latex-problem-msg">
                      <span>{item.level === "pending" ? t.latex.engineWaiting : label}</span>
                      {item.level === "pending" && <span className="latex-problem-note">{item.message}</span>}
                      {note !== null && <span className="latex-problem-note">{note}</span>}
                    </span>
                  </button>
                )}
                <span className="row-trailing latex-problem-acts">
                  {command !== null && (
                    <button
                      type="button"
                      className="quiet-control latex-problem-act"
                      title={t.latex.installTip(command, resolution?.sudo === true)}
                      onClick={() => props.onInstall(command)}
                    >
                      <Icon name="square-terminal" size={12} />
                      {t.latex.installInTerminal}
                    </button>
                  )}
                  <button
                    type="button"
                    className="quiet-control latex-problem-act"
                    title={t.latex.handToAgentTip}
                    onClick={() => props.onHandToAgent(item)}
                  >
                    <Icon name="bot" size={12} />
                    {t.latex.handToAgent}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 缺包行的第二行说明（小号弱色）。原因的分类在 latex-workbench.ts 的
 * `packageNoteKind`（纯函数、有测试），这里只把分类翻成文案。
 */
function packageNote(
  pkg: MissingPackage,
  resolution: LatexResolvedPackage | undefined,
  t: ReturnType<typeof useT>,
): string | null {
  switch (packageNoteKind(resolution)) {
    case "looking-up":
      return t.latex.packageLookingUp;
    case "installed":
      return t.latex.packageAlreadyInstalled;
    case "none":
      return null;
    case "invalid-name":
      return t.latex.packageInvalidName;
    case "no-tools":
      return t.latex.packageNoTool;
    case "tool-error":
      return t.latex.packageToolError;
    case "not-looked-up":
      return t.latex.packageNotLookedUp;
    case "unknown":
      return t.latex.packageUnknown(pkg.missing);
  }
}

function toItem(issue: LatexIssue | MissingPackage, level: ProblemLevel): ProblemItem {
  // MissingPackage 有 message / file / line，与 LatexIssue 同形（多一个 packageName）
  return { level, file: issue.file, line: issue.line, message: issue.message };
}

function iconOf(level: ProblemLevel): "octagon-x" | "triangle-alert" | "download" | "clock" | "info" | "shield-check" {
  if (level === "verify") return "shield-check";
  if (level === "package") return "download";
  if (level === "pending") return "clock";
  if (level === "error") return "octagon-x";
  if (level === "warning") return "triangle-alert";
  return "info";
}

function tintOf(level: ProblemLevel): string {
  if (level === "package" || level === "error") return "var(--color-danger)";
  if (level === "warning" || level === "layout" || level === "pending" || level === "verify") return "var(--color-warning)";
  return "var(--color-text-tertiary)";
}

/**
 * 引文核验一行一块：头部是「查了几条 / 一共几条」与核验按钮，下面只列需要人看的结果
 * （查到的另一篇 / 查不到 / 这次没查成）。**核验通过的条目不占行**——一张问题抽屉不该
 * 因为「87 条都对」变成 87 行。
 */
function VerifySection(props: { view: VerifyView; onHandToAgent: (item: ProblemItem) => void }) {
  const t = useT();
  const { view } = props;
  return (
    <div className="latex-verify">
      <div className="latex-verify-head">
        <Icon name="shield-check" size={13} style={{ color: "var(--color-text-secondary)" }} />
        <span className="latex-verify-title">{t.citeVerify.title}</span>
        <span className="latex-verify-count mono">
          {view.checked > 0 ? t.citeVerify.checked(view.checked, view.total) : t.citeVerify.never}
        </span>
        <span className="row-trailing latex-problem-acts">
          <button
            type="button"
            className="quiet-control latex-problem-act"
            title={t.citeVerify.tip}
            disabled={view.running}
            onClick={view.onRun}
          >
            <Icon name="search-check" size={12} />
            {view.running ? t.citeVerify.running : t.citeVerify.run}
          </button>
        </span>
      </div>
      {view.error !== null && <p className="latex-problem-note">{view.error}</p>}
      {view.rows.map((row) => {
        const message = verificationText(row, t);
        const item: ProblemItem = { level: "verify", file: null, line: null, message: `${row.key} · ${message}` };
        return (
          <div key={`verify:${row.key}:${row.status}`} className="latex-problem" data-level="verify">
            <Icon name="shield-check" size={13} style={{ color: tintOf("verify") }} />
            <span className="latex-problem-loc mono">{row.key}</span>
            <span className="latex-problem-msg" title={message}>
              {message}
            </span>
            <span className="row-trailing latex-problem-acts">
              <button
                type="button"
                className="quiet-control latex-problem-act"
                title={t.latex.handToAgentTip}
                onClick={() => props.onHandToAgent(item)}
              >
                <Icon name="bot" size={12} />
                {t.latex.handToAgent}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 一条核验结果该说什么：原因（not-found / mismatch / 网络失败）分别成句 */
function verificationText(row: CiteVerification, t: ReturnType<typeof useT>): string {
  switch (row.status) {
    case "mismatch":
      return t.citeVerify.mismatch(row.found?.title ?? "");
    case "error":
      return t.citeVerify.error(reasonLabel(row.reason, t));
    case "verified":
      return t.citeVerify.verified;
    case "skipped":
      return t.citeVerify.skipped;
    case "not-found":
      return row.identifier === null
        ? t.citeVerify.notFoundNoIdentifier
        : t.citeVerify.notFound(row.identifier.kind, row.identifier.value);
  }
}

/** 失败原因 → 一句话（与在线检索面板同一套措辞） */
function reasonLabel(reason: CiteVerification["reason"], t: ReturnType<typeof useT>): string {
  switch (reason) {
    case "timeout":
      return t.citeSearch.timeout;
    case "offline":
      return t.citeSearch.offline;
    case "rate-limited":
      return t.citeSearch.rateLimited;
    default:
      return t.citeSearch.notFound;
  }
}
