/**
 * 论文工作台的编译条 —— 住在文件面板标签行下方，只在该文件属于 LaTeX 项目时出现。
 *
 * 一条横条放几件事（原型场景 1 / 3）：
 *   编译入口（root）· 引擎 · 编译（PDF 过期时才是 accent 主按钮）· 动作 · 状态行
 * 状态行的优先级：编译中 > 失败 > 脏 > 成功 > 安静。主操作一屏只有一个：
 * 只有 dirty 态用 `.btn-accent`；其余态是安静控件（状态优先用图标与文字，颜色第二信号）。
 *
 * **编译入口 chip**（2026-11 多 root）：项目里只有一个 root 时它是静态文本（不画
 * 成菜单）；多个时列出 `roots[]`，每项带它的产物目录，选中会写 activeRoot 并立刻
 * 编那一份。magic 决定的那一份在文案里说清「由 ch1.tex:1 声明」——不然用户会以为
 * 界面在瞎猜。
 *
 * 事实全由 useLatexWorkbench 给（项目、探测、上一次结局、编译中进度）；这里只画，不读盘。
 */
import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { Chip } from "../../shell/Chip";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import type {
  LatexBuildProgress,
  LatexEngine,
  LatexProjectInfo,
  LatexProbeResult,
} from "@shared/latex";
import type { Messages } from "../../messages-en.ts";
import {
  compileErrorKind,
  engineLabel,
  formatDuration,
  formatElapsed,
  shortcutLabel,
  type LatexBarState,
} from "./latex-workbench.ts";
import type { LatexBuildSummary } from "./useLatexWorkbench.ts";

