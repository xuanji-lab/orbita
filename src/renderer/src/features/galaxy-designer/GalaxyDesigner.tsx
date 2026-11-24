import "./galaxy-designer.css";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/workspace";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelGroupHead, PanelHelp, PanelLine, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { Segmented, Switch } from "../settings/SettingControls";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { MASS_UNIT_PER_EARTH,
  commitPlanet,
  BACKDROPS,
  bodyArt,
  clampValue,
  bodyDensity,
  createStar,
  mixOf,
  starMixOf,
  withMix,
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
  selectPlanet,
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
import { galaxyDesigns, persistDesign } from "./useGalaxyDesign.ts";
import type { DesignerFocus } from "../chat/galaxy-actions.ts";
import { useGalaxyTilt } from "../chat/galaxy-tilt.ts";
import { useProtoVariants } from "../chat/proto-variants-store.ts";
import { nameOrderOf } from "../chat/proto-variants.ts";
import { eyeStyleOf, storyLineOf } from "./design.ts";
import { EYE_STYLES, type EyeStyle } from "@shared/planet-design";
import { BodyFigure } from "./StarFigure.tsx";
import { NewSubAgentForm, RoleSection } from "./SubAgentRole.tsx";
import { PLANET_AGENTS_MAX } from "@shared/planet-design";
import { MixSection } from "./MixSection.tsx";
import { AvatarSection } from "./AvatarSection.tsx";
import type { PlanetMix } from "@shared/planet-design";
import { cssColorOf, mixColor } from "./mix.ts";
import { flatStage, ORBIT_BOX, orbitStage, previewPlan, starStage, type GridLine, type WellBox } from "./well.ts";
import { DETAIL_GAP, detailScale, externalTangents, LOUPE_DEFAULT_WIDTH, LOUPE_VIEW, loupeFrame, MARK_GAP, type LoupeFrame } from "./loupe.ts";

/**
 * 星系设计（原型，proto/planet-designer）：侧栏工作区行悬停出现的画笔键打开它，住在右栏面板位里。
 * 版式照 Nuphos「New Bot」的组织：预览在上 → 读数 → 参数与元素 → 预览背景；但没有人脸网格，
 * 全是参数与开关——同一套规则下的组合，不是抽卡。
 *
 * 预览：主星页是主星压在一张弯曲的网格布上（引力的示意画法，质量越大坑越深，well.ts）；
 * 行星页是行星自己的大头像 + 一块小场景（同一张网格布上的主星与这颗行星的轨道）。
 * 行星依赖主星：没有主星时行星页是「先创建主星」的空态。加行星 = 新建子智能体（名字 + 职能，SubAgentRole.tsx 的表单，
 * 主进程放到默认空轨道）——每颗行星都有档案；不再加一颗没有职能的示例行星。
 *
 * 设计稿的真源是工作区文件夹里的 planet/（与插件 planet-forge 同一份）：面板里的修改去抖后写回（persistDesign），
 * 插件稿只改名字与质量，元素、轨道、子智能体名单进伴随文件 planet/galaxy.json。
 */

/** 设计稿仓库是全应用一份（useGalaxyDesign.ts）：面板写，侧栏头像与工作区页的星系读 */
const store = galaxyDesigns;

export function GalaxyDesigner(props: { workspace: Workspace | null; focus?: DesignerFocus | null }) {
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
  return <Designer key={props.workspace.id} workspace={props.workspace} focus={props.focus ?? null} />;
}

