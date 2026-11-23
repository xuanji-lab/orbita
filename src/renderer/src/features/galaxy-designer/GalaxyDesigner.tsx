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
  BACKDROPS,
  bodyArt,
  clampValue,
  createDesignStore,
  densityOf,
  designLevelOf,
  displayRadius,
  ELEMENTS_OF,
  errorsAt,
  formatNumber,
  massRange,
  maxOrbit,
  minOrbit,
  ORBIT_RANGE,
  parseNumberInput,
  previewFrame,
  radiusOf,
  validateDesign,
  ZOOM,
  type BodyArt,
  type BodyKind,
  type DesignError,
  type ElementKey,
  type GalaxyDesign,
} from "./design.ts";

/**
 * 星系设计（原型，proto/planet-designer）：侧栏工作区行悬停出现的画笔键打开它，住在右栏面板位里。
 * 版式照 Nuphos「New Bot」的组织：预览在上 → 读数 → 参数与元素 → 预览背景；但没有人脸网格，
 * 全是参数与开关——同一套规则下的组合，不是抽卡。
 *
 * 只做面板与预览：不写配置、不接 agent 数据。设计稿按工作区存在这次运行的内存里（design.ts 的 DesignStore）。
 */

/** 页面地址在一次加载里不变：`?designer=bare|full` 定 fixture 档，模块加载时建一次仓库 */
const store = createDesignStore(designLevelOf(window.location.search));

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
    setDesignState(next);
  };
  const kind = design.editing;
  const body = kind === "star" ? design.star : design.planet;
  const patchBody = (patch: Partial<GalaxyDesign["planet"]>): void => {
    if (kind === "star") {
      const { composition: _c, orbitRadius: _o, ...rest } = patch;
      setDesign({ ...design, star: { ...design.star, ...rest } });
    } else {
      setDesign({ ...design, planet: { ...design.planet, ...patch } });
    }
  };
  const errors = validateDesign(design);
  const radius = radiusOf(design, kind);
  const range = massRange(kind);
  const nameFallback = kind === "star" ? props.workspace.name : tg.unnamedPlanet;

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
        <div className="gd gd-head">
        <Preview design={design} workspaceName={props.workspace.name} invalid={invalidFor(errors, kind)} />
        <p className="gd-readout" data-testid="gd-readout">
          <span>
            {tg.readout.radius}<b data-radius={radius.toFixed(4)}>{formatNumber(radius)}</b>
          </span>
          <span>
            {tg.readout.density}<b>{formatNumber(densityOf(kind, design.planet.composition))}</b>
          </span>
          <span>
            {tg.readout.mass}<b>{formatNumber(body.mass)}</b>
          </span>
          {kind === "planet" && (
            <span>
              {tg.readout.orbit}<b>{formatNumber(design.planet.orbitRadius)}</b>
            </span>
          )}
        </p>
        <ScaleStrip design={design} label={tg.strip} />
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
        <PanelGroupHead label={tg.bodyGroup} />
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
          desc={tg.massDesc(formatNumber(range.min), formatNumber(range.max))}
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
        {kind === "planet" ? (
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
        {kind === "planet" && (
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
              value={design.zoom}
              aria-label={tg.zoom}
              data-field="zoom"
              onChange={(event) => setDesign({ ...design, zoom: Number(event.target.value) })}
            />
          }
        >
          <span className="gd-value">{design.zoom}%</span>
        </Row>
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
  return errors.some((error) => error.kind === "orbit-collision" || (error.kind === "orbit-far" ? kind === "planet" : error.body === kind));
}

function errorText(error: DesignError, t: Messages): string {
  const tg = t.galaxyDesigner;
  if (error.kind === "mass-range") {
    return tg.errors.massRange(error.body === "star" ? tg.star : tg.planet, formatNumber(error.value), formatNumber(error.min), formatNumber(error.max));
  }
  if (error.kind === "orbit-collision") return tg.errors.collision(formatNumber(error.value), formatNumber(error.min));
  if (error.kind === "orbit-far") return tg.errors.far(formatNumber(error.value), formatNumber(error.max));
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

/** 预览：只画正在编辑的那一颗，居中；缩放只作用在预览上 */
function Preview(props: { design: GalaxyDesign; workspaceName: string; invalid: boolean }) {
  const t = useT();
  const tg = t.galaxyDesigner;
  const uid = useId().replace(/:/g, "");
  const { design } = props;
  const kind = design.editing;
  const radius = radiusOf(design, kind);
  const r = displayRadius(radius);
  const art = bodyArt(design, kind, r);
  const frame = previewFrame(art);
  const name = (kind === "star" ? design.star.name : design.planet.name) || (kind === "star" ? props.workspaceName : tg.unnamedPlanet);
  const on = ELEMENTS_OF[kind].filter((key: ElementKey) => (kind === "star" ? design.star : design.planet).elements[key]);
  return (
    <figure className="gd-stage" data-backdrop={design.backdrop} data-invalid={props.invalid || undefined}>
      <svg
        className="gd-preview"
        viewBox={`${-frame.halfW} ${-frame.halfH} ${frame.halfW * 2} ${frame.halfH * 2}`}
        data-frame-scale={frame.scale.toFixed(3)}
        role="img"
        aria-label={tg.figure(name)}
        data-body={kind}
        data-surface={art.surface}
        data-display-r={r.toFixed(2)}
        data-zoom={design.zoom}
        data-elements={on.join(" ")}
      >
        <g transform={`scale(${design.zoom / 100})`}>
          <BodyFigure art={art} uid={uid} />
        </g>
      </svg>
      <figcaption className="gd-stage-name" title={name}>
        {name}
      </figcaption>
    </figure>
  );
}

function BodyFigure(props: { art: BodyArt; uid: string }) {
  const { art, uid } = props;
  const clip = `${uid}-clip`;
  const light = `${uid}-light`;
  const halo = `${uid}-halo`;
  return (
    <g className="gd-body" data-surface={art.surface}>
      <defs>
        <clipPath id={clip}>
          <circle r={art.r} />
        </clipPath>
        <radialGradient id={light} cx="50%" cy="50%" r="50%" fx="34%" fy="30%">
          <stop offset="0%" className="gd-light" stopOpacity={0.62} />
          <stop offset="100%" className="gd-light" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={halo} cx="50%" cy="50%" r="50%">
          <stop offset="60%" className="gd-halo" stopOpacity={0.28} />
          <stop offset="100%" className="gd-halo" stopOpacity={0} />
        </radialGradient>
      </defs>
      {art.corona !== null && (
        <g className="gd-corona">
          <circle r={art.corona.halo} fill={`url(#${halo})`} />
          <circle className="gd-corona-line" r={art.corona.r} />
        </g>
      )}
      {art.moons
        .filter((moon) => moon.behind)
        .map((moon) => (
          <circle key={`${moon.x}`} className="gd-moon" data-behind="true" cx={moon.x} cy={moon.y} r={moon.r} />
        ))}
      {art.ring !== null && (
        <path className="gd-ring gd-ring-back" d={art.ring.back} transform={`rotate(${art.ring.tilt})`} strokeWidth={art.ring.width} />
      )}
      <circle className="gd-surface" r={art.r} />
      <g clipPath={`url(#${clip})`}>
        {art.bands.map((band) => (
          <rect key={band.y} className="gd-band" x={-art.r} y={band.y} width={art.r * 2} height={band.h} />
        ))}
        {art.cap !== null && <ellipse className="gd-cap" cx={art.cap.cx} cy={art.cap.cy} rx={art.cap.rx} ry={art.cap.ry} />}
        {art.cracks.map((d) => (
          <path key={d} className="gd-crack" d={d} />
        ))}
        {art.craters.map((crater) => (
          <circle key={`${crater.x}`} className="gd-crater" cx={crater.x} cy={crater.y} r={crater.r} />
        ))}
        {art.clouds.map((cloud) => (
          <rect key={cloud.y} className="gd-cloud" x={cloud.x} y={cloud.y} width={cloud.w} height={cloud.h} rx={cloud.h / 2} />
        ))}
        <circle r={art.r} fill={`url(#${light})`} />
      </g>
      {art.face !== null && (
        <g className="gd-face">
          {art.face.eyes.map((eye) => (
            <circle key={eye.x} cx={eye.x} cy={eye.y} r={eye.r} />
          ))}
          <path d={art.face.mouth} strokeWidth={art.face.stroke} />
        </g>
      )}
      {art.ring !== null && (
        <path className="gd-ring gd-ring-front" d={art.ring.front} transform={`rotate(${art.ring.tilt})`} strokeWidth={art.ring.width} />
      )}
      {art.moons
        .filter((moon) => !moon.behind)
        .map((moon) => (
          <circle key={`${moon.x}`} className="gd-moon" cx={moon.x} cy={moon.y} r={moon.r} />
        ))}
    </g>
  );
}

/**
 * 真实比例的侧视条：主星在左缘（只露半边），行星在它的轨道半径处，半径与轨道同一单位——
 * 预览为了读得出表情压了大小差距，这里给出没压过的样子；相撞时行星与主星叠在一起，并标红。
 */
function ScaleStrip(props: { design: GalaxyDesign; label: string }) {
  const { design } = props;
  const width = 320;
  const height = 40;
  const scale = (width - 12) / (ORBIT_RANGE.max + 3);
  const star = radiusOf(design, "star") * scale;
  const planet = radiusOf(design, "planet") * scale;
  const orbit = Number.isFinite(design.planet.orbitRadius) ? design.planet.orbitRadius : 0;
  const x = orbit * scale;
  const near = minOrbit(design) * scale;
  const collide = orbit < minOrbit(design);
  const mid = height / 2;
  return (
    <figure className="gd-strip">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.label} data-collide={collide || undefined} data-orbit-x={x.toFixed(2)}>
        <line className="gd-strip-axis" x1={0} y1={mid} x2={width} y2={mid} />
        <line className="gd-strip-near" x1={near} y1={4} x2={near} y2={height - 4} />
        <circle className="gd-strip-star" cx={0} cy={mid} r={star} />
        <circle className="gd-strip-planet" data-collide={collide || undefined} cx={x} cy={mid} r={Math.max(planet, 1.5)} />
      </svg>
      <figcaption>{props.label}</figcaption>
    </figure>
  );
}
