import "./galaxy-designer.css";
import { useEffect, useId, useState } from "react";
import type { Workspace } from "@shared/workspace";
import type { Composition } from "../chat/galaxy.ts";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelGroupHead, PanelHelp, PanelLine, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { Segmented, Switch } from "../settings/SettingControls";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import {
  addPlanet,
  BACKDROPS,
  bodyArt,
  clampValue,
  createStar,
  densityOf,
  displayRadius,
  ELEMENTS_OF,
  errorsAt,
  formatNumber,
  massRange,
  maxOrbit,
  minOrbit,
  ORBIT_RANGE,
  parseNumberInput,
  PREVIEW_FRAME,
  previewFrame,
  radiusOf,
  validateDesign,
  ZOOM,
  type BodyArt,
  type BodyDesign,
  type BodyKind,
  type DesignError,
  type ElementKey,
  type GalaxyDesign,
  type PlanetDesign,
} from "./design.ts";
import { galaxyDesigns } from "./useGalaxyDesign.ts";
import { BodyFigure } from "./StarFigure.tsx";
import { flatStage, ORBIT_BOX, orbitStage, previewPlan, starStage, type GridLine, type WellBox } from "./well.ts";

/**
 * 星系设计（原型，proto/planet-designer）：侧栏工作区行悬停出现的画笔键打开它，住在右栏面板位里。
 * 版式照 Nuphos「New Bot」的组织：预览在上 → 读数 → 参数与元素 → 预览背景；但没有人脸网格，
 * 全是参数与开关——同一套规则下的组合，不是抽卡。
 *
 * 预览：主星页是主星压在一张弯曲的网格布上（引力的示意画法，质量越大坑越深，well.ts）；
 * 行星页是行星自己的大头像 + 一块小场景（同一张网格布上的主星与这颗行星的轨道）。
 * 行星依赖主星：没有主星时行星页是「先创建主星」的空态，加行星走 design.ts 的 addPlanet（数据层拒绝）。
 *
 * 只做面板与预览：不写配置、不接 agent 数据。设计稿按工作区存在这次运行的内存里（design.ts 的 DesignStore）。
 */

/** 设计稿仓库是全应用一份（useGalaxyDesign.ts）：面板写，侧栏头像与工作区页的星系读 */
const store = galaxyDesigns;

export function GalaxyDesigner(props: { workspace: Workspace | null }) {
  const t = useT();
  const tg = t.galaxyDesigner;
  if (props.workspace === null) {
    return (
      <RightPanelFrame header={<PanelTitle icon="orbit" title={tg.title} />} contentKey="galaxy-none">
        <PanelEmpty icon="orbit" hint={tg.noWorkspaceHint}>
          {tg.noWorkspace}
        </PanelEmpty>
      </RightPanelFrame>
    );
  }
  // key：换工作区整块重挂，本地状态只从这个工作区的设计稿来，不会把上一个的数带过去
  return <Designer key={props.workspace.id} workspace={props.workspace} />;
}

