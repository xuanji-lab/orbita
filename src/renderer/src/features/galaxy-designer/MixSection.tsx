import { useContext, useState } from "react";
import { MIX_BASES, MIX_ITEMS_MAX, MIX_SCOPES, type MixBasis, type MixScope, type PlanetMix } from "@shared/planet-design";
import { Icon } from "../../shell/Icon";
import { Segmented } from "../settings/SettingControls";
import { LocaleContext, useT } from "../../locale.ts";
import { ELEMENTS, ELEMENT_BY_SYMBOL, FOLDED_PERIODS, type ElementInfo } from "./elements.ts";
import {
  clearShare,
  colorNameOf,
  cssColorOf,
  defaultPlacement,
  mixColor,
  mixPhysics,
  placeItem,
  removeItem,
  resolveMix,
  setShare,
  shuffleMix,
  toggleElement,
  type BodyClass,
  type MixGroup,
  type ReservoirKey,
  type ResolvedItem,
} from "./mix.ts";

/**
 * 星系设计面板「成分」一节：元素周期表 → 构成项（按层 · 口径分组，组头一个小环）→ 推算（密度、颜色提示、储库）。
 * 行星页替掉原来的「岩石 / 冰质 / 气态」三选一；主星页替掉写死的「等离子」（主星密度照旧固定，构成只影响颜色与科普）。
 * 纯展示 + 回调：构成怎么变全在 mix.ts。
 *
 * 周期表的版式（2026-11-24 第二版，参照 ptable.com 等，理由见提交说明）：
 * - 每格是同尺寸的方块，只用底色（不描边）；常见元素铺衬底、主墨字，冷门的不铺底、三级墨字；
 * - 选中：选中底 + 半粗 + 底边一道元素自己的颜色——颜色只在选中时出现，和下面环里那一块同色；
 * - 第 1–3 周期中间那块空白（2–13 族之间）放元素卡：悬停 / 点到的元素写符号、名字、原子序数、物相和一句科普；
 * - 工具条：种子、「随机一版」、展开第 6 周期。
 *
 * 饼和滑块两样都留：滑块是改数的地方，一组五六条时看不出谁占大头；环只读、跟在组头上，一眼看组里的大小关系。
 */