export function LatexBuildBar(props: {
  project: LatexProjectInfo;
  probe: LatexProbeResult | null;
  state: LatexBarState;
  last: LatexBuildSummary | null;
  /**
   * 编译**没能开始**的原因（IPC 抛错 / outcome.ok=false）：一条人话。
   * 有它时状态行优先说这句话——静默的「点了没反应」是 2026-11-16 的现场 bug。
   */
  error: string | null;
  /** 这一轮开始的时刻（编译中计时） */
  startedAt: number | null;
  /** 编译中的进度（跑了哪一轮）；主进程没有信号时 step 为 null */
  progress: LatexBuildProgress | null;
  /** 清理辅助文件在跑（菜单项置灰，不让连点两次） */
  cleaning: boolean;
  onCompile: () => void;
  onCancel: () => void;
  onClean: () => void;
  onToggleCompileOnSave: (on: boolean) => void;
  onSelectEngine: (engine: LatexEngine) => void;
  /** 切到另一个 root（写 activeRoot 并编它） */
  onSelectRoot: (path: string) => void;
  /** 在文件面板里打开这次构建的 .log（「完整日志」入口） */
  onOpenLog: (path: string) => void;
  /** 在系统文件管理器里显示产物目录 */
  onRevealDir: (dir: string) => void;
}) {
  const t = useT();
  const { project, probe, state, last } = props;
  const shortcut = shortcutLabel(api.platform);
  const running = state === "running";

  // 编译中的秒表：只在 running 时走；startedAt 变（新一轮）自然重置
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || props.startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [running, props.startedAt]);

  const engines = probe?.ok === true ? probe.engines : [];
  const engineItems: MenuItem[] = engines.map((engine) => ({
    id: engine,
    label: engineLabel(engine),
    checked: engine === project.engine,
    onSelect: () => props.onSelectEngine(engine),
  }));
  /** 自定义 recipe 时引擎 chip 不可点：真正跑的是用户的命令，换引擎不会让它变 */
  const recipe = project.configured.recipe;

  const activeRoot = project.roots.find((root) => root.path === project.activeRoot) ?? null;
  const multiRoot = project.roots.length > 1;
  const rootItems: MenuItem[] = project.roots.map((root) => ({
    id: root.path,
    label: root.path,
    hint:
      root.declaredBy !== null
        ? t.latex.declaredBy(root.declaredBy.file, root.declaredBy.line)
        : root.outDirRelative,
    hintEllipsis: "head",
    checked: root.path === project.activeRoot,
    onSelect: () => props.onSelectRoot(root.path),
  }));
  // 标签用 activeRoot（相对项目目录）：root 在子目录时比裸文件名更能说清「编的是哪份」
  const rootName = project.activeRoot ?? project.main;
  const rootLabel =
    rootName === null
      ? t.latex.noMain
      : activeRoot?.declaredBy !== null && activeRoot?.declaredBy !== undefined
        ? `${rootName} · ${t.latex.declaredBy(activeRoot.declaredBy.file, activeRoot.declaredBy.line)}`
        : rootName;
  const rootTitle =
    activeRoot === null
      ? t.latex.noMainTip
      : multiRoot
        ? t.latex.rootTip(project.roots.length, activeRoot.outDirRelative)
        : t.latex.rootOnlyOne;

  /** 这一次构建写出的产物数（>1 才在状态区显示；单个是噪音） */
  const outputCount = last?.outputs.length ?? 0;
  const outputDir = activeRoot?.outDir ?? null;

  /**
   * 项目动作菜单。只放「不属于每一次编译、但属于这个项目」的动作：清理辅助文件
   * （想马上一次干净重编）、打开产物目录 / 完整日志，以及保存即编译（一个长期开关）。
   * 在编时清理置灰：那组 .aux 正被 latexmk 读写，主进程也会 same-project 拒掉。
   */
  const actionItems: MenuItem[] = [
    {
      id: "compile-on-save",
      label: t.latex.compileOnSave,
      hint: t.latex.compileOnSaveHint,
      icon: "zap",
      checked: project.compileOnSave,
      // 不关菜单：开关的后果就在这一行里，关掉反而看不到「它现在到底是开还是关」
      keepOpen: true,
      onSelect: () => props.onToggleCompileOnSave(!project.compileOnSave),
    },
    {
      id: "outputs",
      label: t.latex.openOutputs,
      hint: activeRoot?.outDirRelative ?? "",
      icon: "folder-open",
      disabled: outputDir === null,
      onSelect: () => {
        if (outputDir !== null) props.onRevealDir(outputDir);
      },
    },
    {
      id: "log",
      label: t.latex.openLog,
      hint: last?.logPath === null || last?.logPath === undefined ? t.latex.openLogMissing : "",
      hintEllipsis: "head",
      icon: "file-text",
      disabled: last?.logPath === null || last?.logPath === undefined,
      onSelect: () => {
        if (last?.logPath !== null && last?.logPath !== undefined) props.onOpenLog(last.logPath);
      },
    },
    {
      id: "clean",
      label: t.latex.clean,
      hint: props.cleaning ? t.latex.cleaning : t.latex.cleanHint,
      icon: "trash-2",
      disabled: running || props.cleaning,
      onSelect: props.onClean,
    },
  ];

  return (
    <div className="latex-bar" role="toolbar" aria-label={t.latex.aria}>
      {/* 编译入口：先「编什么」，再「怎么编」（与 LatexRootRef 的字段顺序一致） */}
      {multiRoot ? (
        <Menu
          items={rootItems}
          panelMinWidth={220}
          trigger={({ toggle }) => (
            <Chip icon="file-code-2" chevron onClick={toggle} title={rootTitle}>
              {rootLabel}
            </Chip>
          )}
        />
      ) : (
        <Chip icon="file-code-2" title={rootTitle}>
          {rootLabel}
        </Chip>
      )}
      {recipe === undefined ? (
        <Menu
          items={engineItems}
          panelMinWidth={150}
          trigger={({ toggle }) => (
            <Chip
              icon="cpu"
              chevron
              onClick={toggle}
              disabled={engineItems.length === 0}
              title={probe?.ok === true ? t.latex.engineTip : (probe?.message ?? t.latex.engineTip)}
            >
              {engineLabel(project.engine)}
            </Chip>
          )}
        />
      ) : (
        <Chip icon="terminal" title={recipe.join(" ")}>
          {t.latex.customRecipe}
        </Chip>
      )}

      {running ? (
        <button
          type="button"
          className="quiet-control latex-compile"
          onClick={props.onCancel}
          title={t.latex.cancelTip}
        >
          <Icon name="square" size={12} />
          {t.latex.cancel}
        </button>
      ) : (
        <button
          type="button"
          className={`latex-compile ${state === "dirty" ? "btn-accent" : "quiet-control"}`}
          onClick={props.onCompile}
          title={t.latex.compileTip(shortcut)}
          disabled={state === "error" && last?.status === "not-installed"}
        >
          <Icon name="play" size={12} />
          {t.latex.compile}
        </button>
      )}

      <Menu
        items={actionItems}
        panelMinWidth={240}
        trigger={({ toggle }) => (
          <button
            type="button"
            className="quiet-control latex-actions"
            onClick={toggle}
            title={t.latex.actionsTip}
            aria-label={t.latex.actionsTip}
          >
            <Icon name="ellipsis-vertical" size={14} />
          </button>
        )}
      />

      {/* 多个产物时才出现：一份 PDF 是常态，写「1 个产物」是噪音 */}
      {outputCount > 1 && (
        <button
          type="button"
          className="quiet-control latex-outputs"
          title={t.latex.outputsTip}
          onClick={() => {
            if (outputDir !== null) props.onRevealDir(outputDir);
          }}
        >
          <Icon name="layers" size={12} />
          {t.latex.outputs(outputCount)}
        </button>
      )}

      {/* 行尾血线：状态行才是尾元素；动作菜单在它左边，不抢右缘 */}
      <span className="latex-status row-trailing">
        {statusOf({
          state,
          last,
          project,
          startedAt: props.startedAt,
          now,
          t,
          error: props.error,
          progress: props.progress,
        })}
      </span>
    </div>
  );
}

