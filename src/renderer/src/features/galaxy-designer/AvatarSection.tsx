import { useEffect, useId, useState } from "react";
import { isAvatarJobLive, type AvatarBackend, type AvatarJob, type AvatarSlot } from "@shared/planet-avatar";
import type { PlanetMix } from "@shared/planet-design";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelGroupHead } from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { bodyArt, planetFaceDesign, type BodyKind, type GalaxyDesign } from "./design.ts";
import { BodyFigure } from "./StarFigure.tsx";

/**
 * 设计面板的「形象」一节（选完元素之后的下一步）：点「生成形象」→ 主进程开幕后会话跑插件「行星造物」的 planet-render，
 * 按用户的出图原则出 2–3 张无脸地表候选 → 这里一张张显示生成中 / 出来了 / 没出来（原因、降级到什么）→ 挑一张「用这张」写进 planet/。
 * 候选上的眼睛是代码画的（与侧栏、星系同一个 BodyFigure），地表才是候选。
 * 挑完主进程推 selected，App 的 usePlanetFiles 重读盘：侧栏头像、页头、星系、右栏星系图、面板预览五处同源换上。
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
}) {
  const t = useT();
  const ta = t.galaxyDesigner.avatar;
  const { workspaceId, bodyId } = props;
  const [job, setJob] = useState<AvatarJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 挂上 / 换天体：读这颗当前这一轮（活任务，或盘上账本的最后一轮），再听进度推送
  useEffect(() => {
    setJob(null);
    setError(null);
    setPicked(null);
    if (bodyId === null) return;
    let alive = true;
    void api.planet.avatarJob({ workspaceId, bodyId }).then((result) => {
      if (alive && result.ok) setJob((current) => current ?? result.job);
    });
    const off = api.planet.onAvatarJob(({ job: next }) => {
      if (next.workspaceId === workspaceId && next.bodyId === bodyId) setJob(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, [workspaceId, bodyId]);

  const live = isAvatarJobLive(job);
  const generate = async (): Promise<void> => {
    if (bodyId === null || live) return;
    setBusy(true);
    setError(null);
    setPicked(null);
    const result = await api.planet.generateAvatar({ workspaceId, bodyId, mix: props.mix, name: props.name });
    setBusy(false);
    if (result.ok) setJob(result.job);
    else setError(result.error);
  };
  const use = async (candidateId: string): Promise<void> => {
    if (bodyId === null) return;
    setBusy(true);
    setError(null);
    const result = await api.planet.selectAvatar({ workspaceId, bodyId, candidateId });
    setBusy(false);
    if (result.ok) {
      setJob(result.job);
      setPicked(null);
    } else setError(result.error);
  };
  const cancel = (): void => {
    if (bodyId !== null) void api.planet.cancelAvatar({ workspaceId, bodyId });
  };

  const slots = job?.slots ?? [];
  const chosen = picked ?? null;
  const ended = job !== null && !live;
  const noneOut = ended && job.state === "pending";
  const usable = slots.filter((slot) => slot.state === "done");
  // 每一位都因同一个原因没出来（停下、超时、会话断了）：原因只写一次，不在每张下面重复
  const failedReasons = slots.map((slot) => (slot.state === "failed" ? slot.reason : null));
  const sharedReason = slots.length > 1 && failedReasons.every((reason) => reason !== null && reason === failedReasons[0]) ? failedReasons[0] ?? null : null;

  return (
    <div className="gd-avatar" data-avatar-state={job?.state ?? "none"} data-body-id={bodyId ?? undefined}>
      <PanelGroupHead label={ta.group} />
      <p className="gd-role-line gd-avatar-desc">{job?.policy === null || job?.policy === undefined ? ta.desc : ta.policy(job.policy)}</p>
      {bodyId === null ? (
        <p className="gd-role-line">{ta.unsaved}</p>
      ) : (
        <>
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
          <span className="gd-avatar-acts">
            {live ? (
              <>
                <span className="gd-avatar-model">{job?.model === null || job?.model === undefined ? "" : ta.model(job.model.modelId)}</span>
                <PanelButton onClick={cancel}>{ta.cancel}</PanelButton>
              </>
            ) : (
              <>
                {chosen !== null && chosen !== job?.selected ? (
                  <button type="button" className="btn-accent gd-avatar-use" disabled={busy} data-action="avatar-use" onClick={() => void use(chosen)}>
                    {ta.use}
                  </button>
                ) : null}
                {job === null ? (
                  <button type="button" className="btn-accent gd-avatar-generate" disabled={busy} data-action="avatar-generate" onClick={() => void generate()}>
                    <Icon name="image-plus" size={13} strokeWidth={1.8} />
                    <span>{ta.generate}</span>
                  </button>
                ) : (
                  <PanelButton onClick={() => void generate()}>{ta.again}</PanelButton>
                )}
              </>
            )}
          </span>
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
