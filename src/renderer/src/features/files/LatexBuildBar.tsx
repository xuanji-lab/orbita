/**
 * 论文工作台的编译条 —— 住在文件面板标签行下方，只在该文件属于 LaTeX 项目时出现。
 *
 * 一条横条放几件事（原型场景 1 / 3）：
 *   编译入口（root）· 配方（9 条预设）· 编译（PDF 过期时才是 accent 主按钮）· 动作 · 状态行
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
  LatexProjectInfo,
} from "@shared/latex";
import { LATEX_RECIPE_GROUPS, LATEX_RECIPE_PRESETS, latexRecipePreset } from "@shared/latex-recipes";
import type { Messages } from "../../messages-en.ts";
import {
  compileErrorKind,
  currentRecipeId,
  dirOfFile,
  engineLabel,
  formatDuration,
  formatElapsed,
  shortcutLabel,
  type LatexBarState,
} from "./latex-workbench.ts";
import type { LatexBuildSummary } from "./useLatexWorkbench.ts";

export function LatexBuildBar(props: {
  project: LatexProjectInfo;
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
  /** 这条配方能不能清理（latexmk 系才行；手写链 / 单次编译为 false） */
  cleanable: boolean;
  /** 有没有开着的 PDF 标签（决定动作菜单里是「打开 PDF」还是「收起 PDF」） */
  pdfOpen: boolean;
  onCompile: () => void;
  onCancel: () => void;
  onClean: () => void;
  onToggleCompileOnSave: (on: boolean) => void;
  /** 选一条配方预设（写当前 root 的 recipeId） */
  onSelectRecipe: (id: string) => void;
  /** 打开 / 收起 PDF 标签（与标签条里的 PDF 标签同一个开关：菜单只是键盘可达的入口） */
  onTogglePdf: () => void;
  /** 切到另一个 root（写 activeRoot 并编它） */
  onSelectRoot: (path: string) => void;
  /** 在文件面板里打开这次构建的 .log（「完整日志」入口） */
  onOpenLog: (path: string) => void;
  /** 在系统文件管理器里显示产物目录 */
  onRevealDir: (dir: string) => void;
}) {
  const t = useT();
  const { project, state, last } = props;
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

  /**
   * 配方 chip（2026-11 用户裁决：引擎 chip 升级为配方 chip）。
   *
   * 显示的是**这一轮真正会跑的那条链**：选了预设就显示预设名（`latexmk · xelatex`），
   * 手写了 recipe 就说「自定义配方」，都没写就说默认链 `latexmk · <引擎>`（它等价于
   * 推荐组里同引擎那条，菜单里也据此打勾）。
   */
  const recipe = project.configured.recipe;
  const activeRecipeId = currentRecipeId({
    recipeId: project.configured.recipeId,
    recipe,
    engine: project.engine,
  });
  const activePreset = latexRecipePreset(activeRecipeId);
  const recipeLabel =
    activePreset !== null ? activePreset.label : recipe !== undefined ? t.latex.customRecipe : `latexmk · ${engineLabel(project.engine)}`;

  /** 9 条预设按分组排（组头不可选；推荐项带一个小字标记） */
  const recipeItems: MenuItem[] = [];
  for (const group of LATEX_RECIPE_GROUPS) {
    const presets = LATEX_RECIPE_PRESETS.filter((preset) => preset.group === group);
    if (presets.length === 0) continue;
    recipeItems.push({ id: `head:${group}`, label: t.latex.recipeGroups[group], header: true });
    for (const preset of presets) {
      recipeItems.push({
        id: preset.id,
        label: preset.label,
        checked: preset.id === activeRecipeId,
        ...(preset.recommended === true
          ? { badge: <span className="latex-recipe-badge">{t.latex.recipeRecommended}</span> }
          : {}),
        ...(preset.engine === null
          ? { hint: t.latex.recipeSingleHint(engineLabel(project.engine)) }
          : {}),
        onSelect: () => props.onSelectRecipe(preset.id),
      });
    }
  }

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
  /**
   * 产物目录：**回执 v2 的 outputs[] 是真源**（primary 在哪就是哪），配置里的
   * outDir 只是没有产物时的兜底——自定义 recipe / 改过 jobname 时两者可能不同。
   */
  const outputDir =
    dirOfFile(last?.outputs.find((output) => output.primary)?.path ?? last?.outputs[0]?.path ?? null) ??
    activeRoot?.outDir ??
    null;

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
      // 日志是上一轮留下的就说出来——拿旧日志冒充这一次的事实比不显示更糟
      hint:
        last?.logPath === null || last?.logPath === undefined
          ? t.latex.openLogMissing
          : last.logFresh === false
            ? t.latex.logStaleHint(t.time.dateTime(last.logModifiedAt ?? Date.now()))
            : "",
      hintEllipsis: "head",
      icon: "file-text",
      disabled: last?.logPath === null || last?.logPath === undefined,
      onSelect: () => {
        if (last?.logPath !== null && last?.logPath !== undefined) props.onOpenLog(last.logPath);
      },
    },
    {
      id: "pdf",
      label: props.pdfOpen ? t.latex.closePdf : t.latex.openPdf,
      hint: project.pdf === null ? t.latex.openLogMissing : "",
      icon: "file-text",
      checked: props.pdfOpen,
      disabled: project.pdf === null,
      onSelect: props.onTogglePdf,
    },
    {
      id: "clean",
      label: t.latex.clean,
      hint: !props.cleanable
        ? t.latex.cleanUnavailable
        : props.cleaning
          ? t.latex.cleaning
          : t.latex.cleanHint,
      icon: "trash-2",
      disabled: running || props.cleaning || !props.cleanable,
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
      {/* 配方 chip：9 条预设按分组（推荐 / 索引 / 术语表 / 手写链 / 调试 / 特殊）。
          当前那条打勾；自定义 recipe 时 chip 说「自定义配方」，菜单仍可换回预设 */}
      <Menu
        items={recipeItems}
        panelMinWidth={280}
        panelMaxWidth={420}
        trigger={({ toggle }) => (
          <Chip
            icon={recipe === undefined || activePreset !== null ? "list" : "terminal"}
            chevron
            onClick={toggle}
            title={recipe !== undefined ? recipe.join(" ") : t.latex.recipeTip}
          >
            {recipeLabel}
          </Chip>
        )}
      />

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
        {logStaleNote(last, t) !== null && <span className="latex-status-note">{" · "}{logStaleNote(last, t)}</span>}
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
        {logStaleNote(last, t) !== null && <span className="latex-status-note">{" · "}{logStaleNote(last, t)}</span>}
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

/**
 * 「日志是上一轮留下的」那一句（回执 v2 的 log.fresh === false）；本次有日志且新鲜时 null。
 * 没有日志时也不说——那时该说的是「还没有日志」，由日志入口负责。
 */
function logStaleNote(last: LatexBuildSummary, t: Messages): string | null {
  return last.logPath !== null && last.logFresh === false ? t.latex.logStaleNote : null;
}

/** 失败摘要里的错误条数（含缺宏包；与问题抽屉的计数同口径） */
function errorCountOf(last: LatexBuildSummary): number {
  if (last.status !== "compile-error" && last.status !== "timeout") return 0;
  return last.errors.length;
}