/** 状态行：图标 + 文字；PDF 是旧版时补一句它的生成时间（失败不白屏） */
function statusOf(input: {
  state: LatexBarState;
  last: LatexBuildSummary | null;
  project: LatexProjectInfo;
  startedAt: number | null;
  now: number;
  t: Messages;
  error: string | null;
  progress: LatexBuildProgress | null;
}): React.ReactNode {
  const { state, last, project, t } = input;
  // 编译没能开始（IPC 抛错 / 主进程回 ok=false）：**先说话**。这一支原先不存在，
  // 于是「invalid session id」这类失败在界面上完全静默（点了没反应）。
  if (input.error !== null) {
    const kind = compileErrorKind(input.error);
    return (
      <>
        <Icon name="octagon-x" size={12} style={{ color: "var(--color-danger)" }} />
        <span title={input.error}>
          {kind === "session" ? t.latex.noSession : t.latex.notStarted(input.error)}
        </span>
      </>
    );
  }
  if (state === "running") {
    const elapsed = input.startedAt === null ? "0:00" : formatElapsed(input.now - input.startedAt);
    const step = stepLabel(input.progress, t);
    return (
      <>
        <Icon name="loader-circle" size={12} spin />
        {step === null ? t.latex.running(elapsed) : t.latex.runningStep(step, elapsed)}
      </>
    );
  }
  if (state === "error" && last !== null) {
    if (last.status === "not-installed") {
      return (
        <>
          <Icon name="octagon-x" size={12} style={{ color: "var(--color-danger)" }} />
          {t.latex.notInstalled}
        </>
      );
    }
    if (last.status === "no-main-file") {
      return (
        <>
          <Icon name="octagon-x" size={12} style={{ color: "var(--color-danger)" }} />
          {t.latex.noMainFile}
        </>
      );
    }
    if (last.status === "root-outside-workspace") {
      return (
        <>
          <Icon name="octagon-x" size={12} style={{ color: "var(--color-danger)" }} />
          {t.latex.rootOutside}
        </>
      );
    }
    const errors = errorCountOf(last);
    return (
      <>
        <Icon name="octagon-x" size={12} style={{ color: "var(--color-danger)" }} />
        {errors === 0
          ? t.latex.failedShort(formatDuration(last.durationMs))
          : t.latex.failed(t.latex.errorCount(errors), formatDuration(last.durationMs))}
        {project.pdf !== null && (
          <span className="latex-status-note">
            {" · "}
            {t.latex.stalePdf(t.time.dateTime(project.pdf.modifiedAt))}
          </span>
        )}
      </>
    );
  }
  if (last?.status === "cancelled") {
    return (
      <>
        <Icon name="octagon-x" size={12} />
        {t.latex.cancelled}
      </>
    );
  }
  if (state === "dirty") {
    return (
      <>
        <Icon name="circle-dot" size={12} style={{ color: "var(--color-warning)" }} />
        {t.latex.dirty}
      </>
    );
  }
  if (state === "success" && last !== null) {
    return (
      <>
        <Icon name="circle-check" size={12} style={{ color: "var(--color-success)" }} />
        {last.pages === null
          ? t.latex.successNoPages(formatDuration(last.durationMs))
          : t.latex.success(last.pages, formatDuration(last.durationMs))}
      </>
    );
  }
  return project.pdf === null ? (
    <>{t.latex.idleNoPdf}</>
  ) : (
    <>
      <Icon name="circle-check" size={12} style={{ color: "var(--color-success)" }} />
      {t.latex.idleUpToDate}
    </>
  );
}

/** `xelatex · 第 2 轮`；没有 run 时只报 step，没有信号时 null（退回「编译中…」） */
function stepLabel(progress: LatexBuildProgress | null, t: Messages): string | null {
  if (progress === null || progress.step === null) return null;
  const step = engineLabel(progress.step);
  return progress.run === null ? step : t.latex.stepRun(step, progress.run);
}

/** 失败摘要里的错误条数（含缺宏包；与问题抽屉的计数同口径） */
function errorCountOf(last: LatexBuildSummary): number {
  if (last.status !== "compile-error" && last.status !== "timeout") return 0;
  return last.errors.length;
}
