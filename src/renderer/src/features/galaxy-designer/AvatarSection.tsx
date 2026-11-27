import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  AVATAR_INSTRUCTION_MAX,
  isAvatarJobLive,
  type AvatarBackend,
  type AvatarHistory,
  type AvatarHistoryCandidate,
  type AvatarJob,
  type AvatarRenderMode,
  type AvatarRenderPolicyResult,
  type AvatarSlot,
} from "@shared/planet-avatar";
import type { PlanetMix } from "@shared/planet-design";
import { lastUsedPair, type AvatarModelChoice } from "@shared/settings";
import { api } from "../../api";
import { Chip } from "../../shell/Chip";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelGroupHead } from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { inheritedRow, ModelPickerMenu, modelChipParts, usableProviders } from "../settings/model-menu";
import { InfoTip } from "../settings/InfoTip";
import { Switch } from "../settings/SettingControls";
import { avatarModelFace, type AvatarModelSource } from "./avatar-model.ts";
import { avatarNotes, avatarRenderNote, avatarRenderSwitchTitle } from "./avatar-render.ts";
import { bodyArt, planetFaceDesign, type BodyKind, type GalaxyDesign } from "./design.ts";
import { BodyFigure } from "./StarFigure.tsx";

/**
 * 设计面板的「形象」一节（选完元素之后的下一步）：点「生成形象」→ 主进程开幕后会话跑插件「行星造物」的 planet-render，
 * 按用户的出图原则出 2–3 张无脸地表候选 → 这里一张张显示生成中 / 出来了 / 没出来（原因、降级到什么）→ 挑一张「用这张」写进 planet/。
 * 候选上的眼睛是代码画的（与侧栏、星系同一个 BodyFigure），地表才是候选。
 * 挑完主进程推 selected，App 的 usePlanetFiles 重读盘：侧栏头像、页头、星系、右栏星系图、面板预览五处同源换上。
 *
 * 这一组用哪个模型：动作行左边的模型胶囊（与输入卡、子会话面板同一张 ModelPickerMenu）。**点之前就写明**取法与型号
 * （跟会话栏 / 子会话模型 / 挑定的型号），胶囊上那一对 id 随请求发出去，主进程以请求为准——显示什么就用什么
 * （2026-11-25 用户：在会话栏换了两次模型，出图两次都是子会话默认的那家，点了才发现）。取法记在设置里，跨重启保留。
 *
 * 用不用生图工具：模型旁边的开关。真源是插件「行星造物」的策略文件（它原本只在对话里出图时问一次），面板读它、拨它都经
 * 插件的脚本；默认关 = 只让智能体手绘（用户 2026-11-25：「默认就是用手绘，就是模型画 SVG，然后边上有个开关说你可以用生图工具」）。
 */