export function MixSection(props: { mix: PlanetMix; cls: BodyClass; onChange: (mix: PlanetMix) => void }) {
  const t = useT();
  const tm = t.galaxyDesigner.mix;
  const locale = useContext(LocaleContext);
  const { mix, cls, onChange } = props;
  const [unfold, setUnfold] = useState(false);
  // 悬停 / 最近点过的元素：表中空白处的元素卡写它
  const [focus, setFocus] = useState<string | null>(null);
  const [placing, setPlacing] = useState<number | null>(null);
  const resolved = resolveMix(mix);
  const physics = mixPhysics(mix);
  const color = mixColor(mix);
  const selected = new Set(mix.items.map((item) => item.id));
  const nameOf = (info: ElementInfo | undefined, symbol: string): string => (info === undefined ? symbol : locale === "zh" ? info.zh : info.en);
  const focused = focus === null ? undefined : ELEMENT_BY_SYMBOL.get(focus);
  const full = mix.items.length >= MIX_ITEMS_MAX;

  return (
    <div className="gd-mix" data-field="mix">
      <div className="gd-mix-tools">
        <span className="gd-mix-count">{tm.picked(selected.size)}</span>
        <span className="gd-seed-value" data-seed={mix.seed} title={tm.seedTip}>
          {tm.seed(mix.seed)}
        </span>
        <button
          type="button"
          className="gd-icon-btn gd-shuffle"
          aria-label={tm.shuffle}
          title={tm.shuffleTip}
          onClick={(event) => {
            setPlacing(null);
            onChange(shuffleMix(mix, cls, event.altKey ? "all" : "keep"));
          }}
        >
          <Icon name="shuffle" size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="gd-ptable" role="group" aria-label={tm.table} onMouseLeave={() => setFocus(null)}>
        {ELEMENTS.filter((e) => unfold || !FOLDED_PERIODS.has(e.period)).map((e) => (
          <button
            key={e.symbol}
            type="button"
            className="gd-pcell"
            style={{ gridColumn: e.group, gridRow: e.period, ...(selected.has(e.symbol) ? ({ "--gd-el": cssColorOf(e.hint) } as React.CSSProperties) : {}) }}
            data-symbol={e.symbol}
            data-common={e.common || undefined}
            aria-pressed={selected.has(e.symbol)}
            aria-label={`${nameOf(e, e.symbol)} ${e.symbol}`}
            disabled={full && !selected.has(e.symbol)}
            onMouseEnter={() => setFocus(e.symbol)}
            onFocus={() => setFocus(e.symbol)}
            onClick={() => {
              setFocus(e.symbol);
              onChange(toggleElement(mix, e.symbol, cls, MIX_ITEMS_MAX));
            }}
          >
            {e.symbol}
          </button>
        ))}
        {unfold && (
          <span className="gd-pcell gd-pcell-fold" style={{ gridColumn: 3, gridRow: 6 }} title={tm.lanthanidesTip}>
            {tm.lanthanides}
          </span>
        )}
        {/* 元素卡：住在第 1–3 周期 3–12 族那块天然的空白里 */}
        <div className="gd-pcard" style={{ gridColumn: "3 / 13", gridRow: "1 / 4" }} data-testid="gd-element-note" aria-live="polite">
          {focused === undefined ? (
            <span className="gd-pcard-hint">{tm.cardHint}</span>
          ) : (
            <>
              <span className="gd-pcard-head">
                <b>{focused.symbol}</b>
                <span>{nameOf(focused, focused.symbol)}</span>
                <span className="gd-pcard-meta">{`${focused.z} · ${tm.phase[focused.phase]}`}</span>
              </span>
              {locale === "zh" && focused.note !== undefined && <span className="gd-pcard-note">{focused.note}</span>}
            </>
          )}
        </div>
      </div>
      <button type="button" className="gd-text-btn gd-fold" aria-expanded={unfold} onClick={() => setUnfold(!unfold)}>
        <Icon name={unfold ? "chevron-up" : "chevron-down"} size={12} strokeWidth={2} />
        {unfold ? tm.foldClose : tm.foldOpen}
      </button>

      {mix.items.length === 0 ? (
        <p className="gd-mix-empty">{tm.empty}</p>
      ) : (
        resolved.groups.map((group) => (
          <section key={group.key} className="gd-mix-group" data-group={group.key}>
            <h4 className="gd-mix-group-head">
              <Pie group={group} label={`${tm.scope[group.scope]} · ${tm.basis[group.basis]}`} pieLabel={tm.pie} />
              <span className="gd-mix-group-name">{`${tm.scope[group.scope]} · ${tm.basisLong[group.basis]}`}</span>
              <span className="gd-mix-group-total">{tm.groupTotal(pct(group.items.reduce((s, item) => s + item.value, 0)))}</span>
            </h4>
            {group.items.map((item) => (
              <MixRow
                key={`${item.id}|${item.scope}|${item.basis}`}
                item={item}
                name={nameOf(ELEMENT_BY_SYMBOL.get(item.id), item.id)}
                isDefaultPlace={item.placed !== true && samePlace(item, defaultPlacement(item.id, cls))}
                placing={placing === item.index}
                onPlace={() => setPlacing(placing === item.index ? null : item.index)}
                onMove={(scope, basis) => onChange(placeItem(mix, item.index, scope, basis))}
                onShare={(value) => onChange(setShare(mix, item.index, value))}
                onClear={() => onChange(clearShare(mix, item.index))}
                onRemove={() => {
                  setPlacing(null);
                  onChange(removeItem(mix, item.index));
                }}
              />
            ))}
          </section>
        ))
      )}

      <dl className="gd-derived" data-testid="gd-derived">
        {cls !== "star" && (
          <>
            <dt>{t.galaxyDesigner.readout.density}</dt>
            <dd data-density={physics?.density.toFixed(3)}>{physics === null ? tm.noBulk : tm.densityValue(physics.density.toFixed(2))}</dd>
          </>
        )}
        {color !== null && (
          <>
            <dt>{tm.color}</dt>
            <dd data-color={colorNameOf(color)}>
              <span className="gd-swatch-dot" style={{ background: cssColorOf(color) }} aria-hidden="true" />
              {tm.colors[colorNameOf(color)]}
            </dd>
          </>
        )}
        {cls !== "star" && physics !== null && (
          <>
            <dt>{tm.derived}</dt>
            <dd className="gd-reservoirs" title={tm.reservoirNote}>
              {(Object.keys(physics.reservoirs) as ReservoirKey[])
                .filter((key) => physics.reservoirs[key] > 0.0005)
                .map((key) => `${tm.reservoirs[key]} ${pct(physics.reservoirs[key])}`)
                .join(" · ")}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function samePlace(a: { scope: MixScope; basis: MixBasis }, b: { scope: MixScope; basis: MixBasis }): boolean {
  return a.scope === b.scope && a.basis === b.basis;
}

/** 百分数：≥ 10% 不带小数，1–10% 一位小数，更小的两位 */
function pct(value: number): string {
  const p = value * 100;
  if (p === 0 || p >= 10) return `${Math.round(p)}%`;
  return `${p >= 1 ? p.toFixed(1) : p.toFixed(2)}%`;
}

function MixRow(props: {
  item: ResolvedItem;
  name: string;
  isDefaultPlace: boolean;
  placing: boolean;
  onPlace: () => void;
  onMove: (scope: MixScope, basis: MixBasis) => void;
  onShare: (value: number) => void;
  onClear: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const tm = t.galaxyDesigner.mix;
  const { item } = props;
  const blank = item.share === null;
  const where = `${tm.scope[item.scope]} · ${tm.basis[item.basis]}`;
  return (
    <div className="gd-mix-row" data-element={item.id} data-source={item.source}>
      <div className="gd-mix-line">
        <span className="gd-mix-name">
          <b className="gd-mix-symbol">{item.id}</b>
          <span>{props.name}</span>
        </span>
        {/* 层与口径写在组头上；这里只说它是默认放的还是你挑的，点开改 */}
        <button
          type="button"
          className="gd-text-btn gd-mix-place"
          data-default={props.isDefaultPlace || undefined}
          aria-expanded={props.placing}
          title={`${tm.place}：${where}`}
          onClick={props.onPlace}
        >
          <Icon name="layers" size={12} strokeWidth={2} />
          {props.isDefaultPlace ? tm.placeDefault : tm.placeUser}
        </button>
        <button type="button" className="gd-icon-btn" aria-label={tm.remove(props.name)} title={tm.remove(props.name)} onClick={props.onRemove}>
          <Icon name="x" size={12} strokeWidth={2} />
        </button>
      </div>
      {props.placing && (
        <div className="gd-mix-placing">
          <Segmented<MixScope>
            label={tm.place}
            value={item.scope}
            options={MIX_SCOPES.map((scope) => ({ value: scope, label: tm.scope[scope] }))}
            onChange={(scope) => props.onMove(scope, item.basis)}
          />
          <Segmented<MixBasis>
            label={tm.place}
            value={item.basis}
            options={MIX_BASES.map((basis) => ({ value: basis, label: tm.basis[basis] }))}
            onChange={(basis) => props.onMove(item.scope, basis)}
          />
        </div>
      )}
      <div className="gd-mix-line">
        <input
          type="range"
          className="gd-range gd-mix-range"
          min={0}
          max={100}
          step={0.5}
          value={Math.round(item.value * 1000) / 10}
          data-blank={blank || undefined}
          aria-label={`${props.name} ${tm.scope[item.scope]} ${tm.basisLong[item.basis]}`}
          onChange={(event) => props.onShare(Number(event.target.value) / 100)}
        />
        <span className="gd-mix-value" data-blank={blank || undefined}>
          {pct(item.value)}
        </span>
        <span className="gd-mix-source" data-source={item.source} title={tm.sourceTip[item.source]}>
          {tm.source[item.source]}
        </span>
        {/* 留空 ≠ 0%：交回种子随机。已经留空的不再给这个键 */}
        <button type="button" className="gd-text-btn gd-mix-clear" title={tm.clearTip} disabled={blank} onClick={props.onClear}>
          {tm.clear}
        </button>
      </div>
    </div>
  );
}

/** 一组的小环：每个元素一块，取元素的颜色提示；随机来的那几块半透明；没分出去的「其余」露出底环 */
function Pie(props: { group: MixGroup; label: string; pieLabel: (group: string) => string }) {
  const R = 15;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const parts = props.group.items.filter((item) => item.value > 0);
  return (
    <svg className="gd-pie" viewBox="-20 -20 40 40" role="img" aria-label={props.pieLabel(props.label)} data-group={props.group.key}>
      <circle className="gd-pie-track" r={R} />
      {parts.map((item) => {
        const info = ELEMENT_BY_SYMBOL.get(item.id);
        const length = Math.max(0, item.value * C - 0.8);
        const el = (
          <circle
            key={item.id}
            className="gd-pie-part"
            data-element={item.id}
            data-source={item.source}
            r={R}
            stroke={info === undefined ? undefined : cssColorOf(info.hint)}
            strokeDasharray={`${length.toFixed(2)} ${(C - length).toFixed(2)}`}
            strokeDashoffset={(-offset).toFixed(2)}
            transform="rotate(-90)"
          >
            <title>{`${item.id} ${pct(item.value)}`}</title>
          </circle>
        );
        offset += item.value * C;
        return el;
      })}
    </svg>
  );
}
