/**
 * 故事版新手引导「璇玑对接」：全屏覆盖层，三幕十五步。左边是一直亮着的星图，右边是领航员（AI 搭档）
 * 的台词、站内那个功能的真截图、以及辨伪环节。主按钮写的是剧情动作（「接上电源」「派出僚机」），
 * 按它或按 → 都是同一件事：往下走一步，被接通的那座站在星图上亮起来。
 *
 * 剧本版：台词写死在 messages 的 onboarding.story，不接模型、不调 agent。
 * 剧本推进、站点状态、辨伪规则全在 story-script.ts（纯函数）；这里只管画与接键盘。
 * 退出 / 跳过 / 看完都走 onClose（调用方写 onboardingSeen）。看完走一段「收拢」动效再 onClose。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { OnboardingStyle, ThemePreference } from "@shared/settings";
import { ONBOARDING_STYLES } from "@shared/settings";
import { Icon } from "../../../shell/Icon";
import { useT } from "../../../locale.ts";
import { Shot } from "../OnboardingShot";
import { shotTheme } from "../onboarding-nav.ts";
import type { StepPage } from "../onboarding-pages.ts";
import { SHOT_BOXES } from "../shot-boxes.ts";
import { StarMap } from "./StarMap";
import {
  FAKE_REPORT,
  GATE_SOURCE,
  REPORTS,
  STATION_IDS,
  STEPS,
  STEP_COUNT,
  effectiveStyle,
  focusStation,
  initialState,
  linkedCount,
  nextLabel,
  openOriginal,
  pickReport,
  pressNext,
  pressPrev,
  shotPage,
  stationStates,
  stepOf,
  styleSwitchable,
  type ReportId,
  type StationId,
  type StoryState,
} from "./story-script.ts";
import "./story.css";

/** 收拢动效的时长（ms）：与 story.css 的 sv-leave 对齐；用户要求减少动效时直接收尾 */
const LEAVE_MS = 620;

