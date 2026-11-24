import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AVATAR_INSTRUCTION_MAX, isAvatarJobLive, type AvatarBackend, type AvatarHistory, type AvatarHistoryCandidate, type AvatarJob, type AvatarSlot } from "@shared/planet-avatar";
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
  const instructionId = useId();
  const [job, setJob] = useState<AvatarJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<AvatarHistory | null>(null);
  const historySeq = useRef(0);

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
  const start = async (instruction?: string): Promise<void> => {
    if (bodyId === null || live || busy) return;
    setBusy(true);
    setError(null);
    setPicked(null);
    // 「再来一组」始终不以旧图为基础；只有「按这个改」把当前高亮 / 在用的那张作为基础
    const baseCandidateId = instruction === undefined ? undefined : (picked ?? job?.selected ?? undefined);
    const result = await api.planet.generateAvatar({ workspaceId, bodyId, mix: props.mix, name: props.name, ...(instruction === undefined ? {} : { instruction }), ...(baseCandidateId === undefined ? {} : { baseCandidateId }) });
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

  const slots = job?.slots ?? [];
  const chosen = picked ?? null;
  const baseCandidate = picked ?? job?.selected ?? null;
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