export function AvatarSection(props: {
  workspaceId: string;
  /** "main" = 主星；行星 = galaxy.json 里的 id；还没落盘的行星草稿为 null */
  bodyId: string | null;
  kind: BodyKind;
  design: GalaxyDesign;
  name: string;
  mix: PlanetMix;
  /** 这颗天体此刻有没有地表图（没有 = 待出图，显示代码画的默认球） */
  hasSurface: boolean;
  /** 挑出图模型要用的东西（会话栏的模型、服务商、设置、星标），App 递下来 */
  modelSource: AvatarModelSource;
}) {
  const t = useT();
  const ta = t.galaxyDesigner.avatar;
  const { workspaceId, bodyId } = props;
  const instructionId = useId();
  const [job, setJob] = useState<AvatarJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<AvatarHistory | null>(null);
  const historySeq = useRef(0);
  /** 「用生图工具」开关：策略是插件级的（不分工作区、天体），挂上时读一次，拨动后拿主进程回的落定值 */
  const [renderPolicy, setRenderPolicy] = useState<AvatarRenderPolicyResult | null>(null);
  const [renderBusy, setRenderBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.planet
      .avatarRenderPolicy()
      .catch((cause: unknown): AvatarRenderPolicyResult => ({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }))
      .then((result) => {
        if (alive) setRenderPolicy(result);
      });
    return () => {
      alive = false;
    };
  }, []);

  const refreshHistory = useCallback(async (): Promise<void> => {
    const ticket = ++historySeq.current;
    if (bodyId === null) {
      setHistory(null);
      return;
    }
    const result = await api.planet.avatarHistory({ workspaceId, bodyId });
    if (ticket !== historySeq.current) return;
    if (result.ok) setHistory(result.history);
    else setError(result.error);
  }, [workspaceId, bodyId]);

  // 挂上 / 换天体：读这颗当前这一轮与历史（活任务，或盘上账本的最后一轮），再听进度推送
  useEffect(() => {
    setJob(null);
    setError(null);
    setPicked(null);
    setDraft("");
    setHistory(null);
    if (bodyId === null) return;
    let alive = true;
    void api.planet.avatarJob({ workspaceId, bodyId }).then((result) => {
      if (alive && result.ok) setJob((current) => current ?? result.job);
    });
    void refreshHistory();
    const off = api.planet.onAvatarJob(({ job: next }) => {
      if (next.workspaceId !== workspaceId || next.bodyId !== bodyId) return;
      setJob(next);
      if (!isAvatarJobLive(next)) void refreshHistory();
    });
    return () => {
      alive = false;
      historySeq.current += 1;
      off();
    };
  }, [workspaceId, bodyId, refreshHistory]);

  const live = isAvatarJobLive(job);
  // 下一组会用哪个模型：取法 → 型号 → 能不能用（与主进程兜底时同一个纯函数；型号名与模型菜单同一口径）
  const modelSource = props.modelSource;
  /** 换了取法 / 型号：上一回「挑不出型号 / 用不了」的红字说的已是另一个型号，收掉 */
  const chooseModel = (choice: AvatarModelChoice | null): void => {
    setError(null);
    modelSource.onChoiceChange(choice);
  };
  const face = avatarModelFace({
    choice: modelSource.settings.avatarModel,
    // 会话栏此刻的模型；主槽还没有（没配服务商、刚打开还没有默认）才退到上次用的
    session: modelSource.composerModel ?? lastUsedPair(modelSource.settings),
    settings: modelSource.settings,
    providers: modelSource.providers,
    catalog: modelSource.catalog,
    t,
  });
  const start = async (instruction?: string): Promise<void> => {
    if (bodyId === null || live || busy) return;
    // 挑不出型号、或它此刻用不了：就地报这一句，不开幕后会话（主进程那头同样的校验是给不带型号的调用方的）
    const pair = face.pair;
    if (pair === null || face.problem !== null) {
      setError(pair === null ? ta.modelNoneHint : (face.problem ?? ""));
      return;
    }
    setBusy(true);
    setError(null);
    setPicked(null);
    // 「再来一组」始终不以旧图为基础；只有「按这个改」把当前高亮 / 在用的那张作为基础
    const baseCandidateId = instruction === undefined ? undefined : (picked ?? job?.selected ?? undefined);
    const result = await api.planet.generateAvatar({
      workspaceId,
      bodyId,
      // 胶囊上写的型号就是这一组用的型号：主进程以请求为准，不再自己挑
      model: pair,
      mix: props.mix,
      name: props.name,
      ...(instruction === undefined ? {} : { instruction }),
      ...(baseCandidateId === undefined ? {} : { baseCandidateId }),
    });
    setBusy(false);
    if (result.ok) {
      setJob(result.job);
      if (instruction !== undefined) setDraft("");
      void refreshHistory();
    } else setError(result.error);
  };
  const revise = async (): Promise<void> => {
    const instruction = draft.trim();
    if (instruction === "") return;
    await start(instruction);
  };
  const use = async (candidateId: string): Promise<void> => {
    if (bodyId === null || live || busy) return;
    setBusy(true);
    setError(null);
    const result = await api.planet.selectAvatar({ workspaceId, bodyId, candidateId });
    setBusy(false);
    if (result.ok) {
      setJob(result.job);
      setPicked(null);
      void refreshHistory();
    } else setError(result.error);
  };
  const cancel = (): void => {
    if (bodyId !== null) void api.planet.cancelAvatar({ workspaceId, bodyId });
  };
  const renderOn = renderPolicy?.ok === true && renderPolicy.policy.mode === "image_tool";
  /** 开关说不清的情况（插件没装、策略文件读不出来、旧档、每次都问、自定义）在开关下面补一行 */
  const renderNote = avatarRenderNote(renderPolicy, t);
  const toggleRender = async (mode: AvatarRenderMode): Promise<void> => {
    if (renderBusy || live) return;
    setRenderBusy(true);
    setError(null);
    const result = await api.planet.setAvatarRenderPolicy({ mode });
    setRenderBusy(false);
    setRenderPolicy(result);
    if (!result.ok) setError(ta.renderFailed(result.error));
  };

  const slots = job?.slots ?? [];
  const chosen = picked ?? null;
  const baseCandidate = picked ?? job?.selected ?? null;
  const ended = job !== null && !live;
  const noneOut = ended && job.state === "pending";
  const usable = slots.filter((slot) => slot.state === "done");
  // 每一位都因同一个原因没出来（停下、超时、会话断了）：原因只写一次，不在每张下面重复
  const failedReasons = slots.map((slot) => (slot.state === "failed" ? slot.reason : null));
  const sharedReason = slots.length > 1 && failedReasons.every((reason) => reason !== null && reason === failedReasons[0]) ? failedReasons[0] ?? null : null;
  // 插件账本的说明（开关开着却没找到生图工具、临时换了后端……）：照实写，别让人以为图是生图工具出的
  const notes = avatarNotes(job?.notes ?? []);
  // 出图中：胶囊显示这一组实际在用的型号（主进程开轮时定的那一对），不许换——换了也只对下一组生效
  const liveParts = live && job !== null && job.model !== null ? modelChipParts(modelSource.providers, modelSource.catalog, job.model) : null;
  const pickedParts = face.pair === null ? null : modelChipParts(modelSource.providers, modelSource.catalog, face.pair);
  const choice = modelSource.settings.avatarModel;
  const chipParts = live ? liveParts : pickedParts;
  const actsRef = useRef<HTMLSpanElement | null>(null);
  /** 用户在这颗胶囊上换了取法：动作行可能因此从一行变两行（型号名长时主操作换到下一行）——把它带回可视区，别让「生成形象」掉到面板底下去 */
  const choiceKey = JSON.stringify(choice ?? null);
  const knownChoice = useRef<string | null>(null);
  useLayoutEffect(() => {
    const first = knownChoice.current === null;
    const changed = knownChoice.current !== choiceKey;
    knownChoice.current = choiceKey;
    if (first || !changed) return;
    actsRef.current?.scrollIntoView({ block: "nearest" });
  }, [choiceKey]);
  const chipTitle = live
    ? chipParts === null
      ? undefined
      : `${chipParts.name} · ${chipParts.detail}\n${ta.modelLive(chipParts.name)}`
    : chipParts === null
      ? ta.modelNoneHint
      : (face.problem ?? `${chipParts.name} · ${chipParts.detail}\n${face.hint}`);

  return (
    <div className="gd-avatar" data-avatar-state={job?.state ?? "none"} data-body-id={bodyId ?? undefined}>
      <PanelGroupHead label={ta.group} />
      <p className="gd-role-line gd-avatar-desc">{job?.policy === null || job?.policy === undefined ? ta.desc : ta.policy(job.policy)}</p>
      {bodyId === null ? (
        <p className="gd-role-line">{ta.unsaved}</p>
      ) : (
        <>
          <div className="gd-avatar-revise">
            <div className="gd-avatar-revise-head">
              <label className="gd-role-line" htmlFor={instructionId}>
                {baseCandidate === null ? ta.reviseFresh : ta.reviseBase(baseCandidate)}
              </label>
              <PanelButton disabled={busy || live || draft.trim() === ""} onClick={() => void revise()}>
                {ta.revise}
              </PanelButton>
            </div>
            <textarea
              id={instructionId}
              className="text-field gd-avatar-instruction"
              data-field="avatar-instruction"
              rows={2}
              maxLength={AVATAR_INSTRUCTION_MAX}
              value={draft}
              placeholder={ta.revisePlaceholder}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void revise();
                }
              }}
            />
          </div>
          {slots.length > 0 && (
            <ul className="gd-avatar-grid" aria-label={ta.group} data-count={slots.length}>
              {slots.map((slot) => (
                <CandidateTile
                  key={slot.slot}
                  slot={slot}
                  job={job as AvatarJob}
                  kind={props.kind}
                  design={props.design}
                  picked={chosen !== null && chosen === slot.candidateId}
                  inUse={job?.state === "selected" && job.selected !== null && job.selected === slot.candidateId}
                  onPick={() => setPicked(slot.candidateId)}
                  hideReason={sharedReason !== null}
                  t={t}
                />
              ))}
            </ul>
          )}
          {notes.length > 0 && (
            <div className="gd-avatar-notes" data-notes="avatar">
              {notes.map((note) => (
                <p className="gd-role-line gd-avatar-note" key={note}>
                  <Icon name="info" size={12} strokeWidth={1.8} />
                  <span>{note}</span>
                </p>
              ))}
            </div>
          )}
          {noneOut && !props.hasSurface && (
            <div className="gd-avatar-pending" role="status" data-pending="avatar">
              <p className="gd-avatar-pending-title">
                <Icon name="image" size={12} strokeWidth={1.8} />
                <span>{ta.pendingTitle}</span>
              </p>
              {sharedReason !== null && <p className="gd-role-line" data-reason="shared">{sharedReason}</p>}
              <p className="gd-role-line">{ta.pendingHint}</p>
            </div>
          )}
          {sharedReason !== null && !(noneOut && !props.hasSurface) && (
            <p className="gd-role-line" data-reason="shared">
              {sharedReason}
            </p>
          )}
          {job?.state === "ready" && usable.length > 0 && <p className="gd-role-line">{ta.readyHint}</p>}
          {job?.state === "selected" && <p className="gd-role-line" data-note="selected">{ta.selectedNote}</p>}
          {job?.error !== null && job?.error !== undefined && (
            <p className="gd-error" role="alert">
              <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
              <span>{job.error}</span>
            </p>
          )}
          {error !== null && (
            <p className="gd-error" role="alert">
              <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
              <span>{ta.error(error)}</span>
            </p>
          )}
          <span className="gd-avatar-acts" ref={actsRef}>
            {/* 用不用生图工具：开关 + 名字 + 说明。真源是插件的策略文件；插件没装、文件读不出来时不可拨，原因写在下面一行。
                排在模型前面：读的时候先定用什么画（手绘 / 生图工具），再定谁来画，最后才是「生成形象」；放不下一行时它在模型的上一行 */}
            <span className="gd-avatar-render" data-render-mode={renderOn ? "image_tool" : "hand_drawn"}>
              <Switch
                label={avatarRenderSwitchTitle(renderOn, t)}
                checked={renderOn}
                disabled={busy || live || renderBusy || renderPolicy === null || !renderPolicy.ok}
                onChange={(next) => void toggleRender(next ? "image_tool" : "hand_drawn")}
              />
              <span className="gd-avatar-render-label">{ta.renderSwitch}</span>
              <InfoTip label={ta.renderAbout}>
                {ta.renderInfo1}
                <br />
                {ta.renderInfo2}
              </InfoTip>
            </span>
            <ModelPickerMenu
              t={t}
              providers={usableProviders(modelSource.providers)}
              catalog={modelSource.catalog}
              // 取法解析出的型号在列表里亮着（左栏也落在它那家）：一眼看得到「跟会话栏」此刻是哪一个
              selected={live ? (job?.model ?? null) : face.pair}
              starred={modelSource.starredModels}
              onToggleStar={modelSource.onToggleStarModel}
              onSelect={(providerId, modelId) => chooseModel({ providerId, modelId })}
              leading={[
                // 第一组是两种取法（同设置面「同会话 / 同父」那一行），下面才是型号；当前取法打勾
                inheritedRow({
                  id: "avatar-model-follow",
                  label: ta.modelFollow,
                  hint: ta.modelFollowHint,
                  hintBelow: true,
                  inherited: choice === undefined,
                  onSelect: () => chooseModel(null),
                }),
                inheritedRow({
                  id: "avatar-model-sub-session",
                  label: t.settings.subSessionModel,
                  hint: ta.modelSubSessionHint,
                  hintBelow: true,
                  inherited: choice === "sub_session",
                  onSelect: () => chooseModel("sub_session"),
                }),
              ]}
              trigger={({ open, toggle }) => (
                <Chip
                  className="gd-avatar-model"
                  active={open}
                  chevron
                  disabled={live || busy}
                  leading={chipParts?.avatar}
                  title={chipTitle}
                  onClick={toggle}
                >
                  {!live && face.sourceLabel !== null && <span className="gd-avatar-model-source">{face.sourceLabel} · </span>}
                  {live ? (liveParts?.name ?? "") : face.name}
                </Chip>
              )}
            />
            {/* 主操作（停下 / 用这张 / 生成形象 / 再来一组）钉在行尾；前面的设置放不下一行时它自己换到下一行 */}
            <span className="gd-avatar-primary">
            {live ? (
              <PanelButton onClick={cancel}>{ta.cancel}</PanelButton>
            ) : (
              <>
                {chosen !== null && chosen !== job?.selected ? (
                  <button type="button" className="btn-accent gd-avatar-use" disabled={busy} data-action="avatar-use" onClick={() => void use(chosen)}>
                    {ta.use}
                  </button>
                ) : null}
                {job === null ? (
                  <button type="button" className="btn-accent gd-avatar-generate" disabled={busy} data-action="avatar-generate" onClick={() => void start()}>
                    <Icon name="image-plus" size={13} strokeWidth={1.8} />
                    <span>{ta.generate}</span>
                  </button>
                ) : (
                  <PanelButton onClick={() => void start()}>{ta.again}</PanelButton>
                )}
              </>
            )}
            </span>
          </span>
          {renderNote !== null && (
            <p className="gd-role-line gd-avatar-render-note" data-note="render-policy">
              <Icon name="info" size={12} strokeWidth={1.8} />
              <span>{renderNote}</span>
            </p>
          )}
          {history !== null && history.entries.length > 0 && (
            <details className="gd-avatar-history" data-history="avatar">
              <summary>
                <Icon name="history" size={12} strokeWidth={1.8} />
                <span>{ta.history(history.entries.length)}</span>
                <span className="row-trailing gd-avatar-history-chevron">
                  <Icon name="chevron-down" size={12} strokeWidth={1.8} />
                </span>
              </summary>
              <div className="gd-avatar-history-list">
                {[...history.entries].reverse().map((entry) => (
                  <section className="gd-avatar-history-entry" key={entry.id} data-round={entry.round ?? undefined}>
                    <div className="gd-avatar-history-head">
                      <p>{entry.instruction ?? ta.firstRound}</p>
                      <span className="row-trailing">{entry.round === null ? ta.historyNotStarted : ta.historyRound(entry.round)}</span>
                    </div>
                    {entry.baseCandidateId !== null && <p className="gd-avatar-history-base">{ta.historyBase(entry.baseCandidateId)}</p>}
                    {entry.candidates.length > 0 ? (
                      <ul className="gd-avatar-grid" aria-label={entry.instruction ?? ta.firstRound}>
                        {entry.candidates.map((candidate) => (
                          <HistoryTile
                            key={candidate.candidateId}
                            candidate={candidate}
                            selected={history.selected === candidate.candidateId}
                            disabled={busy || live}
                            kind={props.kind}
                            design={props.design}
                            onUse={() => void use(candidate.candidateId)}
                            t={t}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="gd-avatar-history-empty">{ta.historyEmpty}</p>
                    )}
                  </section>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** 一张候选：上面是球（地表 + 代码眼睛；还在画 / 没出来时是虚线圆），下面一行后端，一行状态或原因 */
function CandidateTile(props: {
  slot: AvatarSlot;
  job: AvatarJob;
  kind: BodyKind;
  design: GalaxyDesign;
  picked: boolean;
  inUse: boolean;
  onPick: () => void;
  /** 原因由上层统一写一次（每一位同一个原因时） */
  hideReason: boolean;
  t: Messages;
}) {
  const ta = props.t.galaxyDesigner.avatar;
  const { slot } = props;
  const uid = useId().replace(/:/g, "");
  const backendName = (backend: AvatarBackend): string => ta.backend[backend];
  const degraded = slot.backend !== slot.wanted;
  const tries = slot.attempts.filter((attempt) => !attempt.unavailable).length;
  const preparing = props.job.state === "preparing";
  const status =
    slot.state === "done"
      ? props.inUse
        ? ta.inUse
        : ta.done
      : slot.state === "failed"
        ? ta.failed
        : preparing
          ? ta.preparing
          : tries > 0
            ? `${ta.working} · ${ta.retry(tries + 1)}`
            : ta.working;
  // 降级的缘由：原先那个后端试过却没出来（写插件原话），还是手边压根没有它（plan 时就改了）
  const wantedTry = [...slot.attempts].reverse().find((attempt) => attempt.backend === slot.wanted && !attempt.ok);
  const degradedWhy = !degraded
    ? null
    : wantedTry === undefined
      ? ta.unavailable(backendName(slot.wanted), backendName(slot.backend))
      : ta.degraded(backendName(slot.wanted), backendName(slot.backend), wantedTry.reasons.join("；"));
  const reason = slot.state === "failed" ? slot.reason : degradedWhy;
  const selectable = slot.state === "done" && slot.candidateId !== null;
  const r = 30;
  return (
    <li className="gd-avatar-cell" data-slot={slot.slot} data-state={slot.state} data-backend={slot.backend} data-degraded={degraded || undefined}>
      <button
        type="button"
        className="gd-avatar-tile"
        aria-pressed={props.picked || props.inUse}
        data-picked={props.picked || undefined}
        data-in-use={props.inUse || undefined}
        disabled={!selectable}
        onClick={props.onPick}
        title={reason ?? undefined}
      >
        <svg className="gd-avatar-figure" viewBox={`${-r - 6} ${-r - 6} ${2 * r + 12} ${2 * r + 12}`} role="img" aria-label={`${backendName(slot.backend)} · ${status}`}>
          {slot.state === "done" && slot.image !== null ? (
            <BodyFigure art={candidateArt(props.design, props.kind, slot.image, r)} uid={uid} gaze={0} />
          ) : (
            <circle className="gd-avatar-slot" r={r} data-state={slot.state} />
          )}
        </svg>
        <span className="gd-avatar-backend">{backendName(slot.backend)}</span>
        <span className="gd-avatar-status" data-state={slot.state}>
          {slot.state === "working" && <Icon name="loader-circle" size={11} spin />}
          {slot.state === "failed" && <Icon name="triangle-alert" size={11} strokeWidth={1.8} />}
          {props.inUse && <Icon name="check" size={11} strokeWidth={2} />}
          <span>{status}</span>
        </span>
      </button>
      {reason !== null && !(props.hideReason && slot.state === "failed") && (
        <p className="gd-avatar-reason" data-kind={slot.state === "failed" ? "failed" : "degraded"}>
          {reason}
        </p>
      )}
    </li>
  );
}

/** 历史里的一张旧候选：点击即写回 planet/，不必先把它重新生成一遍 */
function HistoryTile(props: {
  candidate: AvatarHistoryCandidate;
  selected: boolean;
  disabled: boolean;
  kind: BodyKind;
  design: GalaxyDesign;
  onUse: () => void;
  t: Messages;
}) {
  const ta = props.t.galaxyDesigner.avatar;
  const { candidate } = props;
  const uid = useId().replace(/:/g, "");
  const r = 30;
  const status = props.selected ? ta.inUse : candidate.image === null ? ta.historyMissing : ta.historyUse(candidate.candidateId);
  return (
    <li className="gd-avatar-cell" data-candidate-id={candidate.candidateId} data-backend={candidate.backend}>
      <button
        type="button"
        className="gd-avatar-tile"
        aria-pressed={props.selected}
        data-in-use={props.selected || undefined}
        disabled={props.disabled || candidate.image === null}
        onClick={props.onUse}
        title={status}
      >
        <svg className="gd-avatar-figure" viewBox={`${-r - 6} ${-r - 6} ${2 * r + 12} ${2 * r + 12}`} role="img" aria-label={`${ta.backend[candidate.backend]} · ${status}`}>
          {candidate.image === null ? <circle className="gd-avatar-slot" r={r} data-state="failed" /> : <BodyFigure art={candidateArt(props.design, props.kind, candidate.image, r)} uid={uid} gaze={0} />}
        </svg>
        <span className="gd-avatar-backend">{ta.backend[candidate.backend]}</span>
        <span className="gd-avatar-status" data-state={candidate.image === null ? "failed" : "done"}>
          {props.selected && <Icon name="check" size={11} strokeWidth={2} />}
          <span>{status}</span>
        </span>
      </button>
    </li>
  );
}

/** 候选的样子：这颗天体只开眼睛（星环、云带在 60px 上只会糊），地表换成候选图；眼睛样式随这颗天体 */
function candidateArt(design: GalaxyDesign, kind: BodyKind, src: string, r: number) {
  const surface = { src, flip: false };
  if (kind === "planet" && design.planet !== null) {
    return bodyArt(planetFaceDesign(design.planet.composition, surface, design.planet.eyeStyle), "planet", r);
  }
  const star = design.star;
  if (star === null) return bodyArt(planetFaceDesign("rock", surface), "planet", r);
  const only = { ...star, surface, elements: { ...star.elements, ring: false, clouds: false, moons: false, corona: false } };
  return bodyArt({ ...design, editing: "star", star: only }, "star", r);
}
