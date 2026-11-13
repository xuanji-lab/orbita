/**
 * 论文工作台的编译条 —— 住在文件面板标签行下方，只在该文件属于 LaTeX 项目时出现。
 *
 * 一条横条放四件事（原型场景 1 / 3）：
 *   引擎 chip · 主文件 chip · 编译（PDF 过期时才是 accent 主按钮）· 状态行
 * 状态行的优先级：编译中 > 失败 > 脏 > 成功 > 安静。主操作一屏只有一个：
 * 只有 dirty 态用 `.btn-accent`；其余态是安静控件（状态优先用图标与文字，颜色第二信号）。
 *
 * 事实全由 useLatexWorkbench 给（项目、探测、上一次结局）；这里只画，不读盘。
 */
import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { Chip } from "../../shell/Chip";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import type { LatexEngine, LatexProjectInfo, LatexProbeResult } from "@shared/latex";
import type { Messages } from "../../messages-en.ts";
import {
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
  /** 这一轮开始的时刻（编译中计时） */
  startedAt: number | null;
  /** 清理辅助文件在跑（菜单项置灰，不让连点两次） */
  cleaning: boolean;
  onCompile: () => void;
  onCancel: () => void;
  onClean: () => void;
  onToggleCompileOnSave: (on: boolean) => void;
  onSelectEngine: (engine: LatexEngine) => void;
  onSelectMain: (main: string) => void;
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
  const mainItems: MenuItem[] = project.mains.map((main) => ({
    id: main,
    label: main,
    checked: main === project.main,
    onSelect: () => props.onSelectMain(main),
  }));
  /**
   * 项目动作菜单。只放「不属于每一次编译、但属于这个项目」的动作：清理辅助文件
   * （想马上一次干净重编）与保存即编译（一个长期开关）。
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
      <Menu
        items={mainItems}
        panelMinWidth={170}
        trigger={({ toggle }) => (
          <Chip
            icon="file-code-2"
            chevron
            onClick={toggle}
            disabled={mainItems.length === 0}
            title={t.latex.mainTip}
          >
            {project.main ?? t.latex.noMain}
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
        panelMinWidth={210}
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

      {/* 行尾血线：状态行才是尾元素；动作菜单在它左边，不抢右缘 */}
      <span className="latex-status row-trailing">
        {statusOf({ state, last, project, startedAt: props.startedAt, now, t })}
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
}): React.ReactNode {
  const { state, last, project, t } = input;
  if (state === "running") {
    const elapsed = input.startedAt === null ? "0:00" : formatElapsed(input.now - input.startedAt);
    return (
      <>
        <Icon name="loader-circle" size={12} spin />
        {t.latex.running(elapsed)}
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

/** 失败摘要里的错误条数（含缺宏包；与问题抽屉的计数同口径） */
function errorCountOf(last: LatexBuildSummary): number {
  if (last.status !== "compile-error" && last.status !== "timeout") return 0;
  return last.errors.length;
}
