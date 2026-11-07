/// <reference types="vite/client" />
/**
 * 新手引导：盖住整个窗口的全屏覆盖层（不是首页卡片）。左侧一整列目录（当前章展开页名，
 * 点章名跳章），右边是这一页（章首页 / 步骤页 / 常见问题），底部分段进度 + 上一页 / 下一页。
 * ← → 翻页，Esc 退出；右上「跳过引导」。看完（最后一页点「看完了」）、跳过、Esc 都算看过。
 *
 * 版式照用户认可的原型（plugin-design/onboarding-v2 的 page-a / page-b2 / page-c）：
 * 纸色底、宋体（品牌衬线）标题、截图压暗 + 框出一块 + 编号点 + 放大镜、右侧配文编号对应。
 * 页的内容全在数据表（onboarding-pages.ts）与文案（messages 的 onboarding），这里只管画。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ThemePreference } from "@shared/settings";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { GUIDE, type Box, type GuideChapter, type GuidePage, type Loupe, type Pin, type ShotId, type StepPage } from "./onboarding-pages.ts";
import {
  boldRuns,
  chapterNumber,
  chapterProgress,
  chapterStart,
  flattenGuide,
  isLastPage,
  shotTheme,
  stepGuide,
} from "./onboarding-nav.ts";
import "./onboarding.css";

/** 截图随应用打包：shots/<light|dark>/<id>.webp → 构建后的资源地址 */
const SHOT_URLS = import.meta.glob("./shots/*/*.webp", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

function shotUrl(set: "light" | "dark", id: ShotId): string | undefined {
  return SHOT_URLS[`./shots/${set}/${id}.webp`];
}

/** 截图的宽高比（拍图统一 1440×900） */
const SHOT_RATIO = 1440 / 900;

type GuideCopy = Messages["onboarding"];
type ChapterCopy = GuideCopy["chapters"][keyof GuideCopy["chapters"]];
type PageCopy = { name: string; title: string; body: string; notes?: readonly string[]; say?: string };

function chapterCopy(copy: GuideCopy, chapter: GuideChapter): ChapterCopy {
  return copy.chapters[chapter.id];
}

function pageCopy(copy: GuideCopy, chapter: GuideChapter, page: GuidePage): PageCopy | undefined {
  const pages = chapterCopy(copy, chapter).pages as Record<string, PageCopy | undefined>;
  return pages[page.id];
}

function Rich(props: { text: string }) {
  return (
    <>
      {boldRuns(props.text).map((run, index) => (run.bold ? <b key={index}>{run.text}</b> : <span key={index}>{run.text}</span>))}
    </>
  );
}

const pct = (value: number): string => `${(value * 100).toFixed(3)}%`;

function boxStyle(box: Box): CSSProperties {
  return { left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) };
}

/** edge：放大镜里的编号点，只取 x，竖向骑在放大镜上边框上（见 .ob-pin-edge），不压住放大的字 */
function PinMark(props: { pin: Pin; edge?: boolean }) {
  const style: CSSProperties = props.edge === true ? { left: pct(props.pin.x) } : { left: pct(props.pin.x), top: pct(props.pin.y) };
  return (
    <span className={props.edge === true ? "ob-pin ob-pin-edge" : "ob-pin"} style={style} aria-hidden="true">
      {props.pin.n}
    </span>
  );
}

/** 放大镜：同一张截图，背景按比例放大到 from 那一块 */
function LoupeView(props: { loupe: Loupe; url: string | undefined }) {
  const { from, at, scale } = props.loupe;
  const style: CSSProperties = {
    left: pct(at.x),
    top: pct(at.y),
    width: pct(from.w * scale),
    aspectRatio: `${from.w * SHOT_RATIO} / ${from.h}`,
    backgroundImage: props.url === undefined ? undefined : `url("${props.url}")`,
    backgroundSize: `${(100 / from.w).toFixed(3)}% auto`,
    backgroundPosition: `${from.w >= 1 ? 0 : ((from.x / (1 - from.w)) * 100).toFixed(3)}% ${from.h >= 1 ? 0 : ((from.y / (1 - from.h)) * 100).toFixed(3)}%`,
  };
  return (
    <div className="ob-loupe" style={style} aria-hidden="true">
      {props.loupe.pins?.map((pin) => <PinMark key={`l${pin.n}-${pin.x}`} pin={pin} edge />)}
    </div>
  );
}

