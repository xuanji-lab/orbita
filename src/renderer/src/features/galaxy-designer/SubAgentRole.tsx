import { useEffect, useRef, useState } from "react";
import { PLANET_AGENTS_MAX } from "@shared/planet-design";
import { SUB_AGENT_NAME_MAX, SUB_AGENT_ROLE_MAX } from "@shared/sub-agent";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelGroupHead } from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import type { PlanetDesign } from "./design.ts";

/**
 * 星系设计面板行星页的「职能」一节，与「新建子智能体」表单（2026-11-24 用户：「开放子智能体能被编辑的方式……
 * chat 主要沉淀出子智能体的 prompt（职能）和 AVATAR，真正位于星系什么位置，弹出右侧面板让用户设置」）。
 * 与聊天里的 create_sub_agent / update_sub_agent 写同一份档案（planet/agents/<id>/agent.json，经 subagent:* IPC）；
 * 写完主进程广播 subAgentsChanged，App 重读星系——这里不自己改设计稿仓库。
 */

/** 职能提示词停手多久保存（ms）：比形象稿的 400 长一点，打字时不每个字都写一遍盘 */
export const ROLE_SAVE_DELAY_MS = 800;

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

function dateOf(ms: number): string {
  if (ms <= 0) return "";
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function RoleSection(props: { workspaceId: string; planet: PlanetDesign }) {
  const t = useT();
  const tg = t.galaxyDesigner;
  const { planet } = props;
  const profile = planet.profile ?? null;
  const [draft, setDraft] = useState(profile?.role ?? "");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 盘上的职能变了（聊天里 update_sub_agent 改了它）且这里没在改：跟上
  useEffect(() => {
    if (!dirty.current) setDraft(profile?.role ?? "");
  }, [profile?.role]);
  // 换了一颗行星：草稿与确认态都从这一颗来
  useEffect(() => {
    dirty.current = false;
    setDraft(profile?.role ?? "");
    setConfirming(false);
    setSave({ kind: "idle" });
  }, [planet.id]);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const id = planet.id;
  if (id === undefined) {
    return (
      <>
        <PanelGroupHead label={tg.roleGroup} />
        <p className="gd-role-line">{tg.roleNeedsSave}</p>
      </>
    );
  }

  const commit = async (text: string): Promise<void> => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    if (text.trim() === "") {
      setSave({ kind: "error", message: tg.roleNone });
      return;
    }
    setSave({ kind: "saving" });
    // 没档案的老行星第一次写职能：顺手把名字带上（主进程补档案要名字）
    const result = await api.planet.updateSubAgent({ workspaceId: props.workspaceId, input: { id, role: text, ...(profile === null && planet.name.trim() !== "" ? { name: planet.name } : {}) } });
    if (result.ok) {
      dirty.current = false;
      setSave({ kind: "saved" });
    } else setSave({ kind: "error", message: result.error });
  };
  const onChange = (text: string): void => {
    dirty.current = true;
    setDraft(text);
    setSave({ kind: "idle" });
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void commit(text), ROLE_SAVE_DELAY_MS);
  };
  const remove = async (): Promise<void> => {
    const result = await api.planet.deleteSubAgent({ workspaceId: props.workspaceId, id });
    if (!result.ok) setSave({ kind: "error", message: result.error });
    setConfirming(false);
  };
  const name = planet.name.trim() || tg.unnamedPlanet;
  const meta = [
    profile === null ? null : tg.roleOrigin(profile.source, dateOf(profile.createdAt)),
    profile?.modelId === undefined ? null : tg.roleModel(profile.modelId),
  ].filter((line): line is string => line !== null);

  return (
    <div className="gd-role" data-subagent={id} data-has-profile={profile !== null || undefined}>
      <div className="gd-row gd-row-wide">
        <span className="gd-row-head">
          <span className="gd-row-name">{tg.roleLabel}</span>
          <span className="gd-row-desc">{profile === null ? tg.roleNone : tg.roleDesc}</span>
        </span>
        <span className="gd-row-ctl">
          <textarea
            className="text-field gd-role-text"
            rows={7}
            value={draft}
            maxLength={SUB_AGENT_ROLE_MAX}
            placeholder={tg.rolePlaceholder}
            aria-label={tg.roleLabel}
            data-field="role"
            onChange={(event) => onChange(event.target.value)}
            onBlur={(event) => void commit(event.target.value)}
          />
        </span>
        <p className="gd-role-status" role="status" data-save={save.kind}>
          {save.kind === "saving" ? tg.roleSaving : save.kind === "saved" ? tg.roleSaved : save.kind === "error" ? tg.roleSaveError(save.message) : meta.join(" · ")}
        </p>
      </div>
      {planet.surface === null || planet.surface === undefined ? (
        <p className="gd-role-line" data-pending="image">
          <Icon name="image" size={12} strokeWidth={1.8} />
          <span>{tg.imagePending}</span>
        </p>
      ) : null}
      {confirming ? (
        <div className="gd-confirm" role="alertdialog" aria-label={tg.deleteAgent}>
          <p className="gd-confirm-text">{tg.deleteConfirm(name)}</p>
          <span className="gd-confirm-acts">
            <PanelButton onClick={() => setConfirming(false)}>{tg.deleteNo}</PanelButton>
            <PanelButton danger onClick={() => void remove()}>
              {tg.deleteYes}
            </PanelButton>
          </span>
        </div>
      ) : (
        <span className="gd-role-delete">
          <button type="button" className="gd-link-danger" onClick={() => setConfirming(true)}>
            <Icon name="trash-2" size={12} strokeWidth={1.8} />
            <span>{tg.deleteAgent}</span>
          </button>
        </span>
      )}
    </div>
  );
}