function Designer(props: { workspace: Workspace }) {
  const t = useT();
  const tg = t.galaxyDesigner;
  const id = props.workspace.id;
  const [design, setDesignState] = useState<GalaxyDesign>(() => store.get(id));
  const setDesign = (next: GalaxyDesign): void => {
    store.set(id, next);
    setDesignState(store.get(id));
  };
  const kind = design.editing;
  const body: BodyDesign | PlanetDesign | null = kind === "star" ? design.star : design.planet;
  const patchBody = (patch: Partial<PlanetDesign>): void => {
    if (kind === "star") {
      if (design.star === null) return;
      const { composition: _c, orbitRadius: _o, ...rest } = patch;
      setDesign({ ...design, star: { ...design.star, ...rest } });
    } else {
      if (design.planet === null) return;
      setDesign({ ...design, planet: { ...design.planet, ...patch } });
    }
  };
  const errors = validateDesign(design);
  const radius = radiusOf(design, kind);
  const range = massRange(kind);
  const nameFallback = kind === "star" ? props.workspace.name : tg.unnamedPlanet;
  const onAddPlanet = (): void => {
    const result = addPlanet(design, id);
    // 没有主星时数据层拒绝：留在原页（面板上的出口本来就是「创建主星」，走不到这里）
    if (result.ok) setDesign(result.design);
  };

  return (
    <RightPanelFrame
      contentKey={`galaxy-${id}`}
      header={
        <>
          <PanelTitle icon="orbit" title={tg.title} />
          <span className="gd-cap-ws" title={props.workspace.path}>
            {props.workspace.name}
          </span>
        </>
      }
      headerExtra={<PanelHelp label={tg.helpLabel} text={tg.help} />}
      footer={
        <>
          <span className="gd-foot-note">
            <PanelLine>{tg.prototypeNote}</PanelLine>
          </span>
          <span className="gd-foot-btn">
            <PanelButton onClick={() => setDesign(store.reset(id))} title={tg.resetTip}>
              {tg.reset}
            </PanelButton>
          </span>
        </>
      }
      subheader={
        <div className="gd gd-head" data-has-star={design.star !== null || undefined} data-has-planet={design.planet !== null || undefined}>
          <Preview design={design} workspaceName={props.workspace.name} invalid={invalidFor(errors, kind)} />
          {body !== null && (
            <p className="gd-readout" data-testid="gd-readout">
              <span>
                {tg.readout.radius}<b data-radius={radius.toFixed(4)}>{formatNumber(radius)}</b>
              </span>
              <span>
                {tg.readout.density}<b>{formatNumber(densityOf(kind, design.planet?.composition ?? "rock"))}</b>
              </span>
              <span>
                {tg.readout.mass}<b>{formatNumber(body.mass)}</b>
              </span>
              {kind === "planet" && design.planet !== null && (
                <span>
                  {tg.readout.orbit}<b>{formatNumber(design.planet.orbitRadius)}</b>
                </span>
              )}
            </p>
          )}
          <p className="gd-well-note">{tg.wellNote}</p>
          {/* 钉在顶上的总提示：下面标红的行可能滚出去了，这里一直说着「有几处不合规则」 */}
          {errors.length > 0 && (
            <p className="gd-error gd-error-sum" role="status" data-error-count={errors.length}>
              <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
              <span>{tg.errorSummary(errors.length)}</span>
            </p>
          )}
        </div>
      }
    >
      <div className="gd" data-workspace={id}>
        {/* 这一页画的是谁：主星页写「主星 · 工作区名」（它就是这个工作区的主智能体本人），行星页写「行星 = 子智能体」 */}
        <PanelGroupHead label={kind === "star" ? tg.starWho(props.workspace.name) : tg.planetWho} />
        <p className="gd-who" data-kind={kind}>
          {kind === "star" ? tg.starWhoLine : tg.planetWhoLine}
        </p>
        <Row name={tg.kind} desc={tg.kindDesc}>
          <Segmented<BodyKind>
            label={tg.kind}
            value={kind}
            options={[
              { value: "star", label: tg.star },
              { value: "planet", label: tg.planet },
            ]}
            onChange={(editing) => setDesign({ ...design, editing })}
          />
        </Row>
        {body === null ? (
          // 空页：没主星（主星页、行星页都是先创建主星），或有主星还没行星（行星页：添加行星）
          <div className="gd-empty" data-empty={design.star === null ? "no-star" : "no-planet"}>
            {design.star === null ? (
              <PanelEmpty
                icon="orbit"
                hint={kind === "planet" ? tg.planetNeedsStarHint : tg.noStarHint}
                exit={{ label: tg.createStar, onClick: () => setDesign(createStar(design)) }}
              >
                {kind === "planet" ? tg.planetNeedsStar : tg.noStar}
              </PanelEmpty>
            ) : (
              <PanelEmpty icon="orbit" hint={tg.noPlanetHint} exit={{ label: tg.addPlanet, onClick: onAddPlanet }}>
                {tg.noPlanet}
              </PanelEmpty>
            )}
          </div>
        ) : (
          <>
            <Row name={tg.name} errors={errorsAt(errors, kind, "name")} t={t} wide>
              <input
                className="text-field gd-name"
                value={body.name}
                placeholder={nameFallback}
                aria-label={tg.name}
                aria-invalid={errorsAt(errors, kind, "name").length > 0 || undefined}
                onChange={(event) => patchBody({ name: event.target.value })}
              />
            </Row>
            <Row
              name={tg.mass}
              desc={kind === "star" ? tg.starMassDesc(formatNumber(range.min), formatNumber(range.max)) : tg.massDesc(formatNumber(range.min), formatNumber(range.max))}
              errors={errorsAt(errors, kind, "mass")}
              t={t}
              slider={
                <input
                  type="range"
                  className="gd-range"
                  min={range.min}
                  max={range.max}
                  step={kind === "star" ? 10 : 0.5}
                  value={Number.isFinite(body.mass) ? clampValue(body.mass, range.min, range.max) : range.min}
                  aria-label={tg.mass}
                  data-field="mass"
                  onChange={(event) => patchBody({ mass: Number(event.target.value) })}
                />
              }
            >
              <NumberField value={body.mass} label={tg.mass} field="mass" invalid={errorsAt(errors, kind, "mass").length > 0} onChange={(mass) => patchBody({ mass })} />
            </Row>
            {kind === "planet" && design.planet !== null ? (
              <Row name={tg.composition} desc={tg.compositionDesc}>
                <Segmented<Composition>
                  label={tg.composition}
                  value={design.planet.composition}
                  options={[
                    { value: "rock", label: tg.rock },
                    { value: "ice", label: tg.ice },
                    { value: "gas", label: tg.gas },
                  ]}
                  onChange={(composition) => patchBody({ composition })}
                />
              </Row>
            ) : (
              <Row name={tg.composition} desc={tg.starComposition}>
                <span className="gd-fixed">{tg.plasma}</span>
              </Row>
            )}
            {kind === "planet" && design.planet !== null && (
              <Row
                name={tg.orbit}
                desc={tg.orbitDesc(formatNumber(minOrbit(design)), formatNumber(maxOrbit(design)))}
                errors={errorsAt(errors, "planet", "orbit")}
                t={t}
                slider={
                  <input
                    type="range"
                    className="gd-range"
                    min={ORBIT_RANGE.min}
                    max={ORBIT_RANGE.max}
                    step={ORBIT_RANGE.step}
                    value={Number.isFinite(design.planet.orbitRadius) ? clampValue(design.planet.orbitRadius, ORBIT_RANGE.min, ORBIT_RANGE.max) : ORBIT_RANGE.min}
                    aria-label={tg.orbit}
                    data-field="orbit"
                    onChange={(event) => patchBody({ orbitRadius: Number(event.target.value) })}
                  />
                }
              >
                <NumberField
                  value={design.planet.orbitRadius}
                  label={tg.orbit}
                  field="orbit"
                  invalid={errorsAt(errors, "planet", "orbit").length > 0}
                  onChange={(orbitRadius) => patchBody({ orbitRadius })}
                />
              </Row>
            )}

            <PanelGroupHead label={tg.elementsGroup} />
            {ELEMENTS_OF[kind].map((key) => (
              <Row key={key} name={tg.elements[key]} desc={tg.elementDesc[key]}>
                <span data-element={key}>
                  <Switch
                    label={tg.elements[key]}
                    checked={body.elements[key]}
                    onChange={(next) => patchBody({ elements: { ...body.elements, [key]: next } })}
                  />
                </span>
              </Row>
            ))}

            <PanelGroupHead label={tg.previewGroup} />
            <Row
              name={tg.zoom}
              desc={tg.zoomDesc}
              slider={
                <input
                  type="range"
                  className="gd-range"
                  min={ZOOM.min}
                  max={ZOOM.max}
                  step={ZOOM.step}
                  value={body.zoom}
                  aria-label={tg.zoom}
                  data-field="zoom"
                  onChange={(event) => patchBody({ zoom: Number(event.target.value) })}
                />
              }
            >
              <span className="gd-value">{body.zoom}%</span>
            </Row>
          </>
        )}
        <Row name={tg.backdrop}>
          <span className="gd-swatches" role="group" aria-label={tg.backdrop}>
            {BACKDROPS.map((backdrop) => (
              <button
                key={backdrop}
                type="button"
                className="gd-swatch"
                data-backdrop={backdrop}
                aria-pressed={design.backdrop === backdrop}
                title={tg.backdrops[backdrop]}
                aria-label={tg.backdrops[backdrop]}
                onClick={() => setDesign({ ...design, backdrop })}
              />
            ))}
          </span>
        </Row>
      </div>
    </RightPanelFrame>
  );
}

