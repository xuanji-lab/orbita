import { useEffect, useMemo, useState } from "react";
import type { BuiltinProvider } from "@shared/agent-ipc";
import { modelDisplayName } from "@shared/model-defaults";
import type { PriceChartCategory, PriceChartData, PriceChartModelRef, PriceChartPoint } from "@shared/price-chart";
import type { ProviderDto } from "@shared/provider";
import { thinkingLevelLabel } from "@shared/thinking";
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
  paretoFrontier,
  pointKey,
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
 * - 横轴对数、纵轴线性；绿线是当前分类的帕累托前沿，前沿上的点带名字，其余悬停 / 聚焦看详情。
 * - 分类用左右按钮循环（默认 Agent 综合），每类各算一条前沿。
 * - 当前分类查不到的型号列「未上榜」，查得到但横轴定不了的列「缺官方单价」，都不硬画进图里。
 *
 * 数据由主进程现算（usage:price-chart）。服务商的型号清单一变就重拉。
 */
export function PriceCapabilityChart(props: {
  providers: readonly ProviderDto[];
  catalog: readonly BuiltinProvider[];
}) {
  const t = useT();
  const copy = t.providers.priceChart;
  const [data, setData] = useState<PriceChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<PriceChartCategory>("agent");
  const [tip, setTip] = useState<{ key: string; x: number; y: number } | null>(null);

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
    const points = current.points;
    const frontier = paretoFrontier(points);
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
    return { points, frontier, frontierKeys, x, y, xOf, yOf, levelLines };
  }, [current]);

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
  const levelOf = (point: PriceChartPoint) =>
    point.thinkingLevel === null ? copy.levelUnlabeled : thinkingLevelLabel(point.thinkingLevel, point.modelId);

  const badge =
    data === null ? null : data.profile.reference ? copy.referenceBadge : copy.basedOnTasks(data.profile.taskCount);
  const hovered = tip === null ? undefined : view?.points.find((p) => pointKey(p) === tip.key);

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
            onClick={() => setCategory((c) => cycleCategory(c, -1))}
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
            onClick={() => setCategory((c) => cycleCategory(c, 1))}
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
                <div className="pc-area" onMouseLeave={() => setTip(null)}>
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
                      {formatCostTick(v)}
                    </span>
                  ))}
                  {view.points.length === 0 && <span className="pc-empty">{copy.noPoints}</span>}
                  {view.points.map((point) => {
                    const key = pointKey(point);
                    const onFront = view.frontierKeys.has(key);
                    const left = view.xOf(point.cost);
                    const show = (x: number, y: number) => setTip({ key, x, y });
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`pc-dot${onFront ? " frontier" : ""}${point.costBasis === "measured" ? "" : " estimated"}`}
                        style={{ left: `${left}%`, top: `${view.yOf(point.score)}%` }}
                        aria-label={`${nameOf(point)} · ${levelOf(point)}`}
                        onMouseMove={(e) => show(e.clientX, e.clientY)}
                        onFocus={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          show(rect.right, rect.top + rect.height / 2);
                        }}
                        onBlur={() => setTip(null)}
                      >
                        {avatar(point, onFront ? 20 : 16)}
                        {onFront && (
                          <span className={`pc-label${left > 68 ? " left" : ""}`}>
                            {nameOf(point)}
                            <span className="pc-label-level">{levelOf(point)}</span>
                          </span>
                        )}
                      </button>
                    );
                  })}
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
                      <span className="pc-best-c">{formatCost(point.cost)}</span>
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

      {hovered !== undefined && tip !== null && current !== null && (
        <div
          className="pc-tip"
          role="tooltip"
          style={{ left: Math.min(tip.x + 14, window.innerWidth - 260), top: Math.max(8, tip.y - 80) }}
        >
          <div className="pc-tip-name">
            {avatar(hovered, 14)}
            <span>
              {nameOf(hovered)} · {levelOf(hovered)}
            </span>
          </div>
          <div className="pc-tip-row">
            <span>{copy.tipScore}</span>
            <span className="pc-mono">{formatScore(hovered.score, current.unit)}</span>
          </div>
          <div className="pc-tip-row">
            <span>{copy.tipCost}</span>
            <span>
              <span className="pc-mono">{formatCost(hovered.cost)}</span>
              <span className="pc-tip-basis">
                {hovered.costBasis === "measured"
                  ? copy.tipMeasured(hovered.samples)
                  : hovered.costBasis === "reference"
                    ? copy.tipReference
                    : copy.tipEstimated}
              </span>
            </span>
          </div>
          {hovered.measured !== undefined && (
            <div className="pc-tip-note">
              {copy.tipMeasuredFew(hovered.measured.samples, formatCost(hovered.measured.cost))}
            </div>
          )}
          <div className="pc-tip-row">
            <span>{copy.tipBoard}</span>
            <span className="pc-mono">{hovered.boardName}</span>
          </div>
        </div>
      )}
    </section>
  );
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