/** 面板里新建一个子智能体：名字 + 职能，放在默认空轨道上；建好后 App 收到广播，面板落到新行星那一页 */
/** max = 这颗主星最多带几颗（物理层容量，≤ PLANET_AGENTS_MAX）；主进程建之前还会按同一条再查一遍 */
export function NewSubAgentForm(props: { workspaceId: string; count: number; max: number; onDone: () => void }) {
  const t = useT();
  const tg = t.galaxyDesigner;
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = props.count >= Math.min(props.max, PLANET_AGENTS_MAX);
  const ready = !busy && !full && name.trim() !== "" && role.trim() !== "";
  const create = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const result = await api.planet.createSubAgent({ workspaceId: props.workspaceId, input: { name, role } });
    setBusy(false);
    if (result.ok) props.onDone();
    else setError(result.error);
  };
  return (
    <div className="gd-new" data-form="new-subagent">
      <PanelGroupHead label={tg.newAgentTitle} />
      <p className="gd-role-line">{full ? tg.newAgentFull(Math.min(props.max, PLANET_AGENTS_MAX)) : tg.newAgentHint}</p>
      <div className="gd-row gd-row-wide">
        <span className="gd-row-head">
          <span className="gd-row-name">{tg.newAgentName}</span>
        </span>
        <span className="gd-row-ctl">
          <input
            className="text-field gd-name"
            value={name}
            maxLength={SUB_AGENT_NAME_MAX}
            aria-label={tg.newAgentName}
            data-field="new-name"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </span>
      </div>
      <div className="gd-row gd-row-wide">
        <span className="gd-row-head">
          <span className="gd-row-name">{tg.newAgentRole}</span>
          <span className="gd-row-desc">{tg.roleDesc}</span>
        </span>
        <span className="gd-row-ctl">
          <textarea
            className="text-field gd-role-text"
            rows={6}
            value={role}
            maxLength={SUB_AGENT_ROLE_MAX}
            placeholder={tg.rolePlaceholder}
            aria-label={tg.newAgentRole}
            data-field="new-role"
            onChange={(event) => setRole(event.target.value)}
          />
        </span>
      </div>
      {error !== null && (
        <p className="gd-error" role="alert">
          <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
          <span>{error}</span>
        </p>
      )}
      <span className="gd-new-acts">
        <PanelButton onClick={props.onDone}>{tg.newAgentCancel}</PanelButton>
        <button type="button" className="btn-accent gd-new-create" disabled={!ready} onClick={() => void create()}>
          {tg.newAgentCreate}
        </button>
      </span>
    </div>
  );
}