/** 一行：名字 + 下面一句说明在左，控件在右；滑块（有就）占整行宽排在下面；错误写在最底下 */
function Row(props: {
  name: string;
  desc?: string;
  errors?: DesignError[];
  t?: Messages;
  slider?: React.ReactNode;
  /** 控件要占满一行（名称输入框） */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={props.wide === true ? "gd-row gd-row-wide" : "gd-row"}>
      <span className="gd-row-head">
        <span className="gd-row-name">{props.name}</span>
        {props.desc !== undefined && <span className="gd-row-desc">{props.desc}</span>}
      </span>
      <span className="gd-row-ctl">{props.children}</span>
      {props.slider !== undefined && <span className="gd-row-slider">{props.slider}</span>}
      {props.errors !== undefined &&
        props.t !== undefined &&
        props.errors.map((error) => (
          <p key={error.kind} className="gd-error" role="alert" data-error={error.kind}>
            <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
            <span>{errorText(error, props.t as Messages)}</span>
          </p>
        ))}
    </div>
  );
}

/** 预览上这一颗要不要标红：它自己的质量 / 名字出错，或轨道相撞（两颗都牵涉）；轨道太远只算行星 */
function invalidFor(errors: readonly DesignError[], kind: BodyKind): boolean {
  return errors.some((error) => {
    if (error.kind === "orbit-collision" || error.kind === "planet-without-star") return true;
    return error.kind === "orbit-far" ? kind === "planet" : error.body === kind;
  });
}