/** 截图框：压暗 + 框出 focus + 编号点 + 放大镜 */
function Shot(props: { page: { shot: ShotId } & Partial<Pick<StepPage, "focus" | "pins" | "loupe">>; set: "light" | "dark"; alt: string }) {
  const url = shotUrl(props.set, props.page.shot);
  const { focus, pins, loupe } = props.page;
  return (
    <div className="ob-figure">
      <div className="ob-frame">
        <div className="ob-win">
          {url === undefined ? <div className="ob-win-missing" /> : <img src={url} alt={props.alt} draggable={false} />}
          {focus !== undefined && <div className="ob-spot" style={boxStyle(focus)} />}
        </div>
        {pins?.map((pin) => <PinMark key={`${pin.n}-${pin.x}-${pin.y}`} pin={pin} />)}
        {loupe !== undefined && <LoupeView loupe={loupe} url={url} />}
      </div>
    </div>
  );
}

export function OnboardingView(props: {
  theme: Exclude<ThemePreference, "system">;
  /** 跳过 / Esc / 看完：都记为看过（调用方写设置） */
  onClose: () => void;
  /** 「放进输入框试试」：关掉引导，把这句话放进输入框 */
  onTry: (text: string) => void;
  /** 测试 / 预览用：从第几页开始（缺席 = 第一页） */
  startAt?: number;
}) {
  const t = useT();
  const copy = t.onboarding;
  const chapters = GUIDE;
  const flat = useMemo(() => flattenGuide(chapters), [chapters]);
  const [index, setIndex] = useState(() => stepGuide(props.startAt ?? 0, 0, flat.length));
  const set = shotTheme(props.theme);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { onClose } = props;

  const position = flat[index] ?? { chapter: 0, page: 0 };
  const chapter = chapters[position.chapter] ?? chapters[0];
  const page = chapter?.pages[position.page];
  const last = isLastPage(index, flat.length);

  const go = useCallback((delta: number) => setIndex((current) => stepGuide(current, delta, flat.length)), [flat.length]);
  const next = useCallback(() => {
    if (isLastPage(index, flat.length)) onClose();
    else go(1);
  }, [index, flat.length, go, onClose]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);
  useEffect(() => {
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
        go(-1);
      }
    };
    // 捕获阶段：引导盖在一切之上，底下的界面（输入框的 Esc、设置页的 Esc）不该先接到
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [next, go, onClose]);

  if (chapter === undefined || page === undefined) return null;
  const chCopy = chapterCopy(copy, chapter);
  const progress = chapterProgress(chapters, position);
  const pCopy = pageCopy(copy, chapter, page);
  const stepNames = chapter.pages.filter((each) => each.kind !== "opener").map((each) => pageCopy(copy, chapter, each)?.name ?? "");
  const chapterNo = (ci: number): string => chapterNumber(chapters, ci);
  /** 句子里的章号不补零（「第 11 章」「第 1 章」）；目录与章首页的大号才补成两位 */
  const chapterNum = String(position.chapter + 1);
  const where =
    page.kind === "faq"
      ? copy.kickerFaq(progress.current + 1, progress.segments)
      : page.kind === "opener"
      ? copy.whereOpener(chapterNum, chCopy.name)
      : copy.where(chapterNum, chCopy.name, progress.current + 1, progress.segments);

  return (
    <div className="ob" role="dialog" aria-modal="true" aria-label={copy.title} tabIndex={-1} ref={rootRef}>
      <div className="ob-drag" aria-hidden="true" />
      <nav className="ob-spine" aria-label={copy.toc}>
        <div className="ob-brand">
          orbita <span>{copy.title}</span>
        </div>
        {(["basics", "tools", "appendix"] as const).map((part) => (
          <div key={part} className="ob-part">
            <div className="ob-part-name">{copy.parts[part].name}</div>
            {chapters.map((each, ci) =>
              each.part !== part ? null : (
                <div key={each.id}>
                  <button
                    type="button"
                    className="ob-ch"
                    aria-current={ci === position.chapter ? "true" : undefined}
                    onClick={() => setIndex(chapterStart(flat, ci, index))}
                  >
                    <span className="ob-ch-no">{chapterNo(ci)}</span>
                    <span>{chapterCopy(copy, each).name}</span>
                  </button>
                  {ci === position.chapter && stepNames.length > 0 && (
                    <div className="ob-sub">
                      {chapter.pages.map((each2, pi) =>
                        each2.kind === "opener" ? null : (
                          <button
                            type="button"
                            key={each2.id}
                            className="ob-pg"
                            data-state={pi === position.page ? "on" : pi < position.page ? "done" : undefined}
                            onClick={() => setIndex(chapterStart(flat, ci, index) + pi)}
                          >
                            {pageCopy(copy, chapter, each2)?.name}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
        ))}
      </nav>
      <div className="ob-main">
        <button type="button" className="ob-skip" onClick={onClose}>
          {copy.skip}
          <Icon name="x" size={14} />
        </button>
        <div className="ob-stage" key={index} data-kind={page.kind}>
          {page.kind === "opener" ? (
            <>
              <Shot page={page} set={set} alt={chCopy.name} />
              <div className="ob-copy">
                <div className="ob-kicker">
                  {copy.parts[chapter.part].name}
                  <b>{chapterNo(position.chapter)}</b>
                  <span>· {copy.parts[chapter.part].tagline}</span>
                </div>
                <h1 className="ob-display">{chCopy.name}</h1>
                <p className="ob-lead">
                  <Rich text={chCopy.lead} />
                </p>
                <ol className="ob-toc">
                  {stepNames.map((name, i) => (
                    <li key={name}>
                      <span>{i + 1}</span>
                      {name}
                    </li>
                  ))}
                </ol>
                <p className="ob-case">{chCopy.case}</p>
              </div>
            </>
          ) : page.kind === "step" && pCopy !== undefined ? (
            <>
              <Shot page={page} set={set} alt={pCopy.title} />
              <div className="ob-copy">
                <div className="ob-kicker">{copy.kickerStep(chapterNum, progress.current + 1, progress.segments)}</div>
                <h2 className="ob-title">{pCopy.title}</h2>
                <p className="ob-lead">
                  <Rich text={pCopy.body} />
                </p>
                {pCopy.notes?.map((note, i) => (
                  <div key={note} className="ob-note">
                    <span className="ob-pin ob-pin-inline" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span>
                      <Rich text={note} />
                    </span>
                  </div>
                ))}
                {page.say === true && pCopy.say !== undefined && (
                  <div className="ob-try">
                    <span className="ob-try-label">{copy.sayLabel}</span>
                    <div className="ob-composer">
                      <span>{pCopy.say}</span>
                      <span className="ob-send" aria-hidden="true">
                        <Icon name="arrow-up" size={16} />
                      </span>
                    </div>
                    <button type="button" className="ob-try-btn" onClick={() => props.onTry(pCopy.say ?? "")}>
                      <Icon name="corner-down-left" size={14} />
                      {copy.tryIt}
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : pCopy !== undefined ? (
            <div className="ob-copy ob-faq">
              <div className="ob-kicker">{copy.kickerFaq(progress.current + 1, progress.segments)}</div>
              <h2 className="ob-title">{pCopy.title}</h2>
              {pCopy.body.split("\n").map((para) => (
                <p key={para} className="ob-lead">
                  <Rich text={para} />
                </p>
              ))}
              {pCopy.notes?.map((note) => (
                <p key={note} className="ob-faq-note">
                  <Rich text={note} />
                </p>
              ))}
            </div>
          ) : null}
        </div>
        <footer className="ob-bar">
          <span className="ob-segs" aria-hidden="true">
            {Array.from({ length: progress.segments }, (_, i) => (
              <i key={i} data-state={i < progress.current ? "done" : i === progress.current ? "on" : undefined} />
            ))}
          </span>
          <span className="ob-where">{where}</span>
          <span className="ob-keys">{copy.keys}</span>
          <button type="button" className="quiet-control ob-btn ob-btn-ghost" disabled={index === 0} onClick={() => go(-1)}>
            <Icon name="arrow-left" size={16} />
            {copy.prev}
          </button>
          <button type="button" className="btn-accent ob-btn" onClick={next}>
            {last ? copy.done : copy.next}
            {!last && <Icon name="arrow-right" size={16} />}
          </button>
        </footer>
      </div>
    </div>
  );
}
