import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BuiltinProvider } from "@shared/agent-ipc";
import { modelDisplayName } from "@shared/model-defaults";
import type {
  PriceChartCategory,
  PriceChartData,
  PriceChartModelRef,
  PriceChartPoint,
  PriceChartScoreUnit,
} from "@shared/price-chart";
import type { ProviderDto } from "@shared/provider";
import type { ThinkingLevel } from "@shared/thinking";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { ModelAvatar } from "./ModelAvatar";
import {
  costRange,
  costTicks,
  cycleCategory,
  formatCost,
  formatCostTick,
  formatScore,
  type LabelRequest,
  type LabelSide,
  paretoFrontier,
  placeLabels,
  pointKey,
  popoverPlacement,
  scoreRange,
  scoreTicks,
} from "./price-chart-model.ts";
import { modelPreferenceOf, railVendorCell } from "./providers-view-model.ts";
import "./price-chart.css";

/**
 * 价格 · 能力图（原型 7，2026-10-24 定稿）：设置 › 模型服务卡片墙下面，给「派子任务交给谁划算」
 * 当参考。门槛（≥ 2 个型号）由调用方判（price-chart-model 的 shouldShowPriceChart），这里只管画。
 *
 * - 一个点 = 型号 × 思考档（同一型号挂几家服务商、写成别名都合成一个，不显示服务商）；头像就是点。实测点实心，估算点虚线空心框；
 *   跑过但不够门槛的也按估算画，悬停里另写一行「实测 n 个任务 $x」。
 * - 横轴对数、纵轴线性；实线是当前分类的帕累托前沿（与用量格同色），前沿上的点带名字（放不下的退成
 *   悬停提示，placeLabels），其余悬停 / 聚焦出轻提示，点击看详情。
 * - 分类用左右按钮循环（默认 Agent 综合），每类各算一条前沿。
 * - 当前分类查不到的型号列「未上榜」，查得到但横轴定不了的列「缺官方单价」，都不硬画进图里。
 * - 用过、但榜单没评的档借同型号最高评测档的分（用户 2026-10-25：「用 max 顶替」）：点线框标出、
 *   不进前沿，图下写一句为什么（榜单没评 = 不值得单独测，做任务推荐用评过的档）。
 *
 * 数据由主进程现算（usage:price-chart）。服务商的型号清单一变就重拉。
 */
