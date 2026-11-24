/**
 * 故事版新手引导「璇玑对接」：全屏覆盖层，三幕十四步。左边是一直亮着的星图——也是**操作面**：
 * 玩家在上面通电、派人出门、放僚机、按顺序点站存成协议；右边是领航员（AI 搭档）的台词、
 * 站内那个功能的真截图、以及这一步要玩家做的事。「下一步」只留给纯对话；有动作的步，做完才放行。
 *
 * 剧本版：台词写死在 messages 的 onboarding.story，不接模型、不调 agent。
 * 剧本推进、动作规则、站点状态全在 story-script.ts（纯函数）；这里只管画与接键盘。
 * 退出 / 跳过 / 看完都走 onClose（调用方写 onboardingSeen）。看完走一段「收拢」动效再 onClose。
 * 键盘：← → 翻页（动作没做完不放行）、Esc 退出、Tab 在站与按钮间走、Enter 确认——每个动作键盘都能做。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { OnboardingStyle, ThemePreference } from "@shared/settings";
import { ONBOARDING_STYLES } from "@shared/settings";
import { Icon } from "../../../shell/Icon";
import { useT } from "../../../locale.ts";
import { Shot } from "../OnboardingShot";
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
  assist,
  canAssist,
  choose,
  effectiveStyle,
  focusStation,
  hintStation,
  initialState,
  isTappable,
  linkedCount,
  needsModelExit,
  nextLabel,
  openOriginal,
  pickReport,
  pressNext,
  pressPrev,
  progressOf,
  shotPage,
  stationStates,
  stepOf,
  styleSwitchable,
  tapStation,
  useDemoSignal,
  wingMoons,
  type ReportId,
  type StationId,
  type StoryState,
} from "./story-script.ts";
import "./story.css";

/** 收拢动效的时长（ms）：与 story.css 的 sv-leave 对齐；用户要求减少动效时直接收尾 */
const LEAVE_MS = 620;

interface OptionCopy {
  label: string;
  after: readonly string[];
}

interface StepCopy {
  said: readonly string[];
  task?: string;
  did?: string;
  after?: readonly string[];
  options?: readonly OptionCopy[];
  tail?: readonly string[];
  solve?: string;
  // 通电
  noModel?: readonly string[];
  ready?: string;
  goSettings?: string;
  useDemo?: string;
  demoAfter?: readonly string[];
  // 派谁出门
  pickWrong?: Record<StationId, string>;
  // 放僚机
  jobs?: readonly string[];
  send?: string;
  sent?: string;
  // 存成协议
  slots?: readonly string[];
  orderWrong?: string;
}

interface Row {
  who: "you" | "pilot";
  text: string;
  key: string;
}