function errorText(error: DesignError, t: Messages): string {
  const tg = t.galaxyDesigner;
  if (error.kind === "mass-range") {
    return tg.errors.massRange(error.body === "star" ? tg.star : tg.planet, formatNumber(error.value), formatNumber(error.min), formatNumber(error.max));
  }
  if (error.kind === "orbit-collision") return tg.errors.collision(formatNumber(error.value), formatNumber(error.min));
  if (error.kind === "orbit-far") return tg.errors.far(formatNumber(error.value), formatNumber(error.max));
  if (error.kind === "planet-without-star") return tg.errors.planetWithoutStar;
  return tg.errors.nameLong(error.length, error.max);
}

/**
 * 数字框：输入的字原样留着，解析成数交给上层（空 / 非数字 = NaN，越界照样交上去由校验报错）。
 * 滑块改了数，框里的字跟着换；正在打的字与当前值一致时不打断（比如打到「12.」）。
 */
function NumberField(props: { value: number; label: string; field: string; invalid: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(() => formatNumber(props.value));
  useEffect(() => {
    setText((current) => {
      const parsed = parseNumberInput(current);
      if (Number.isNaN(parsed) && Number.isNaN(props.value)) return current;
      return parsed === props.value ? current : formatNumber(props.value);
    });
  }, [props.value]);
  return (
    <input
      className="text-field gd-number"
      inputMode="decimal"
      value={text === "—" ? "" : text}
      aria-label={props.label}
      aria-invalid={props.invalid || undefined}
      data-field={props.field}
      onChange={(event) => {
        setText(event.target.value);
        props.onChange(parseNumberInput(event.target.value));
      }}
    />
  );
}

/** 预览：主星页是网格布上的主星；行星页是大头像 + 轨道小场景；没有主星时是一张平的布 */
function Preview(props: { design: GalaxyDesign; workspaceName: string; invalid: boolean }) {
  const t = useT();
  const tg = t.galaxyDesigner;
  const uid = useId().replace(/:/g, "");
  const { design } = props;
  const kind = design.editing;
  const plan = previewPlan(design);
  const common = { "data-backdrop": design.backdrop, "data-invalid": props.invalid || undefined, "data-parts": plan.join(" ") };
  if (design.star === null) {
    const box = frameBox(PREVIEW_FRAME);
    const flat = flatStage(box);
    return (
      <figure className="gd-stage" data-body={kind} data-empty="no-star" {...common}>
        <svg className="gd-well" viewBox={viewBoxOf(box)} role="img" aria-label={tg.flatFigure} data-depth="0">
          <GridLayer lines={flat.grid} box={box} id={`${uid}-fade`} depth={0} />
          <circle className="gd-placeholder" cx={flat.center.x} cy={flat.center.y - 18} r={22} />
        </svg>
      </figure>
    );
  }
  if (kind === "star") {
    const star = design.star;
    const r = displayRadius(radiusOf(design, "star"));
    const art = bodyArt(design, "star", r);
    const s = star.zoom / 100;
    const frame = previewFrame({ extent: { x: art.extent.x * s, y: art.extent.y * s } });
    const box = frameBox(frame);
    const stage = starStage(box, star.mass, r, star.zoom);
    const name = star.name || props.workspaceName;
    return (
      <figure className="gd-stage" data-body="star" {...common}>
        <svg
          className="gd-preview"
          viewBox={viewBoxOf(box)}
          role="img"
          aria-label={tg.figure(name)}
          data-body="star"
          data-surface={art.surface}
          data-display-r={r.toFixed(2)}
          data-zoom={star.zoom}
          data-elements={onElements(star, "star").join(" ")}
          data-depth={stage.depth.toFixed(2)}
          data-bottom-y={stage.bottom.y.toFixed(2)}
          data-star-cy={stage.star.y.toFixed(2)}
        >
          <GridLayer lines={stage.grid} box={box} id={`${uid}-fade`} depth={stage.depth} />
          <g transform={`translate(${stage.star.x.toFixed(2)} ${stage.star.y.toFixed(2)}) scale(${s})`}>
            <BodyFigure art={art} uid={uid} />
          </g>
        </svg>
        <figcaption className="gd-stage-name" title={name}>
          {name}
        </figcaption>
      </figure>
    );
  }
  const planet = design.planet;
  return (
    <figure className="gd-stage" data-body="planet" data-empty={planet === null ? "no-planet" : undefined} {...common}>
      {planet !== null && <PlanetAvatar design={design} planet={planet} uid={uid} name={planet.name || tg.unnamedPlanet} />}
      <OrbitScene design={design} uid={`${uid}-o`} label={tg.orbitFigure(planet === null ? props.workspaceName : planet.name || tg.unnamedPlanet)} />
      {planet !== null && (
        <figcaption className="gd-stage-name" title={planet.name || tg.unnamedPlanet}>
          {planet.name || tg.unnamedPlanet}
        </figcaption>
      )}
    </figure>
  );
}

function frameBox(frame: { halfW: number; halfH: number }): WellBox {
  return { x: -frame.halfW, y: -frame.halfH, w: frame.halfW * 2, h: frame.halfH * 2 };
}

function viewBoxOf(box: WellBox): string {
  return `${box.x} ${box.y} ${box.w} ${box.h}`;
}

function onElements(body: BodyDesign, kind: BodyKind): ElementKey[] {
  return ELEMENTS_OF[kind].filter((key: ElementKey) => body.elements[key]);
}

/** 行星自己的大头像：居中、按预览缩放放大（与轨道场景分开：头像管「它长什么样」，场景管「它绕着谁转」） */
function PlanetAvatar(props: { design: GalaxyDesign; planet: PlanetDesign; uid: string; name: string }) {
  const t = useT();
  const { design, planet } = props;
  const r = displayRadius(radiusOf(design, "planet"));
  const art = bodyArt(design, "planet", r);
  const frame = previewFrame(art);
  return (
    <svg
      className="gd-preview"
      viewBox={viewBoxOf(frameBox(frame))}
      data-frame-scale={frame.scale.toFixed(3)}
      role="img"
      aria-label={t.galaxyDesigner.figure(props.name)}
      data-body="planet"
      data-surface={art.surface}
      data-display-r={r.toFixed(2)}
      data-zoom={planet.zoom}
      data-elements={onElements(planet, "planet").join(" ")}
    >
      <g transform={`scale(${planet.zoom / 100})`}>
        <BodyFigure art={art} uid={props.uid} />
      </g>
    </svg>
  );
}

/**
 * 小场景里的天体只画轮廓、明暗和（够大时）眼睛：卫星、云带、日冕在几像素上只会糊成一团，
 * 星环保留（它是这颗行星一眼认得出的轮廓）。
 */
function sceneDesign(design: GalaxyDesign, starR: number, planetR: number): GalaxyDesign {
  const strip = (body: BodyDesign, r: number): BodyDesign["elements"] => ({
    eyes: body.elements.eyes && r >= 8,
    ring: body.elements.ring,
    clouds: false,
    moons: false,
    corona: false,
  });
  return {
    ...design,
    star: design.star === null ? null : { ...design.star, elements: strip(design.star, starR) },
    planet: design.planet === null ? null : { ...design.planet, elements: strip(design.planet, planetR) },
  };
}

/** 轨道小场景：同一张网格布上，主星压在坑里，这颗行星的轨道贴着布面；最近的合法轨道画虚线，撞上时标红 */
function OrbitScene(props: { design: GalaxyDesign; uid: string; label: string }) {
  const stage = orbitStage(props.design);
  if (stage === null) return null;
  const small = sceneDesign(props.design, stage.star.r, stage.planet?.r ?? 0);
  const starArt = bodyArt(small, "star", stage.star.r);
  const planetArt = stage.planet === null ? null : bodyArt(small, "planet", stage.planet.r);
  const p = stage.planet;
  return (
    <svg
      className="gd-orbit"
      viewBox={viewBoxOf(ORBIT_BOX)}
      role="img"
      aria-label={props.label}
      data-depth={stage.depth.toFixed(2)}
      data-star-r={stage.star.r.toFixed(2)}
      data-orbit-a={p === null ? undefined : p.a.toFixed(2)}
      data-planet-x={p === null ? undefined : p.x.toFixed(2)}
      data-planet-r={p === null ? undefined : p.r.toFixed(2)}
      data-collide={p?.collide || undefined}
    >
      <GridLayer lines={stage.grid} box={ORBIT_BOX} id={`${props.uid}-fade`} depth={stage.depth} />
      {p !== null && <path className="gd-orbit-nearest" d={p.nearest.back} />}
      {p !== null && <path className="gd-orbit-path" data-collide={p.collide || undefined} d={p.orbit.back} />}
      <g transform={`translate(${stage.star.x.toFixed(2)} ${stage.star.y.toFixed(2)})`}>
        <BodyFigure art={starArt} uid={`${props.uid}-s`} />
      </g>
      {p !== null && <path className="gd-orbit-nearest" d={p.nearest.front} />}
      {p !== null && <path className="gd-orbit-path" data-collide={p.collide || undefined} d={p.orbit.front} />}
      {p !== null && planetArt !== null && (
        <g className="gd-orbit-planet" data-collide={p.collide || undefined} transform={`translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`}>
          <BodyFigure art={planetArt} uid={`${props.uid}-p`} />
        </g>
      )}
    </svg>
  );
}

/** 网格布：线色是三级墨，往远处（画框上沿）渐隐 */
function GridLayer(props: { lines: readonly GridLine[]; box: WellBox; id: string; depth: number }) {
  const maxSag = props.lines.reduce((max, line) => Math.max(max, line.sag), 0);
  return (
    <g className="gd-grid" data-depth={props.depth.toFixed(2)} data-max-sag={maxSag.toFixed(2)} data-lines={props.lines.length}>
      <defs>
        <linearGradient id={props.id} gradientUnits="userSpaceOnUse" x1={0} y1={props.box.y} x2={0} y2={props.box.y + props.box.h}>
          <stop offset="0" className="gd-grid-stop" stopOpacity={0.1} />
          <stop offset="0.5" className="gd-grid-stop" stopOpacity={0.75} />
          <stop offset="1" className="gd-grid-stop" stopOpacity={1} />
        </linearGradient>
      </defs>
      {props.lines.map((line) => (
        <path key={line.key} className="gd-grid-line" data-along={line.along} d={line.d} stroke={`url(#${props.id})`} />
      ))}
    </g>
  );
}