export function PriceCapabilityChart(props: {
  providers: readonly ProviderDto[];
  catalog: readonly BuiltinProvider[];
  /**
   * 停在哪个分类（AppSettings.priceChartCategory，缺席 = Agent 综合）。用户 2026-10-25：切到别的榜单、
   * 离开再回来又回到「Agent 综合」，偏偏这一类很多型号没分数——所以记住，切换即落设置。
   */
  category: PriceChartCategory;
  onCategory: (category: PriceChartCategory) => void;
}) {
  const t = useT();
  const copy = t.providers.priceChart;
  const money = t.currency;
  const [data, setData] = useState<PriceChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 本地先切（不等设置写盘回来），同时落设置；设置那边变了（别的窗口）跟着走
  const [category, setCategoryState] = useState<PriceChartCategory>(props.category);
  useEffect(() => setCategoryState(props.category), [props.category]);
  const setCategory = (next: (current: PriceChartCategory) => PriceChartCategory) => {
    const value = next(category);
    setCategoryState(value);
    props.onCategory(value);
  };
  /**
   * 点开的那个点（pointKey）。用户验收 2026-10-24：「hover 显示效果不是很好，点击显示就好了」——
   * 详情改成点击固定显示；点空白处、按 Esc、再点同一个点就关。悬停只剩 CSS 的轻提示（显示名 + 档）。
   */
  const [selected, setSelected] = useState<string | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      // 点在某个点上交给它自己的 onClick（切换 / 换一个）；点在详情卡里不关
      if (target instanceof Element && target.closest(".pc-dot, .pc-pop") !== null) return;
      setSelected(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelected(null);
      // 关掉后焦点回到刚才那个点上，键盘用户不丢位置
      areaRef.current?.querySelector<HTMLButtonElement>(`.pc-dot[aria-expanded="true"]`)?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [selected]);

  // 只在「哪些型号、什么费率」变了时重拉：别的字段（显示名、排序）不影响图
  const signature = props.providers
    .map((p) => `${p.id}:${p.models.declared.map((m) => `${m.id}=${JSON.stringify(m.cost ?? null)}`).join(",")}`)
    .join("|");
  useEffect(() => {
    let alive = true;
    setError(null);
    api.usage
      .priceChart()
      .then((next) => {
        if (alive) setData(next);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [signature]);

  const current = data?.categories.find((c) => c.category === category) ?? null;
  const view = useMemo(() => {
    if (current === null) return null;
    // 整张图在入口处换算成显示币种：横轴范围与刻度在显示币种里取整（¥0.5、¥1、¥2），标签直接拼前缀
    const points = current.points.map((point) => inCurrency(point, money.perUsd));
    // 借分点不进前沿：分不是这一档自己的（契约 PriceChartPoint.scoreFrom）
    const frontier = paretoFrontier(points.filter((p) => p.scoreFrom === undefined));
    const borrowing = points.some((p) => p.scoreFrom !== undefined || (p.folded?.length ?? 0) > 0);
    const frontierKeys = new Set(frontier.map(pointKey));
    const x = costRange(points.map((p) => p.cost));
    const y = scoreRange(points.map((p) => p.score), current.unit);
    const xOf = (cost: number) =>
      ((Math.log10(cost) - Math.log10(x.min)) / (Math.log10(x.max) - Math.log10(x.min))) * 100;
    const yOf = (score: number) => 100 - ((score - y.min) / (y.max - y.min)) * 100;
    // 同一型号的不同档连一条虚线
    const byModel = new Map<string, PriceChartPoint[]>();
    for (const point of points) {
      byModel.set(point.modelId, [...(byModel.get(point.modelId) ?? []), point]);
    }
    const levelLines = [...byModel.values()]
      .filter((list) => list.length > 1)
      .map((list) => [...list].sort((a, b) => a.cost - b.cost));
    return { points, frontier, frontierKeys, borrowing, x, y, xOf, yOf, levelLines };
  }, [current, money.perUsd]);

  /**
   * 点不带服务商（一个点 = 型号 × 档）：显示名的偏好与头像第三级兜底，借最先声明了这个 id 的那家——
   * 与主进程挑代表 id 的顺序一致。
   */
  const providerOf = (modelId: string) =>
    props.providers.find((p) => p.models.declared.some((m) => m.id === modelId));
  const nameOf = (ref: PriceChartModelRef) => {
    const provider = providerOf(ref.modelId);
    const declared = provider?.models.declared.find((m) => m.id === ref.modelId);
    return modelDisplayName(
      props.catalog,
      ref.modelId,
      provider === undefined ? {} : modelPreferenceOf(provider),
      declared?.name,
    );
  };
  const avatar = (ref: PriceChartModelRef, size: number) => {
    const provider = providerOf(ref.modelId);
    return (
      <ModelAvatar
        modelId={ref.modelId}
        provider={provider === undefined ? { kindId: ref.modelId, label: ref.modelId } : railVendorCell(provider)}
        size={size}
      />
    );
  };
  /** 档名用界面上的叫法（中文界面「最高 / 高」，英文界面 Max / High，claude 的 xhigh 叫 Extra） */
  const levelName = (level: ThinkingLevel, modelId: string) => t.thinkingLevel(level, modelId);
  const levelOf = (point: PriceChartPoint) =>
    point.thinkingLevel === null ? copy.levelUnlabeled : levelName(point.thinkingLevel, point.modelId);
  /** 借分点在档名后缀一句「借「最高」档的分」（无障碍名与悬停提示用） */
  const borrowedOf = (point: PriceChartPoint) =>
    point.scoreFrom === undefined ? null : copy.borrowedTag(levelName(point.scoreFrom, point.modelId));
  const tagOf = (point: PriceChartPoint) => {
    const borrowed = borrowedOf(point);
    return borrowed === null ? levelOf(point) : `${levelOf(point)} · ${borrowed}`;
  };

  /**
   * 前沿标签各放哪一侧：量出点与标签的像素尺寸交给 placeLabels。useLayoutEffect 在绘制前跑，
   * 第一帧按默认方向渲染、量完立刻改，不会闪；绘图区尺寸变了（窗口缩放）由 ResizeObserver 触发重算。
   * 不带依赖数组：显示名、字体、点的位置任何一个变了都要重量；结果不变就不 setState，不会循环。
   */
  const [labelSides, setLabelSides] = useState<ReadonlyMap<string, LabelSide | null>>(() => new Map());
  const [, setAreaSize] = useState("");
  useEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    const observer = new ResizeObserver(() => setAreaSize(`${area.clientWidth}x${area.clientHeight}`));
    observer.observe(area);
    return () => observer.disconnect();
  }, [view !== null]);
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null || view === null) return;
    const dots = [...area.querySelectorAll<HTMLButtonElement>(".pc-dot")];
    // 按钮用 left / top 百分比定位、translate(-50%, -50%) 居中：offsetLeft / offsetTop 就是点的中心
    const boxOf = (el: HTMLElement) => ({ x: el.offsetLeft, y: el.offsetTop, r: el.offsetWidth / 2 });
    const requests: LabelRequest[] = [];
    for (const point of view.frontier) {
      const key = pointKey(point);
      const el = dots.find((d) => d.dataset.key === key);
      const label = el?.querySelector<HTMLElement>(".pc-label");
      if (el === undefined || label === null || label === undefined) continue;
      requests.push({ key, ...boxOf(el), w: label.offsetWidth, h: label.offsetHeight });
    }
    const next = placeLabels(requests, dots.map(boxOf), { w: area.clientWidth, h: area.clientHeight });
    const same = next.size === labelSides.size && [...next].every(([key, side]) => labelSides.get(key) === side);
    if (!same) setLabelSides(next);
  });

  const badge =
    data === null ? null : data.profile.reference ? copy.referenceBadge : copy.basedOnTasks(data.profile.taskCount);
  const picked = selected === null ? undefined : view?.points.find((p) => pointKey(p) === selected);

  return (
    <section className="pc-block" aria-label={copy.title}>
      <div className="pc-head">
        <span className="pc-title">{copy.title}</span>
        {badge !== null && (
          <span className="pc-badge">
            <Icon name={data?.profile.reference === true ? "triangle-alert" : "info"} size={12} />
            {badge}
          </span>
        )}
        <span className="pc-switch row-trailing">
          <button
            type="button"
            className="quiet-control"
            aria-label={copy.prevCategory}
            title={copy.prevCategory}
            onClick={() => {
              setSelected(null);
              setCategory((c) => cycleCategory(c, -1));
            }}
          >
            <Icon name="chevron-left" size={13} />
          </button>
          <span className="pc-cat" aria-live="polite">
            {copy.categories[category]}
          </span>
          <button
            type="button"
            className="quiet-control"
            aria-label={copy.nextCategory}
            title={copy.nextCategory}
            onClick={() => {
              setSelected(null);
              setCategory((c) => cycleCategory(c, 1));
            }}
          >
            <Icon name="chevron-right" size={13} />
          </button>
        </span>
      </div>

      {error !== null && (
        <div className="pc-status">
          <Icon name="triangle-alert" size={13} /> {copy.loadFailed} · {error}
        </div>
      )}
      {error === null && data === null && (
        <div className="pc-status">
          <Icon name="loader-circle" size={13} spin /> {copy.loading}
        </div>
      )}

      {current !== null && view !== null && (
        <>
          <div className="pc-wrap">
            <div className="pc-main">
              <div className="pc-plot">
                <span className="pc-axis-y">{current.unit === "rating" ? copy.yAxisRating : copy.yAxisAgent}</span>
                <div className="pc-area" ref={areaRef}>
                  <svg className="pc-grid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    {scoreTicks(view.y).map((v) => (
                      <line key={`y${v}`} x1="0" x2="100" y1={view.yOf(v)} y2={view.yOf(v)} className="pc-gridline" />
                    ))}
                    {costTicks(view.x).map((v) => (
                      <line key={`x${v}`} y1="0" y2="100" x1={view.xOf(v)} x2={view.xOf(v)} className="pc-gridline" />
                    ))}
                    {view.levelLines.map((list) => (
                      <polyline
                        key={pointKey(list[0] as PriceChartPoint)}
                        className="pc-levelline"
                        points={list.map((p) => `${view.xOf(p.cost)},${view.yOf(p.score)}`).join(" ")}
                      />
                    ))}
                    {view.frontier.length > 1 && (
                      <polyline
                        className="pc-frontier"
                        points={view.frontier.map((p) => `${view.xOf(p.cost)},${view.yOf(p.score)}`).join(" ")}
                      />
                    )}
                  </svg>
                  {scoreTicks(view.y).map((v) => (
                    <span key={`yl${v}`} className="pc-tick y" style={{ top: `${view.yOf(v)}%` }}>
                      {formatScore(v, current.unit)}
                    </span>
                  ))}
                  {costTicks(view.x).map((v) => (
                    <span key={`xl${v}`} className="pc-tick x" style={{ left: `${view.xOf(v)}%` }}>
                      {formatCostTick(v, money.symbol)}
                    </span>
                  ))}
                  {view.points.length === 0 && <span className="pc-empty">{copy.noPoints}</span>}
                  {view.points.map((point) => {
                    const key = pointKey(point);
                    const onFront = view.frontierKeys.has(key);
                    const left = view.xOf(point.cost);
                    const open = selected === key;
                    return (
                      <button
                        key={key}
                        data-key={key}
                        type="button"
                        className={`pc-dot${onFront ? " frontier" : ""}${point.costBasis === "measured" ? "" : " estimated"}${point.scoreFrom === undefined ? "" : " borrowed"}`}
                        style={{ left: `${left}%`, top: `${view.yOf(point.score)}%` }}
                        aria-label={`${nameOf(point)} · ${tagOf(point)}`}
                        aria-expanded={open}
                        aria-controls={open ? "pc-pop" : undefined}
                        // 按钮原生支持 Enter / 空格触发 click：键盘焦点到点上就能打开
                        onClick={() => setSelected(open ? null : key)}
                      >
                        {avatar(point, onFront ? 20 : 16)}
                        {onFront ? (
                          <span className={`pc-label ${labelSideClass(labelSides, key, left)}`}>
                            {nameOf(point)}
                            <span className="pc-label-level">{levelOf(point)}</span>
                          </span>
                        ) : (
                          // 不在前沿上的点没有名字：悬停 / 键盘聚焦时 CSS 显出一个轻提示，不占 JS 状态
                          <span className={`pc-hint${left > 68 ? " left" : ""}`} aria-hidden="true">
                            {nameOf(point)}
                            <span className="pc-label-level">{levelOf(point)}</span>
                            {point.scoreFrom !== undefined && <span className="pc-label-tag">{borrowedOf(point)}</span>}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {picked !== undefined && (
                    <PointDetail
                      point={picked}
                      at={{ x: view.xOf(picked.cost), y: view.yOf(picked.score) }}
                      unit={current.unit}
                      name={nameOf(picked)}
                      level={levelOf(picked)}
                      levelName={(level) => levelName(level, picked.modelId)}
                      avatar={avatar(picked, 14)}
                    />
                  )}
                </div>
                <span className="pc-axis-x">{copy.xAxis}</span>
              </div>
              <div className="pc-legend">
                <span className="pc-li">
                  <span className="pc-sw" />
                  {copy.legendMeasured}
                </span>
                <span className="pc-li">
                  <span className="pc-sw estimated" />
                  {copy.legendEstimated}
                </span>
                {view.borrowing && (
                  <span className="pc-li">
                    <span className="pc-sw borrowed" />
                    {copy.legendBorrowed}
                  </span>
                )}
                <span className="pc-li">
                  <span className="pc-ln" />
                  {copy.legendLevels}
                </span>
                <span className="pc-li">
                  <span className="pc-pf" />
                  {copy.legendFrontier}
                </span>
              </div>
            </div>
            <aside className="pc-best">
              <div className="pc-best-head">
                <Icon name="trending-up" size={13} />
                {copy.frontierTitle}
              </div>
              {[...view.frontier]
                .sort((a, b) => b.score - a.score)
                .map((point) => (
                  <div key={pointKey(point)} className="pc-best-row">
                    {avatar(point, 20)}
                    <span className="pc-best-name">
                      <span className="pc-best-n">{nameOf(point)}</span>
                      <span className="pc-best-l">{levelOf(point)}</span>
                    </span>
                    <span className="pc-best-val row-trailing">
                      <span className="pc-best-s">{formatScore(point.score, current.unit)}</span>
                      <span className="pc-best-c">{formatCost(point.cost, money.symbol)}</span>
                    </span>
                  </div>
                ))}
              <div className="pc-best-sub">{copy.frontierNote}</div>
            </aside>
          </div>

          <ModelChips label={copy.unranked} icon="circle-off" refs={current.unranked} nameOf={nameOf} avatar={avatar} />
          <ModelChips
            label={copy.unpriced}
            icon="circle-help"
            refs={current.unpriced}
            nameOf={nameOf}
            avatar={avatar}
            title={copy.unpricedTip}
          />
          <div className="pc-notes">
            {view.borrowing && <span>{copy.borrowNote}</span>}
            <span>{copy.explainer}</span>
            {data?.hasPlanProvider === true && <span>{copy.planNote}</span>}
          </div>
          {data !== null && (
            <div className="pc-source">
              <Icon name="info" size={12} />
              {/* 外链照仓里现成的走法：拦掉默认行为交给 window.open，主进程送进内置浏览器（UpdateCard 同款） */}
              <a
                href={data.source.url}
                onClick={(event) => {
                  event.preventDefault();
                  window.open(data.source.url);
                }}
              >
                {copy.source(current.publishDate, data.source.revision.slice(0, 7))}
              </a>
            </div>
          )}
        </>
      )}

    </section>
  );
}

/**
 * 点开的详情卡：钉在点旁边（.pc-area 内的百分比坐标），左右 / 上下按点的位置翻到不出界的一侧
 * （popoverPlacement）。内容：型号 · 档、分数、每任务成本（实测几个任务 / 估算）、不够门槛的实测、榜单条目。
 */
function PointDetail(props: {
  point: PriceChartPoint;
  at: { x: number; y: number };
  unit: PriceChartScoreUnit;
  name: string;
  level: string;
  levelName: (level: ThinkingLevel) => string;
  avatar: React.ReactNode;
}) {
  const t = useT();
  const copy = t.providers.priceChart;
  const symbol = t.currency.symbol;
  const { point } = props;
  const place = popoverPlacement(props.at.x, props.at.y);
  return (
    <div
      id="pc-pop"
      className={`pc-pop ${place.side} ${place.vertical}`}
      role="dialog"
      aria-label={`${props.name} · ${props.level}`}
      style={{ left: `${props.at.x}%`, top: `${props.at.y}%` }}
    >
      <div className="pc-tip-name">
        {props.avatar}
        <span>
          {props.name} · {props.level}
        </span>
      </div>
      <div className="pc-tip-row">
        <span>{copy.tipScore}</span>
        <span className="pc-mono">{formatScore(point.score, props.unit)}</span>
      </div>
      {point.scoreFrom !== undefined && (
        <div className="pc-tip-note">{copy.tipBorrowed(props.levelName(point.scoreFrom))}</div>
      )}
      <div className="pc-tip-row">
        <span>{copy.tipCost}</span>
        <span>
          <span className="pc-mono">{formatCost(point.cost, symbol)}</span>
          <span className="pc-tip-basis">
            {point.costBasis === "measured"
              ? copy.tipMeasured(point.samples)
              : point.costBasis === "reference"
                ? copy.tipReference
                : copy.tipEstimated}
          </span>
        </span>
      </div>
      {point.measured !== undefined && (
        <div className="pc-tip-note">{copy.tipMeasuredFew(point.measured.samples, formatCost(point.measured.cost, symbol))}</div>
      )}
      {point.folded?.map((item) => (
        <div key={item.thinkingLevel} className="pc-tip-note">
          {copy.tipFolded(props.levelName(item.thinkingLevel), item.samples, formatCost(item.cost, symbol))}
        </div>
      ))}
      <div className="pc-tip-row">
        <span>{copy.tipBoard}</span>
        <span className="pc-mono">{point.boardName}</span>
      </div>
    </div>
  );
}

/** 一个点换算成显示币种（数据是美元，见 utils/money.ts）：花费、不够门槛的实测、并进来的档一起换 */
function inCurrency(point: PriceChartPoint, perUsd: number): PriceChartPoint {
  return {
    ...point,
    cost: point.cost * perUsd,
    ...(point.measured === undefined ? {} : { measured: { ...point.measured, cost: point.measured.cost * perUsd } }),
    ...(point.folded === undefined ? {} : { folded: point.folded.map((item) => ({ ...item, cost: item.cost * perUsd })) }),
  };
}

/**
 * 标签方向对应的类名：还没量过（第一帧）按原来的规则左右二选一；量过之后用 placeLabels 的结果，
 * null 记成 off——标签平时不显示，悬停 / 聚焦时才出来，与非前沿点的轻提示一样。
 */
function labelSideClass(sides: ReadonlyMap<string, LabelSide | null>, key: string, left: number): string {
  if (!sides.has(key)) return left > 68 ? "left" : "right";
  return sides.get(key) ?? "off";
}

/** 图下的型号清单（未上榜 / 缺官方单价）：头像 + 显示名，按型号去重 */
function ModelChips(props: {
  label: string;
  icon: "circle-off" | "circle-help";
  refs: readonly PriceChartModelRef[];
  nameOf: (ref: PriceChartModelRef) => string;
  avatar: (ref: PriceChartModelRef, size: number) => React.ReactNode;
  title?: string;
}) {
  if (props.refs.length === 0) return null;
  return (
    <div className="pc-chips" title={props.title}>
      <span className="pc-chips-label">
        <Icon name={props.icon} size={13} />
        {props.label}
      </span>
      {props.refs.map((ref) => (
        <span key={ref.modelId} className="pc-chip">
          {props.avatar(ref, 14)}
          <span>{props.nameOf(ref)}</span>
        </span>
      ))}
    </div>
  );
}