function Designer(props: { workspace: Workspace; focus: DesignerFocus | null }) {
  const t = useT();
  const tg = t.galaxyDesigner;
  const id = props.workspace.id;
  const [design, setDesignState] = useState<GalaxyDesign>(() => store.get(id));
  const setDesign = (next: GalaxyDesign): void => {
    store.set(id, next);
    setDesignState(store.get(id));
    persistDesign(id);
  };
  const planets = design.planets ?? [];
  // 仓库里的这一份被别处换了（聊天里建 / 改了子智能体，App 重读了盘）：跟上，不留着旧名单
  useEffect(
    () =>
      store.subscribe(() => {
        const next = store.get(id);
        setDesignState((current) => (current === next ? current : next));
      }),
    [id],
  );
  // 正在新建子智能体（表单替换下面的参数区）；建好或取消就收起，新行星那一页由 App 收到广播后落过去
  const [creating, setCreating] = useState(false);
  // 星系上点了主星 / 行星：落到那一页（nonce 变了才落，挂上时也落一次）。只改「正在编辑哪颗」，不动参数
  const focus = props.focus;
  useEffect(() => {
    if (focus === null) return;
    const current = store.get(id);
    if (focus.kind === "star") {
      if (current.editing !== "star") setDesign({ ...current, editing: "star" });
      return;
    }
    const list = current.planets ?? [];
    const index = list.findIndex((planet, i) => (planet.id ?? `planet-${i + 1}`) === focus.id);
    if (index >= 0) {
      setCreating(false);
      setDesign(selectPlanet(current, index));
    }
    // eslint 不在本仓；依赖只认 nonce：同一颗连点两次也要重新落位
  }, [focus?.nonce]);
  // 名字：工作区名为主、智能体名为副（候选 agentName=on 时反过来），与页头同一个顺序
  const variants = useProtoVariants();
  const names = nameOrderOf(variants.agentName, props.workspace.name, design.star?.name ?? "");
  const kind = design.editing;
  const body: BodyDesign | PlanetDesign | null = kind === "star" ? design.star : design.planet;
  const patchBody = (patch: Partial<PlanetDesign>): void => {
    if (kind === "star") {
      if (design.star === null) return;
      const { composition: _c, orbitRadius: _o, ...rest } = patch;
      setDesign({ ...design, star: { ...design.star, ...rest } });
    } else {
      if (design.planet === null) return;
      // 在行星页改了它 = 用户要这颗行星：草稿进名单（之后才画、才写盘）
      setDesign(commitPlanet({ ...design, planet: { ...design.planet, ...patch } }));
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
            {names.primary}
          </span>
          {names.secondary !== null && <span className="gd-cap-agent">{names.secondary}</span>}
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
                {tg.readout.density}<b>{formatNumber(Math.round(bodyDensity(design, kind) * 100) / 100)}</b>
              </span>
              <span>
                {tg.readout.mass}<b>{`${formatNumber(earth(body.mass))} M⊕`}</b>
              </span>
              {kind === "planet" && design.planet !== null && (
                <span>
                  {tg.readout.orbit}<b>{formatNumber(design.planet.orbitRadius)}</b>
                </span>
              )}
            </p>
          )}
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
        {/* 主星的一句故事 / 行星的职责：插件稿与伴随文件里来，只读 */}
        {/* 故事只留第一句（插件稿里是一段抒情长句，设计审查 R16） */}
        {body !== null && typeof body.note === "string" && storyLineOf(body.note) !== "" && (
          <p className="gd-who gd-note" data-kind={kind} title={body.note}>
            {storyLineOf(body.note)}
          </p>
        )}
        {/*
          一个选择器挑「在改哪颗天体」：主星 | 每颗子智能体（设计审查 R13：原来的「天体类型 主星 / 行星」看着像能把行星改成主星，
          其实只是切页；两套切换上下分开放）。还没有行星时多一个「行星」，落到添加行星的空页
        */}
        <Row name={tg.bodyGroup}>
          <Segmented<string>
            label={tg.bodyGroup}
            value={kind === "star" ? "star" : planets.length > 0 ? `p${design.planetIndex ?? 0}` : "planet"}
            options={[
              { value: "star", label: tg.starOption((design.star?.name ?? "").trim() || props.workspace.name) },
              ...(planets.length > 0
                ? planets.map((planet, index) => ({ value: `p${index}`, label: planet.name || tg.unnamedPlanet }))
                : [{ value: "planet", label: tg.planet }]),
            ]}
            onChange={(value) => {
              if (value === "star") setDesign({ ...design, editing: "star" });
              else if (value === "planet") setDesign({ ...design, editing: "planet" });
              else setDesign(selectPlanet(design, Number(value.slice(1))));
              setCreating(false);
            }}
          />
        </Row>
        {/* 新建子智能体（与聊天里的 create_sub_agent 写同一份档案）：有主星、名单没满才给 */}
        {design.star !== null && !creating && planets.length > 0 && planets.length < PLANET_AGENTS_MAX && (
          <span className="gd-new-entry">
            <button type="button" className="gd-link" data-action="new-subagent" onClick={() => setCreating(true)}>
              <Icon name="plus" size={12} strokeWidth={1.8} />
              <span>{tg.newAgent}</span>
            </button>
          </span>
        )}
        {creating && design.star !== null ? (
          <NewSubAgentForm workspaceId={id} count={planets.length} onDone={() => setCreating(false)} />
        ) : body === null ? (
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
              <PanelEmpty icon="orbit" hint={tg.newAgentHint} exit={{ label: tg.newAgent, onClick: () => setCreating(true) }}>
                {tg.noPlanet}
              </PanelEmpty>
            )}
          </div>
        ) : (
          <>
            {kind === "planet" && <PanelGroupHead label={tg.roleGroup} />}
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
            {/* 行星页的「职能」：职能提示词、来源、待出图、删除（档案 planet/agents/<id>/agent.json） */}
            {kind === "planet" && design.planet !== null && (
              <>
                <RoleSection workspaceId={id} planet={design.planet} />
                <PanelGroupHead label={tg.bodyParamsGroup} />
              </>
            )}
            <Row
              name={tg.mass}
              desc={kind === "star" ? tg.starMassDesc(formatNumber(earth(range.min)), formatNumber(earth(range.max))) : tg.massDesc(formatNumber(earth(range.min)), formatNumber(earth(range.max)))}
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
              <NumberField
                value={earth(body.mass)}
                label={tg.mass}
                field="mass"
                invalid={errorsAt(errors, kind, "mass").length > 0}
                onChange={(mass) => patchBody({ mass: mass * MASS_UNIT_PER_EARTH })}
              />
            </Row>
            {kind === "planet" && design.planet !== null ? (
              // 成分 = 元素构成（周期表），替掉原来的岩石 / 冰质 / 气态三选一；类别由构成推出的密度归（withMix）
              <Row name={tg.composition} desc={tg.mix.desc} wide>
                <MixSection
                  mix={mixOf(design.planet)}
                  cls={design.planet.composition}
                  onChange={(mix) => {
                    if (design.planet === null) return;
                    const next = withMix(design.planet, mix);
                    patchBody({ mix: next.mix, composition: next.composition });
                  }}
                />
              </Row>
            ) : (
              // 主星：构成只影响颜色提示与科普，密度照旧固定（规则：主星是等离子，只能调质量定大小）
              design.star !== null && (
                <Row name={tg.composition} desc={tg.starComposition} wide>
                  <MixSection mix={starMixOf(design.star, id)} cls="star" onChange={(mix) => patchBody({ mix })} />
                </Row>
              )
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

            {/* 形象：选完元素的下一步——按插件的出图原则出候选、挑一张（AvatarSection.tsx） */}
            {design.star !== null && (
              <AvatarSection
                workspaceId={id}
                bodyId={kind === "star" ? "main" : (design.planet?.id ?? null)}
                kind={kind}
                design={design}
                name={(body.name.trim() || nameFallback).slice(0, 200)}
                mix={kind === "planet" && design.planet !== null ? mixOf(design.planet) : starMixOf(design.star, id)}
                hasSurface={body.surface !== null && body.surface !== undefined}
              />
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
            {/* 眼睛样式：每颗天体自己 DIY（存进 planet/galaxy.json）；关了眼睛就不显示这一行 */}
            {body.elements.eyes && (
              <Row name={tg.eyeStyle} desc={tg.eyeStyleDesc} wide>
                <span className="gd-eye-style" data-field="eye-style">
                  <Segmented<EyeStyle>
                    label={tg.eyeStyle}
                    value={eyeStyleOf(body)}
                    options={EYE_STYLES.map((style) => ({
                      value: style,
                      title: style === "xl-white" ? tg.eyeOffRuleTip : undefined,
                      label:
                        style === "xl-white" ? (
                          <>
                            {tg.eyeStyles[style]}
                            <span className="gd-off-rule">{tg.eyeOffRule}</span>
                          </>
                        ) : (
                          tg.eyeStyles[style]
                        ),
                    }))}
                    onChange={(eyeStyle) => patchBody({ eyeStyle })}
                  />
                </span>
              </Row>
            )}

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

/**
 * 质量在界面上一律写 M⊕（设计审查 R14：面板写 600、插件稿写 60 M⊕，两套单位）。设计稿内部仍是 M⊕ × 10
 * （星系几何按它算），只在显示与输入时换算。
 */
function earth(mass: number): number {
  return mass / MASS_UNIT_PER_EARTH;
}

function errorText(error: DesignError, t: Messages): string {
  const tg = t.galaxyDesigner;
  if (error.kind === "mass-range") {
    return tg.errors.massRange(error.body === "star" ? tg.star : tg.planet, formatNumber(earth(error.value)), formatNumber(earth(error.min)), formatNumber(earth(error.max)));
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
          <g
            className={star.mix === undefined ? undefined : "gd-tinted"}
            style={tintOf(star.mix)}
            transform={`translate(${stage.star.x.toFixed(2)} ${stage.star.y.toFixed(2)}) scale(${s})`}
          >
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
  if (planet !== null) {
    return <PlanetLoupe design={design} planet={planet} uid={uid} name={planet.name || tg.unnamedPlanet} common={common} />;
  }
  // 有主星、还没有行星：只有轨道场景里的主星（没有可放大的东西，不画引线）
  return (
    <figure className="gd-stage" data-body="planet" data-empty="no-planet" {...common}>
      <OrbitScene design={design} uid={`${uid}-o`} label={tg.orbitFigure(props.workspaceName)} />
    </figure>
  );
}

/**
 * 颜色提示：只给面板里改过构成的天体上色（没改过的照旧墨色，与页面星系、侧栏头像一致）；
 * 有地表图时图盖在上面，提示只在代码画的球上看得到。
 */
function tintOf(mix: PlanetMix | undefined): React.CSSProperties | undefined {
  const hint = mix === undefined ? null : mixColor(mix);
  return hint === null ? undefined : ({ "--gd-tint": cssColorOf(hint) } as React.CSSProperties);
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
  // 与页面星系同一个俯角（设置 › 外观 › 星系倾角）
  const stage = orbitStage(props.design, useGalaxyTilt());
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

/**
 * 量画框的内容宽（CSS px）：ResizeObserver 只在面板宽度变了时回调，整数宽不变 React 不重画。
 * 公转 / 拖滑块都不经过这里——它们只改设计稿，几何在渲染里重算成 SVG 属性，不读布局、不触发重排。
 */
function useContentWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(LOUPE_DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(Math.round(el.clientWidth) || LOUPE_DEFAULT_WIDTH);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return width;
}

/** 网格淡出带：从场景块的 70% 处到分隔线那一边（左右排沿 x、上下排沿 y） */
function edgeFade(frame: LoupeFrame): { x1: number; y1: number; x2: number; y2: number } {
  const b = frame.scene;
  return frame.layout === "side"
    ? { x1: b.x + b.w * 0.7, y1: 0, x2: b.x + b.w, y2: 0 }
    : { x1: 0, y1: b.y + b.h * 0.7, x2: 0, y2: b.y + b.h };
}

/**
 * 行星页：一张卡里画「引力场里的这颗行星」和「这颗行星的大形象」，两根虚线引线把场景里的小身影连到大形象
 * （技术图纸的局部放大，2026-11-24 用户草图）。宽时左右排、窄时上下排（loupe.ts 定阈值与几何）。
 * 引力场：主星压出的坑随主星质量变深；行星在轨道上的位置随轨道半径走。大形象随行星质量变大变小。
 * 三样都只改 SVG 属性：引线端点跟着重算，不经过 DOM 布局。
 */
function PlanetLoupe(props: {
  design: GalaxyDesign;
  planet: PlanetDesign;
  uid: string;
  name: string;
  common: Record<string, string | boolean | undefined>;
}) {
  const t = useT();
  const tg = t.galaxyDesigner;
  const { design, planet, uid } = props;
  const figureRef = useRef<HTMLElement | null>(null);
  const width = useContentWidth(figureRef);
  const tilt = useGalaxyTilt();
  const frame = loupeFrame(width);
  const stage = orbitStage(design, tilt, { box: frame.scene, ...LOUPE_VIEW[frame.layout] });
  const p = stage?.planet ?? null;
  // 大形象：与原来的大头像同一个形象、同一套缩放规矩（质量变 → 大小变；预览缩放乘在上面）
  const r = displayRadius(radiusOf(design, "planet"));
  const art = bodyArt(design, "planet", r);
  const k = detailScale(frame.detail, art.extent, planet.zoom);
  const big = { x: frame.detail.x + frame.detail.w / 2, y: frame.detail.y + frame.detail.h / 2 };
  const small = stage === null ? null : sceneDesign(design, stage.star.r, p?.r ?? 0);
  const starArt = stage === null || small === null ? null : bodyArt(small, "star", stage.star.r);
  const planetArt = p === null || small === null ? null : bodyArt(small, "planet", p.r);
  const mark = p === null || planetArt === null ? null : { x: p.x, y: p.y, r: planetArt.r + MARK_GAP };
  const leaders = mark === null ? null : externalTangents(mark, { ...big, r: art.r * k + DETAIL_GAP });
  const clip = `${uid}-scene`;
  const fixed = (value: number): string => value.toFixed(1);
  const tintHint = planet.mix === undefined ? null : mixColor(planet.mix);
  const tint = tintOf(planet.mix);
  const tintClass = tint === undefined ? "" : " gd-tinted";
  return (
    <figure ref={figureRef} className="gd-stage gd-loupe-stage" data-body="planet" data-layout={frame.layout} {...props.common}>
      <svg
        className="gd-loupe"
        viewBox={`0 0 ${frame.w} ${frame.h}`}
        role="img"
        aria-label={`${tg.figure(props.name)} · ${tg.orbitFigure(props.name)}`}
        data-layout={frame.layout}
        data-width={frame.w}
        data-body="planet"
        data-surface={art.surface}
        data-display-r={r.toFixed(2)}
        data-zoom={planet.zoom}
        data-elements={onElements(planet, "planet").join(" ")}
        data-depth={stage?.depth.toFixed(2)}
        data-star-r={stage?.star.r.toFixed(2)}
        data-orbit-a={p?.a.toFixed(2)}
        data-planet-x={p?.x.toFixed(2)}
        data-planet-y={p?.y.toFixed(2)}
        data-planet-r={p?.r.toFixed(2)}
        data-detail-scale={k.toFixed(3)}
        data-collide={p?.collide || undefined}
      >
        <defs>
          <clipPath id={clip}>
            <rect x={frame.scene.x} y={frame.scene.y} width={frame.scene.w} height={frame.scene.h} />
          </clipPath>
          {/* 网格朝分隔线那一侧淡出（左右排往右、上下排往下）：两幅视图之间靠留白与一道发丝线分开，不是网格的硬边 */}
          <linearGradient id={`${uid}-edge`} gradientUnits="userSpaceOnUse" {...edgeFade(frame)}>
            <stop offset="0" className="gd-loupe-edge-stop" stopOpacity={1} />
            <stop offset="1" className="gd-loupe-edge-stop" stopOpacity={0} />
          </linearGradient>
          <mask id={`${uid}-edge-mask`} className="gd-loupe-edge-mask" maskUnits="userSpaceOnUse" x={frame.scene.x} y={frame.scene.y} width={frame.scene.w} height={frame.scene.h}>
            <rect x={frame.scene.x} y={frame.scene.y} width={frame.scene.w} height={frame.scene.h} fill={`url(#${uid}-edge)`} />
          </mask>
        </defs>
        {stage !== null && starArt !== null && (
          <g className="gd-loupe-scene" clipPath={`url(#${clip})`}>
            <g mask={`url(#${uid}-edge-mask)`}>
              <GridLayer lines={stage.grid} box={frame.scene} id={`${uid}-fade`} depth={stage.depth} />
            </g>
            {p !== null && <path className="gd-orbit-nearest" d={p.nearest.back} />}
            {p !== null && <path className="gd-orbit-path" data-collide={p.collide || undefined} d={p.orbit.back} />}
            <g transform={`translate(${fixed(stage.star.x)} ${fixed(stage.star.y)})`}>
              <BodyFigure art={starArt} uid={`${uid}-s`} />
            </g>
            {p !== null && <path className="gd-orbit-nearest" d={p.nearest.front} />}
            {p !== null && <path className="gd-orbit-path" data-collide={p.collide || undefined} d={p.orbit.front} />}
            {p !== null && planetArt !== null && (
              <g className={`gd-orbit-planet${tintClass}`} style={tint} data-collide={p.collide || undefined} transform={`translate(${fixed(p.x)} ${fixed(p.y)})`}>
                <BodyFigure art={planetArt} uid={`${uid}-p`} />
              </g>
            )}
            {/* 被放大的那一颗：球外描一圈与引线同样的虚线，小到 5px 也找得到 */}
            {mark !== null && <circle className="gd-loupe-mark" cx={fixed(mark.x)} cy={fixed(mark.y)} r={fixed(mark.r)} />}
          </g>
        )}
        <line className="gd-loupe-divider" x1={frame.divider.x1} y1={frame.divider.y1} x2={frame.divider.x2} y2={frame.divider.y2} />
        {leaders !== null &&
          leaders.map((line, index) => (
            <line
              key={index === 0 ? "a" : "b"}
              className="gd-loupe-leader"
              data-leader={index === 0 ? "a" : "b"}
              x1={fixed(line.x1)}
              y1={fixed(line.y1)}
              x2={fixed(line.x2)}
              y2={fixed(line.y2)}
            />
          ))}
        <g className={`gd-loupe-detail${tintClass}`} style={tint} data-tint={tintHint === null ? undefined : cssColorOf(tintHint)} transform={`translate(${fixed(big.x)} ${fixed(big.y)}) scale(${k.toFixed(4)})`}>
          <BodyFigure art={art} uid={uid} />
        </g>
      </svg>
      <figcaption className="gd-stage-name" title={props.name}>
        {props.name}
      </figcaption>
    </figure>
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