/** 夜空档：两档暗色，以及航行日志（永远走夜空，浅色主题下也是暗底） */
function isDarkTheme(theme: Exclude<ThemePreference, "system">): boolean {
  return theme === "graphite" || theme === "black";
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 站内窗口里要放的截图取景：落地页只框出输入框（手册里那页的三个编号点在这里没有配文，不放） */
function landingPage(): StepPage {
  const composer = SHOT_BOXES.home?.composer;
  return { kind: "step", id: "landing", shot: "home", ...(composer === undefined ? {} : { focus: composer }) };
}

/** 原文：选之前一个字都不高亮；选完（不论对错）才把被引用的那一句标出来 */
function Original(props: { revealed: boolean }) {
  const { text, mark } = GATE_SOURCE;
  const at = text.indexOf(mark);
  if (!props.revealed || at < 0) {
    return (
      <p className="sv-original-text" lang="en">
        {text}
      </p>
    );
  }
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
  /** 玩家有没有可用的模型：通电那一步靠它决定直接通电，还是亮出「现在就去接」 */
  hasProvider: boolean;
  /** 通电那一步的出口：把故事版收起来（不关），去设置 › 模型服务商；回来接着走 */
  onGoProviders: () => void;
  /** 故事版被收起来了（正在设置里接模型）：整层隐藏、不接键盘；窗口底部留一枚「回到故事」 */
  parked: boolean;
  /** 「回到故事」：关掉设置，故事版回来接着走 */
  onResume: () => void;
  /** 测试 / 预览用：从第几步开始 */
  startAt?: number;
}) {
  const t = useT();
  const copy = t.onboarding.story;
  const [state, setState] = useState<StoryState>(() => initialState(props.startAt ?? 0));
  const [leaving, setLeaving] = useState(false);
  /** 动作没做完时按 → / 点灰按钮：任务提示抖一下 */
  const [nudge, setNudge] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLElement | null>(null);
  const { onClose, hasProvider } = props;

  const look = effectiveStyle(props.style, props.theme);
  const night = look === "journal" || isDarkTheme(props.theme);
  const set = night ? "dark" : "light";
  const step = stepOf(state.index);
  const now = progressOf(state);
  const stepCopy = (copy.steps as Record<string, StepCopy>)[step.id];
  const states = useMemo(() => stationStates(state), [state]);
  const linked = linkedCount(state);
  const interactive = props.parked || leaving ? () => false : (id: StationId) => isTappable(state, id);

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
    const current = stateRef.current;
    const result = pressNext(current);
    if (result === "finish") {
      aimLeave();
      setLeaving(true);
    } else if (result === current) setNudge((n) => n + 1);
    else setState(result);
  }, [aimLeave]);
  const prev = useCallback(() => setState((current) => pressPrev(current)), []);
  const tap = useCallback(
    (id: StationId) => setState((current) => tapStation(current, id, { hasProvider })),
    [hasProvider],
  );

  useEffect(() => {
    rootRef.current?.focus();
  }, []);
  useEffect(() => {
    if (props.manualOpen || props.parked || leaving) return;
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
  }, [props.manualOpen, props.parked, leaving, next, prev, onClose]);

  // ---- 对话行 ----
  const rows: Row[] = [];
  const pilot = (lines: readonly string[] | undefined, key: string): void => lines?.forEach((text, i) => rows.push({ who: "pilot", text, key: `${key}${i}` }));
  const you = (text: string | undefined, key: string): void => {
    if (text !== undefined) rows.push({ who: "you", text, key });
  };
  // 辨伪过关之后，「你来核对」那句问话已经有了回答，收掉，台词不把答案挤出窗口
  pilot(step.task?.kind === "gate" && now.done ? stepCopy?.said.slice(0, 1) : stepCopy?.said, "s");
  const options = stepCopy?.options;
  const task = step.task;
  const chose = now.choice !== null && options !== undefined ? options[now.choice] : undefined;
  if (step.id === "power" && now.needsModel && !now.done) pilot(hasProvider ? [stepCopy?.ready ?? ""] : stepCopy?.noModel, "m");
  if (options !== undefined && chose !== undefined) {
    you(chose.label, "c");
    pilot(chose.after, "o");
  }
  if (task !== undefined && task.kind !== "choose" && now.done) {
    you(now.demo ? stepCopy?.useDemo : stepCopy?.did, "d");
    pilot(now.demo ? stepCopy?.demoAfter : stepCopy?.after, "a");
  }
  // 结尾（下一步要登场的功能的麻烦）：回话步一直在；动作步做完才说
  if (stepCopy?.tail !== undefined && (task === undefined || now.done)) pilot(stepCopy.tail, "t");
  // 点错了：领航员解释为什么不是它（不惩罚、可重选）
  if (task?.kind === "pick" && !now.done && now.wrongStation !== null) {
    rows.push({ who: "pilot", text: stepCopy?.pickWrong?.[now.wrongStation] ?? "", key: `w${now.wrong}` });
  }
  if (task?.kind === "sequence" && !now.done && now.wrong > 0) rows.push({ who: "pilot", text: stepCopy?.orderWrong ?? "", key: `w${now.wrong}` });
  if (task?.kind === "gate" && !now.done && now.picked !== null && now.wrong > 0) {
    const lines = copy.gate.wrong;
    rows.push({ who: "pilot", text: lines[(now.wrong - 1) % lines.length] ?? "", key: `w${now.wrong}` });
  }

  // 新行出现时，滚到底（矮窗里台词会长到放不下）
  const rowCount = rows.length;
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene !== null && scene.scrollHeight > scene.clientHeight) scene.scrollTo({ top: scene.scrollHeight });
  }, [rowCount, now.done, now.opened, state.index]);

  const label = nextLabel(state);
  const labelText = label === "wait" ? copy.chrome.wait : label === "finish" ? copy.chrome.finish : copy.chrome.next;
  const about = focusStation(state.index);
  const stationInfo = about === undefined ? undefined : copy.stations[about];
  const place = step.id === "chart" ? copy.places.chart : step.id === "landing" ? copy.places.landing : undefined;
  const head = stationInfo ?? place;
  const headState = about === undefined ? undefined : states[about];
  const page: StepPage | undefined = step.id === "landing" ? landingPage() : shotPage(step.shot);
  const weak = step.id === "wake" || (step.id === "power" && !now.done);
  const showTask = task !== undefined && task.kind !== "choose" && task.kind !== "gate" && !now.done;
  const rootStyle = { "--act": step.act } as CSSProperties;

  return (
    <>
    {props.parked && (
      <button type="button" className="sv-resume btn-accent" onClick={props.onResume}>
        <Icon name="orbit" size={14} />
        {copy.chrome.resume}
      </button>
    )}
    <div
      className="sv"
      role="dialog"
      aria-modal="true"
      aria-label={copy.chrome.label}
      tabIndex={-1}
      ref={rootRef}
      hidden={props.parked}
      data-style={look}
      data-night={night ? "true" : undefined}
      data-theme-preview={look === "journal" && !isDarkTheme(props.theme) ? "black" : undefined}
      data-leaving={leaving ? "true" : undefined}
      data-act={step.act}
      style={rootStyle}
    >
      <div className="sv-drag" aria-hidden="true" />
      <header className="sv-top">
        <div className="sv-brand">
          orbita <span>{copy.title}</span>
        </div>
        <span className="sv-act">{copy.acts[step.act]}</span>
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
            hint={hintStation(state)}
            moons={wingMoons(state)}
            wrongStation={task?.kind === "pick" || task?.kind === "sequence" ? now.wrongStation : null}
            wrongSeq={now.wrong}
            interactive={interactive}
            onTap={tap}
            names={{ stations: copy.stations, stateName: copy.stateName, button: copy.chrome.stationButton }}
            ariaLabel={`${copy.chrome.map}: ${copy.chrome.linked(linked, STATION_IDS.length)}`}
          />
          <p className="sv-count">
            <span className="sv-count-n">{copy.chrome.linked(linked, STATION_IDS.length)}</span>
          </p>
        </section>

        <section className="sv-scene" key={step.id} data-step={step.id} data-gate={task?.kind === "gate" ? "true" : undefined} ref={sceneRef}>
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
                <li key={row.key} className="sv-row" data-who={row.who} data-first={first ? "true" : undefined} style={{ "--d": `${Math.min(i, 5) * 110}ms` } as CSSProperties}>
                  <span className="sv-mark" aria-hidden="true" />
                  <div className="sv-say">
                    {first && <span className="sv-who">{copy.speakers[row.who]}</span>}
                    <p>{row.text}</p>
                  </div>
                </li>
              );
            })}
            {options !== undefined && chose === undefined && (
              <li className="sv-row" data-who="you" data-first="true">
                <span className="sv-mark" aria-hidden="true" />
                <div className="sv-say">
                  <span className="sv-who">{copy.speakers.you}</span>
                  <div className="sv-opts" role="group" aria-label={stepCopy?.task ?? copy.speakers.you}>
                    {options.map((option, i) => (
                      <button key={option.label} type="button" className="sv-opt" onClick={() => setState((current) => choose(current, i))}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </li>
            )}
          </ol>

          {showTask && (
            <div className="sv-task" key={`t${nudge}`} data-nudge={nudge > 0 ? "true" : undefined} data-kind={task.kind}>
              <span className="sv-task-text">{stepCopy?.task}</span>
              {canAssist(state) && (
                <button type="button" className="notice-exit sv-assist" onClick={() => setState((current) => assist(current))}>
                  {copy.chrome.assist}
                </button>
              )}
            </div>
          )}
          {options !== undefined && task?.kind === "choose" && !now.done && canAssist(state) && (
            <p className="sv-task sv-task-quiet">
              <button type="button" className="notice-exit sv-assist" onClick={() => setState((current) => assist(current))}>
                {copy.chrome.assist}
              </button>
            </p>
          )}

          {step.id === "power" && needsModelExit(state) && !hasProvider && (
            <div className="sv-exits">
              <button type="button" className="sv-opt" onClick={props.onGoProviders}>
                {stepCopy?.goSettings}
              </button>
              <button type="button" className="sv-opt" onClick={() => setState((current) => useDemoSignal(current))}>
                {stepCopy?.useDemo}
              </button>
            </div>
          )}

          {task?.kind === "tap" && task.station === "wing" && (
            <ul className="sv-jobs">
              {(stepCopy?.jobs ?? []).map((job, i) => {
                const sent = now.taps > i;
                return (
                  <li key={job} className="sv-job" data-sent={sent ? "true" : undefined}>
                    <span className="sv-job-name">{job}</span>
                    <button type="button" className="sv-opt" disabled={sent || i !== now.taps} onClick={() => tap("wing")}>
                      {sent ? stepCopy?.sent : stepCopy?.send}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {task?.kind === "sequence" && (
            <ol className="sv-slots">
              {(stepCopy?.slots ?? []).map((slot, i) => {
                const filled = now.picks[i];
                return (
                  <li key={slot} className="sv-slot" data-filled={filled !== undefined ? "true" : undefined}>
                    <span className="sv-slot-n">{i + 1}</span>
                    <b>{slot}</b>
                    <em>{filled !== undefined ? copy.stations[filled].name : ""}</em>
                  </li>
                );
              })}
            </ol>
          )}

          {task?.kind === "gate" && <Gate state={state} copy={copy.gate} onOpen={() => setState((s) => openOriginal(s))} onPick={(id) => setState((s) => pickReport(s, id))} />}

          {task?.kind !== "gate" && page !== undefined && head !== undefined && (
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
        <button type="button" className="btn-accent sv-btn" disabled={label === "wait"} onClick={next}>
          {labelText}
          {label === "next" && <Icon name="arrow-right" size={16} />}
        </button>
      </footer>
    </div>
    </>
  );
}

/**
 * 辨伪环节：两条报告 + 原文。没点开原文不能选；选错有反馈（卡片自己标「对得上原文」，图标 + 字）、能重选；
 * 选对后这一站接通。原文选之前不高亮，选完才把被引用的那一句标出来——不泄题。
 */
function Gate(props: {
  state: StoryState;
  copy: ReturnType<typeof useT>["onboarding"]["story"]["gate"];
  onOpen: () => void;
  onPick: (id: ReportId) => void;
}) {
  const { copy, state } = props;
  const now = progressOf(state);
  const open = now.opened;
  const locked = !open;
  const solved = now.done;
  const reports: ReportId[] = ["a", "b"];
  return (
    <div className="sv-gate">
      <div className="sv-reports">
        {reports.map((id) => {
          const data = REPORTS[id];
          const fake = id === FAKE_REPORT;
          const sets = data.datasets.join(copy.join);
          // 选完之后：选错的那张（实为对得上的）立刻亮出「对得上原文」；过关后两张都亮
          const verdict = solved || (now.picked === id && !fake);
          return (
            <article key={id} className="sv-report" data-id={id} data-picked={now.picked === id ? "true" : undefined} data-verdict={verdict ? (fake ? "fake" : "true") : undefined}>
              <h3 className="sv-report-tag">{copy.reportLabel(copy.names[id])}</h3>
              <p className="sv-report-claim">{copy.claim(sets)}</p>
              <p className="sv-report-quote">
                <span className="sv-report-quote-label">{copy.cites}</span>
                <q lang="en">{data.quote}</q>
              </p>
              <div className="sv-report-foot">
                {verdict ? (
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
            <Original revealed={now.picked !== null} />
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