interface StepCopy {
  you?: string;
  said: readonly string[];
  solve?: string;
  cue?: string;
  solvedBy?: readonly string[];
  solvedByPilot?: readonly string[];
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 站内窗口里要放的截图取景：落地页只框出输入框（手册里那页的三个编号点在这里没有配文，不放） */
function landingPage(): StepPage {
  const composer = SHOT_BOXES.home?.composer;
  return { kind: "step", id: "landing", shot: "home", ...(composer === undefined ? {} : { focus: composer }) };
}

function Original() {
  const { text, mark } = GATE_SOURCE;
  const at = text.indexOf(mark);
  return (
    <p className="sv-original-text" lang="en">
      {text.slice(0, at)}
      <mark>{mark}</mark>
      {text.slice(at + mark.length)}
    </p>
  );
}

export function StoryView(props: {
  theme: Exclude<ThemePreference, "system">;
  style: OnboardingStyle | undefined;
  onStyle: (style: OnboardingStyle) => void;
  /** 跳过 / Esc / 看完：都记为看过（调用方写设置） */
  onClose: () => void;
  /** 右上「手册」：打开原来的 13 章 */
  onOpenManual: () => void;
  /** 手册盖在上面时，故事版不接键盘 */
  manualOpen: boolean;
  /** 通电那一步的出口：关掉引导，去设置 › 模型服务商 */
  onOpenProviders: () => void;
  /** 测试 / 预览用：从第几步开始 */
  startAt?: number;
}) {
  const t = useT();
  const copy = t.onboarding.story;
  const [state, setState] = useState<StoryState>(() => initialState(props.startAt ?? 0));
  const [leaving, setLeaving] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { onClose } = props;

  const look = effectiveStyle(props.style, props.theme);
  const set = shotTheme(props.theme);
  const step = stepOf(state.index);
  const stepCopy = (copy.steps as Record<string, StepCopy>)[step.id];
  const states = useMemo(() => stationStates(state), [state]);
  const linked = linkedCount(state);

  // 收拢结束后才真正关掉（leaving 时不再接键）
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onClose, prefersReducedMotion() ? 0 : LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onClose]);

  /** 收拢的去向：星座折成领航站那一颗星，落到底下首页输入框的左上角（「我就在这儿」）；找不到输入框就原地收 */
  const aimLeave = useCallback(() => {
    const root = rootRef.current;
    const map = root?.querySelector(".sv-map");
    const input = document.querySelector(".composer-input");
    if (root === null || root === undefined || map === null || map === undefined || input === null) return;
    const from = map.getBoundingClientRect();
    const to = input.getBoundingClientRect();
    root.style.setProperty("--leave-x", `${Math.round(to.left + 14 - (from.left + from.width / 2))}px`);
    root.style.setProperty("--leave-y", `${Math.round(to.top + 18 - (from.top + from.height / 2))}px`);
  }, []);
  const next = useCallback(() => {
    const result = pressNext(stateRef.current);
    if (result === "finish") {
      aimLeave();
      setLeaving(true);
    } else setState(result);
  }, [aimLeave]);
  const prev = useCallback(() => setState((current) => pressPrev(current)), []);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);
  useEffect(() => {
    if (props.manualOpen || leaving) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        prev();
      }
    };
    // 捕获阶段：引导盖在一切之上，底下的输入框 / 设置页不该先接到 Esc
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props.manualOpen, leaving, next, prev, onClose]);

  const label = nextLabel(state);
  const labelText =
    label === "cue"
      ? (stepCopy?.cue ?? copy.chrome.next)
      : label === "gateOpen"
      ? copy.gate.openOriginal
      : label === "gatePilot"
      ? copy.gate.askPilot
      : label === "finish"
      ? copy.chrome.finish
      : copy.chrome.next;

  const about: StationId | undefined = focusStation(state.index);
  const stationInfo = about === undefined ? undefined : copy.stations[about];
  const place = step.id === "chart" ? copy.places.chart : step.id === "landing" ? copy.places.landing : undefined;
  const head = stationInfo ?? place;
  const headState = about === undefined ? undefined : states[about];
  const page: StepPage | undefined = step.id === "landing" ? landingPage() : shotPage(step.shot);

  // 对话：你上一步做的事（空心圆）→ 领航员的台词（实心圆 + 刻度）
  const rows: { who: "you" | "pilot"; text: string; key: string }[] = [];
  if (stepCopy?.you !== undefined) rows.push({ who: "you", text: stepCopy.you, key: "you" });
  // 辨伪过关之后，「你来核对」那句问话已经有了回答，收掉，台词不把答案挤出窗口
  const said = step.gate === true && state.gate.solved ? (stepCopy?.said.slice(0, 1) ?? []) : (stepCopy?.said ?? []);
  said.forEach((line, i) => rows.push({ who: "pilot", text: line, key: `p${i}` }));
  if (step.gate === true) {
    if (state.gate.solved) {
      const after = state.gate.byPilot ? stepCopy?.solvedByPilot : stepCopy?.solvedBy;
      after?.forEach((line, i) => rows.push({ who: "pilot", text: line, key: `s${i}` }));
    } else if (state.gate.wrong > 0) {
      const lines = copy.gate.wrong;
      rows.push({ who: "pilot", text: lines[(state.gate.wrong - 1) % lines.length] ?? "", key: `w${state.gate.wrong}` });
    }
  }
  const weak = step.id === "wake" || step.id === "power";

  const rootStyle = { "--act": step.act } as CSSProperties;
  const chapterLabel = copy.acts[step.act];

  return (
    <div
      className="sv"
      role="dialog"
      aria-modal="true"
      aria-label={copy.chrome.label}
      tabIndex={-1}
      ref={rootRef}
      data-style={look}
      data-leaving={leaving ? "true" : undefined}
      data-act={step.act}
      style={rootStyle}
    >
      <div className="sv-drag" aria-hidden="true" />
      <header className="sv-top">
        <div className="sv-brand">
          orbita <span>{copy.title}</span>
        </div>
        <span className="sv-act">{chapterLabel}</span>
        <div className="sv-tools">
          {styleSwitchable(props.theme) && (
            <div className="sv-looks" role="radiogroup" aria-label={copy.chrome.styleLabel}>
              {ONBOARDING_STYLES.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={look === id}
                  title={copy.chrome.styles[id].hint}
                  className="sv-look"
                  onClick={() => props.onStyle(id)}
                >
                  {copy.chrome.styles[id].name}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="sv-tool" title={copy.chrome.manualTitle} onClick={props.onOpenManual}>
            <Icon name="book-open" size={14} />
            {copy.chrome.manual}
          </button>
          <button type="button" className="sv-tool" onClick={onClose}>
            {copy.chrome.skip}
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>

      <div className="sv-body">
        <section className="sv-mapcol" aria-label={copy.chrome.map}>
          <StarMap
            style={look}
            state={state}
            focus={about}
            names={{ stations: copy.stations, stateName: copy.stateName }}
            ariaLabel={`${copy.chrome.map}: ${copy.chrome.linked(linked, STATION_IDS.length)}`}
          />
          <p className="sv-count">
            <span className="sv-count-n">{copy.chrome.linked(linked, STATION_IDS.length)}</span>
          </p>
        </section>

        <section className="sv-scene" key={step.id} data-step={step.id} data-gate={step.gate === true ? "true" : undefined}>
          {state.index === 0 && (
            <div className="sv-intro">
              <h1 className="sv-title">{copy.title}</h1>
              <p className="sv-lede">{copy.lede}</p>
            </div>
          )}

          <ol className="sv-log" data-weak={weak ? "true" : undefined}>
            {rows.map((row, i) => {
              const first = i === 0 || rows[i - 1]?.who !== row.who;
              return (
                <li key={row.key} className="sv-row" data-who={row.who} data-first={first ? "true" : undefined} style={{ "--d": `${i * 130}ms` } as CSSProperties}>
                  <span className="sv-mark" aria-hidden="true" />
                  <div className="sv-say">
                    {first && <span className="sv-who">{copy.speakers[row.who]}</span>}
                    <p>{row.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>

          {step.exitToProviders === true && (
            <p className="sv-exit">
              <button type="button" className="notice-exit sv-exit-btn" onClick={props.onOpenProviders}>
                {copy.exitToProviders}
              </button>
            </p>
          )}

          {step.gate === true && <Gate state={state} copy={copy.gate} onOpen={() => setState((s) => openOriginal(s))} onPick={(id) => setState((s) => pickReport(s, id))} />}

          {step.gate !== true && page !== undefined && head !== undefined && (
            <figure className="sv-win" data-state={headState}>
              <figcaption className="sv-win-head">
                <span className="sv-win-name">{head.name}</span>
                <span className="sv-win-feature">{head.feature}</span>
                {headState !== undefined && <span className="sv-win-state">{copy.stateName[headState]}</span>}
              </figcaption>
              <div className="sv-win-shot">
                <Shot page={page} set={set} alt={head.name} />
              </div>
              {stepCopy?.solve !== undefined && (
                <p className="sv-solve">
                  <span className="sv-solve-label">{copy.solves}</span>
                  {stepCopy.solve}
                </p>
              )}
            </figure>
          )}
        </section>
      </div>

      <footer className="sv-bar">
        <span className="sv-segs" aria-hidden="true">
          {STEPS.map((each, i) => (
            <i key={each.id} data-act={each.act} data-state={i < state.index ? "done" : i === state.index ? "on" : undefined} data-start={i > 0 && STEPS[i - 1]?.act !== each.act ? "true" : undefined} />
          ))}
        </span>
        <span className="sv-where">{copy.chrome.step(state.index + 1, STEP_COUNT)}</span>
        <span className="sv-keys">{copy.chrome.keys}</span>
        <button type="button" className="quiet-control sv-btn sv-btn-ghost" disabled={state.index === 0} onClick={prev}>
          <Icon name="arrow-left" size={16} />
          {copy.chrome.prev}
        </button>
        <button type="button" className="btn-accent sv-btn" onClick={next}>
          {labelText}
          {label !== "finish" && <Icon name="arrow-right" size={16} />}
        </button>
      </footer>
    </div>
  );
}

/** 辨伪环节：两条报告 + 原文。没点开原文不能选；选错有反馈、能重选；选对（或领航员替选）后这一站接通 */
function Gate(props: {
  state: StoryState;
  copy: ReturnType<typeof useT>["onboarding"]["story"]["gate"];
  onOpen: () => void;
  onPick: (id: ReportId) => void;
}) {
  const { copy, state } = props;
  const open = state.gate.opened;
  const locked = !open;
  const solved = state.gate.solved;
  const reports: ReportId[] = ["a", "b"];
  return (
    <div className="sv-gate">
      <div className="sv-reports">
        {reports.map((id) => {
          const data = REPORTS[id];
          const fake = id === FAKE_REPORT;
          const sets = data.datasets.join(copy.join);
          const claim = id === "a" ? copy.claimA(sets) : copy.claimB(sets);
          const chosen = state.gate.picked === id;
          return (
            <article key={id} className="sv-report" data-id={id} data-picked={chosen ? "true" : undefined} data-verdict={solved ? (fake ? "fake" : "true") : undefined}>
              <h3 className="sv-report-tag">{copy.reportLabel(copy.names[id])}</h3>
              <p className="sv-report-claim">{claim}</p>
              <p className="sv-report-quote">
                <span className="sv-report-quote-label">{copy.cites}</span>
                <q lang="en">{data.quote}</q>
              </p>
              <div className="sv-report-foot">
                {solved ? (
                  <span className="sv-verdict" data-fake={fake ? "true" : undefined}>
                    <Icon name={fake ? "triangle-alert" : "circle-check"} size={14} />
                    {fake ? copy.mismatch : copy.matches}
                  </span>
                ) : (
                  <button type="button" className="sv-pick" disabled={locked} title={locked ? copy.pickLocked : undefined} onClick={() => props.onPick(id)}>
                    {locked ? copy.pickLocked : copy.pick}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <div className="sv-original" data-open={open ? "true" : undefined}>
        {open ? (
          <>
            <div className="sv-original-head">
              <b>{copy.originalHead}</b>
              <span>{copy.originalSrc(GATE_SOURCE.file, GATE_SOURCE.page, GATE_SOURCE.section)}</span>
            </div>
            <Original />
          </>
        ) : (
          <button type="button" className="sv-original-open" onClick={props.onOpen}>
            <Icon name="file-text" size={14} />
            {copy.openOriginal}
            <span className="sv-original-hint">{copy.hint}</span>
          </button>
        )}
      </div>
    </div>
  );
}
