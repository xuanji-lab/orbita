import { useEffect, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import {
  PanelButton,
  PanelIconButton,
  PanelLine,
  RightPanelFrame,
} from "../../shell/RightPanel";
import { api } from "../../api";
import type { SkillsState } from "./useSkills";
import type { SkillContent, SkillMeta } from "@shared/skill";
import { isSkillSlug } from "@shared/skill";

/**
 * Skills 面板（1-4 / 2-1d）：列表视图按集合分组 + 详情视图改归属与三段编辑。
 * 长在 S-0 的面板框架上；韦恩图视图（2-1e）在 wafo 看过 3 圆静态稿后接进来，
 * 届时页头加 [list|blend] 两枚 Chip——现在只有一档，不放假的切换器。
 *
 * 列表的分组本职是回答「这个集合现在有哪些 skill」，所以**多集合的行在每组
 * 都出现**（行尾 N sets 说明它共享），不是对 skill 集合做划分。
 */
export function SkillsPanel(props: {
  narrow: boolean;
  skills: SkillsState;
  onClose: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  /** 表单默认归属的 workspace（会话当前所在）；null = 默认 Global */
  defaultWorkspaceId: string | null;
}) {
  const { skills } = props;
  /** 当前面板视图：列表 / 详情 / 新建表单（4-1） */
  const [view, setView] = useState<"list" | "detail" | "create">("list");
  /** 当前详情的 slug；null = 列表。面板内状态，不进 useSkills（侧栏列表已删） */
  const [selected, setSelected] = useState<string | null>(null);
  const meta = selected === null ? null : (skills.skills.find((s) => s.slug === selected) ?? null);

  // 列表刷新后选中的那条没了（被清理）→ 回列表
  useEffect(() => {
    if (selected !== null && meta === null) setView("list");
  }, [selected, meta]);

  const workspaceName = (id: string): string =>
    skills.workspaces.find((w) => w.id === id)?.name ?? id;

  if (view === "create") {
    return (
      <NewSkillForm
        narrow={props.narrow}
        skills={skills}
        defaultWorkspaceId={props.defaultWorkspaceId}
        onCancel={() => setView("list")}
        onCreated={(slug) => {
          setSelected(slug);
          setView("detail");
        }}
        onClose={props.onClose}
        width={props.width}
        onWidthChange={props.onWidthChange}
        onWidthCommit={props.onWidthCommit}
      />
    );
  }
  if (meta !== null) {
    return (
      <SkillDetail
        narrow={props.narrow}
        width={props.width}
        onWidthChange={props.onWidthChange}
        onWidthCommit={props.onWidthCommit}
        skills={skills}
        meta={meta}
        workspaceName={workspaceName}
        onBack={() => setSelected(null)}
        onClose={props.onClose}
      />
    );
  }
  return (
    <SkillList
      narrow={props.narrow}
      width={props.width}
      onWidthChange={props.onWidthChange}
      onWidthCommit={props.onWidthCommit}
      skills={skills}
      workspaceName={workspaceName}
      onSelect={(slug) => {
        setSelected(slug);
        setView("detail");
      }}
      onNewSkill={() => setView("create")}
      onClose={props.onClose}
    />
  );
}

/** 组标题：mono/micro/大写/secondary（与侧栏 NodeLabel 同款字学）。 */
function GroupLabel(props: { children: React.ReactNode; danger?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 26,
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-micro)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: props.danger === true ? "var(--color-danger)" : "var(--color-text-secondary)",
      }}
    >
      {props.children}
    </span>
  );
}

function SkillList(props: {
  narrow: boolean;
  skills: SkillsState;
  workspaceName: (id: string) => string;
  onSelect: (slug: string) => void;
  onNewSkill: () => void;
  onClose: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
}) {
  const { skills } = props;
  const load = skills.load;
  const error = load.kind === "failed" ? load.message : null;
  /** + 的两项菜单（4-1）：面板内展开不弹窗；再点 + 收起 */
  const [menuOpen, setMenuOpen] = useState(false);

  const header = (
    <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
      Skills
    </strong>
  );

  // 空态与加载：footer 的 reveal 行照常（新建的路一直在）
  if (load.kind === "loading" && skills.skills.length === 0) {
    return (
      <RightPanelFrame
        narrow={props.narrow}
        width={props.width}
        onWidthChange={props.onWidthChange}
        onWidthCommit={props.onWidthCommit}
        header={header}
        contentKey="list"
        onClose={props.onClose}
        headerExtra={<AddMenu skills={skills} onNewSkill={props.onNewSkill} />}
        footer={<FooterReveal skills={skills} />}
      >
        <PanelLine>Loading…</PanelLine>
      </RightPanelFrame>
    );
  }
  if (skills.skills.length === 0) {
    return (
      <RightPanelFrame
        narrow={props.narrow}
        width={props.width}
        onWidthChange={props.onWidthChange}
        onWidthCommit={props.onWidthCommit}
        header={header}
        contentKey="list"
        onClose={props.onClose}
        headerExtra={<AddMenu skills={skills} onNewSkill={props.onNewSkill} />}
        footer={<FooterReveal skills={skills} />}
      >
        {error !== null && <PanelLine danger>Couldn’t read skills. {error}</PanelLine>}
        <p style={{ margin: 0, fontSize: "var(--font-size-body)" }}>No skill yet.</p>
        <PanelLine>Create a folder with a SKILL.md in the skills directory.</PanelLine>
      </RightPanelFrame>
    );
  }

  const linked = skills.skills.filter((s) => s.global || s.workspaces.length > 0);
  const disabled = skills.skills.filter((s) => !s.global && s.workspaces.length === 0);

  const row = (skill: SkillMeta, key: string) => {
    const sets = (skill.global ? 1 : 0) + skill.workspaces.length;
    const setNames = [
      skill.global ? "Global" : "",
      ...skill.workspaces.map(props.workspaceName),
    ].filter(Boolean);
    return (
      <button
        key={key}
        type="button"
        onClick={() => props.onSelect(skill.slug)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          width: "100%",
          height: "var(--list-item-default)",
          padding: "0 var(--space-3)",
          border: 0,
          background: "transparent",
          font: "inherit",
          fontSize: "var(--font-size-control)",
          fontWeight: "var(--weight-medium)",
          textAlign: "left",
          cursor: "pointer",
          color: "var(--color-text-primary)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--color-bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        {skill.missing && (
          <Icon name="triangle-alert" size={13} style={{ color: "var(--color-danger)" }} />
        )}
        <span
          style={{
            minWidth: 0,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {skill.name}
        </span>
        {skill.missing ? (
          <span
            style={{
              fontFamily: "var(--font-family-business)",
              fontSize: "var(--font-size-micro)",
              color: "var(--color-danger)",
            }}
          >
            missing
          </span>
        ) : sets > 1 ? (
          <span
            title={setNames.join(", ")}
            style={{
              fontFamily: "var(--font-family-business)",
              fontSize: "var(--font-size-micro)",
              color: "var(--color-text-tertiary)",
              flex: "0 0 auto",
            }}
          >
            {sets} sets
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <RightPanelFrame
      narrow={props.narrow}
      width={props.width}
      onWidthChange={props.onWidthChange}
      onWidthCommit={props.onWidthCommit}
      header={header}
      contentKey="list"
      onClose={props.onClose}
      headerExtra={<AddMenu skills={skills} onNewSkill={props.onNewSkill} />}
      footer={<FooterReveal skills={skills} />}
    >
      <div style={{ display: "grid", alignContent: "start" }}>
        {error !== null && (
          <div style={{ padding: "var(--space-3)" }}>
            <PanelLine danger>Couldn’t read skills. {error}</PanelLine>
          </div>
        )}
        {skills.skills.some((s) => s.global) && (
          <>
            <GroupLabel>Global</GroupLabel>
            {skills.skills.filter((s) => s.global).map((s) => row(s, `g:${s.slug}`))}
          </>
        )}
        {skills.workspaces.map((ws) => {
          const members = linked.filter((s) => !s.global && s.workspaces.includes(ws.id));
          if (members.length === 0) return null;
          return (
            <div key={ws.id}>
              <GroupLabel>{ws.name}</GroupLabel>
              {members.map((s) => row(s, `${ws.id}:${s.slug}`))}
            </div>
          );
        })}
        {disabled.length > 0 && (
          <div>
            <GroupLabel>Disabled</GroupLabel>
            {disabled.map((s) => (
              <DisabledRow key={s.slug} skill={s} onSelect={props.onSelect} />
            ))}
          </div>
        )}
      </div>
    </RightPanelFrame>
  );
}

/** Disabled 组的行：name 实色 tertiary，其余同普通行。 */
function DisabledRow(props: { skill: SkillMeta; onSelect: (slug: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.skill.slug)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "100%",
        height: "var(--list-item-default)",
        padding: "0 var(--space-3)",
        border: 0,
        background: "transparent",
        font: "inherit",
        fontSize: "var(--font-size-control)",
        fontWeight: "var(--weight-medium)",
        textAlign: "left",
        cursor: "pointer",
        color: "var(--color-text-primary)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--color-bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {props.skill.missing && (
        <Icon name="triangle-alert" size={13} style={{ color: "var(--color-danger)" }} />
      )}
      <span
        style={{
          minWidth: 0,
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--color-text-tertiary)",
        }}
      >
        {props.skill.name}
      </span>
      {props.skill.missing && (
        <span
          style={{
            fontFamily: "var(--font-family-business)",
            fontSize: "var(--font-size-micro)",
            color: "var(--color-danger)",
          }}
        >
          missing
        </span>
      )}
    </button>
  );
}

/** footer：中央目录 reveal（新建 / 删除仍走访达——它们是文件管理器最擅长的事）。 */
function FooterReveal(props: { skills: SkillsState }) {
  return (
    <>
      <code
        style={{
          fontSize: "var(--font-size-caption)",
          color: "var(--color-text-tertiary)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
        title="The central skills directory"
      >
        skills/
      </code>
      <PanelButton onClick={() => props.skills.reveal(null)} title="Open the skills directory">
        <Icon name="folder" size={14} /> Reveal
      </PanelButton>
    </>
  );
}

function SkillDetail(props: {
  narrow: boolean;
  skills: SkillsState;
  meta: SkillMeta;
  workspaceName: (id: string) => string;
  onBack: () => void;
  onClose: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
}) {
  const { skills, meta } = props;
  const [content, setContent] = useState<SkillContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 已落盘的那一份，用来判断失焦时有没有真的改过 */
  const saved = useRef<SkillContent | null>(null);

  useEffect(() => {
    let live = true;
    setContent(null);
    setError(null);
    void api.skill
      .read(meta.slug)
      .then((next) => {
        if (!live) return;
        saved.current = next;
        setContent(next);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [meta.slug]);

  const commit = (field: keyof SkillContent) => () => {
    const draft = content;
    const base = saved.current;
    if (draft === null || base === null || draft[field] === base[field]) return;
    setSaving(true);
    setError(null);
    void skills
      .save(meta.slug, { [field]: draft[field] })
      .then(() => {
        saved.current = { ...base, [field]: draft[field] };
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  };

  const badge = meta.missing
    ? "Missing"
    : meta.linkedPath !== null
      ? "Linked"
      : meta.global
        ? "Global"
        : meta.workspaces.length > 0
          ? "Workspace"
          : "Disabled";
  const disabled = meta.missing;
  const disabledTitle =
    "The file is gone — clean up the references or restore the folder.";

  return (
    <RightPanelFrame
      narrow={props.narrow}
        width={props.width}
        onWidthChange={props.onWidthChange}
        onWidthCommit={props.onWidthCommit}
      contentKey={`detail:${meta.slug}`}
      onClose={props.onClose}
      header={
        <>
          <PanelIconButton title="Back to list" onClick={props.onBack}>
            <Icon name="chevron-left" size={16} />
          </PanelIconButton>
          <strong
            style={{
              fontSize: "var(--font-size-title)",
              fontWeight: "var(--weight-bold)",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {meta.name}
          </strong>
        </>
      }
      footer={
        meta.missing ? (
          <>
            <span style={{ flex: 1 }} />
            <PanelButton danger onClick={() => skills.clean(meta.slug)}>
              <Icon name="trash-2" size={14} /> Clean up references
            </PanelButton>
          </>
        ) : (
          <>
            <PanelButton onClick={() => skills.reveal(meta.slug)}>
              <Icon name="folder" size={14} /> Show in Finder
            </PanelButton>
            <span style={{ flex: 1 }} />
            <PanelLine>{saving ? "Saving…" : "Saved when you leave a field"}</PanelLine>
          </>
        )
      }
    >
      <div
        style={{
          padding: "var(--space-5) var(--space-4)",
          display: "grid",
          gap: "var(--space-5)",
          opacity: disabled ? 0.55 : undefined,
        }}
      >
        {meta.missing && (
          <PanelLine danger>The folder for this skill is missing on disk.</PanelLine>
        )}
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <code
            style={{
              fontSize: "var(--font-size-caption)",
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-family-mono)",
            }}
            title="Folder name. Renaming the skill does not rename this."
          >
            {meta.slug}
          </code>
          {/* muted Badge：中性面 + 小字，不上 accent */}
          <span
            style={{
              padding: "1px 7px",
              background: "var(--color-bg-muted)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-pill)",
              fontSize: "var(--font-size-micro)",
              color: meta.missing ? "var(--color-danger)" : "var(--color-text-secondary)",
            }}
          >
            {badge}
          </span>
          {/* 导入的 skill：标 Linked 并显示真身路径（4-1）；「在访达里显示」揭示的也是真身 */}
          {meta.linkedPath !== null && (
            <span
              style={{
                fontSize: "var(--font-size-micro)",
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-family-mono)",
                overflowWrap: "anywhere",
              }}
              title={meta.linkedPath}
            >
              → {meta.linkedPath}
            </span>
          )}
        </span>

        {!meta.missing && (
          <>
            <Field label="Works in">
              <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                <Chip
                  active={meta.global}
                  title="Every task, in every workspace"
                  onClick={() =>
                    meta.global
                      ? skills.unlink(meta.slug, { kind: "global" })
                      : skills.link(meta.slug, { kind: "global" })
                  }
                >
                  Global
                </Chip>
                {skills.workspaces.map((ws) => {
                  const linked = meta.workspaces.includes(ws.id);
                  return (
                    <Chip
                      key={ws.id}
                      active={linked}
                      onClick={() =>
                        linked
                          ? skills.unlink(meta.slug, { kind: "workspace", workspaceId: ws.id })
                          : skills.link(meta.slug, { kind: "workspace", workspaceId: ws.id })
                      }
                    >
                      {ws.name}
                    </Chip>
                  );
                })}
              </span>
              {/* ★ 生效范围贴着动作常驻——用户改完可能很久才开新会话，toast 早没了 */}
              <span style={{ display: "block", marginTop: "var(--space-2)" }}>
                <PanelLine>
                  Changes apply to the next new session. Sessions already open keep their set.
                </PanelLine>
              </span>
            </Field>
          </>
        )}

        {error !== null && <PanelLine danger>Couldn’t save. {error}</PanelLine>}

        {content === null && !meta.missing && <PanelLine>Loading…</PanelLine>}
        {content !== null && (
          <div
            style={{ display: "grid", gap: "var(--space-4)", pointerEvents: disabled ? "none" : undefined }}
            title={disabled ? disabledTitle : undefined}
          >
            <Field label="Name" hint="How the agent refers to this skill. The folder name does not change.">
              <PanelInput
                value={content.name}
                disabled={disabled}
                title={disabled ? disabledTitle : undefined}
                onChange={(name) => setContent({ ...content, name })}
                onBlur={commit("name")}
              />
            </Field>
            <Field label="Description" hint="The agent sees this in every task and uses it to decide whether to read the skill.">
              <textarea
                value={content.description}
                disabled={disabled}
                title={disabled ? disabledTitle : undefined}
                rows={3}
                onChange={(e) => setContent({ ...content, description: e.target.value })}
                onBlur={commit("description")}
                style={{ ...inputStyle, height: "auto", padding: "var(--space-2) var(--space-3)", resize: "vertical", cursor: disabled ? "not-allowed" : undefined }}
              />
            </Field>
            <Field label="Instructions" hint="Read only when a task matches the description.">
              <textarea
                value={content.body}
                disabled={disabled}
                title={disabled ? disabledTitle : undefined}
                rows={14}
                onChange={(e) => setContent({ ...content, body: e.target.value })}
                onBlur={commit("body")}
                style={{
                  ...inputStyle,
                  height: "auto",
                  padding: "var(--space-2) var(--space-3)",
                  resize: "vertical",
                  fontFamily: "var(--font-family-mono)",
                  lineHeight: 1.6,
                  cursor: disabled ? "not-allowed" : undefined,
                }}
              />
            </Field>
          </div>
        )}
      </div>
    </RightPanelFrame>
  );
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: "var(--space-2)" }}>
      <span style={{ fontSize: "var(--font-size-label)", fontWeight: "var(--weight-medium)" }}>
        {props.label}
      </span>
      {props.children}
      {props.hint !== undefined && (
        <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {props.hint}
        </span>
      )}
    </label>
  );
}

function PanelInput(props: {
  value: string;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <input
      value={props.value}
      disabled={props.disabled}
      title={props.title}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onBlur}
      style={{ ...inputStyle, cursor: props.disabled ? "not-allowed" : undefined }}
    />
  );
}

const inputStyle: React.CSSProperties = {
  height: "var(--control-height-md)",
  padding: "0 var(--space-3)",
  background: "var(--color-bg-panel)",
  color: "var(--color-text-primary)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-md)",
  font: "inherit",
  fontSize: "var(--font-size-input)",
  width: "100%",
  boxSizing: "border-box",
};


/** + 菜单（4-1）：New skill / Link existing folder…。列表、空态、加载态三处共用。 */
function AddMenu(props: { skills: SkillsState; onNewSkill: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <PanelIconButton title="Add a skill" onClick={() => setOpen((v) => !v)}>
        <Icon name="plus" size={16} />
      </PanelIconButton>
      {open && (
        <span
          style={{
            position: "absolute",
            top: 30,
            right: 0,
            display: "grid",
            gap: 2,
            padding: 4,
            background: "var(--color-bg-panel)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-popover)",
            zIndex: 30,
            minWidth: 200,
          }}
        >
          <MenuItemRow
            onClick={() => {
              setOpen(false);
              props.onNewSkill();
            }}
          >
            <Icon name="plus" size={14} /> New skill
          </MenuItemRow>
          <MenuItemRow
            onClick={() => {
              setOpen(false);
              props.skills.importFolder(null);
            }}
          >
            <Icon name="folder-plus" size={14} /> Link existing folder…
          </MenuItemRow>
        </span>
      )}
    </span>
  );
}

/** 菜单行（+ 展开的两项）：与面板按钮同语汇，hover 中性抬升。 */
function MenuItemRow(props: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: "var(--control-height-sm)",
        padding: "0 var(--space-3)",
        border: 0,
        background: "transparent",
        font: "inherit",
        fontSize: "var(--font-size-control)",
        color: "var(--color-text-primary)",
        textAlign: "left",
        cursor: "pointer",
        borderRadius: "var(--radius-sm)",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--color-bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {props.children}
    </button>
  );
}

/**
 * 新建表单（4-1）：slug 校验（isSkillSlug + 不重名）、name 默认跟 slug、
 * 初始归属默认当前 workspace（没有就 Global）。字段竖排，错误贴字段下方；
 * footer 是 [Cancel] [Create]，secondary——本面无主操作，不给 accent。
 */
function NewSkillForm(props: {
  narrow: boolean;
  skills: SkillsState;
  defaultWorkspaceId: string | null;
  onCancel: () => void;
  onCreated: (slug: string) => void;
  onClose: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string>(
    props.defaultWorkspaceId ?? "global",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const slugError =
    slug === ""
      ? null
      : isSkillSlug(slug)
        ? props.skills.skills.some((s) => s.slug === slug)
          ? "A skill with this folder name already exists."
          : null
        : "Use lowercase letters, digits, dots, dashes or underscores; no spaces.";

  const submit = (): void => {
    if (slug === "" || slugError !== null || busy) return;
    const target =
      scope === "global"
        ? ({ kind: "global" } as const)
        : scope === "none"
          ? null
          : ({ kind: "workspace", workspaceId: scope } as const);
    setBusy(true);
    setError(null);
    props.skills
      .create(slug, name === "" ? slug : name, target)
      .then(() => props.onCreated(slug))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <RightPanelFrame
      narrow={props.narrow}
      width={props.width}
      onWidthChange={props.onWidthChange}
      onWidthCommit={props.onWidthCommit}
      contentKey="create"
      onClose={props.onClose}
      header={
        <>
          <PanelIconButton title="Back to list" onClick={props.onCancel}>
            <Icon name="chevron-left" size={16} />
          </PanelIconButton>
          <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
            New skill
          </strong>
        </>
      }
      footer={
        <>
          <PanelButton onClick={props.onCancel}>Cancel</PanelButton>
          <span style={{ flex: 1 }} />
          <PanelButton onClick={submit} disabled={slug === "" || slugError !== null || busy}>
            {busy ? "Creating…" : "Create"}
          </PanelButton>
        </>
      }
    >
      <div
        style={{
          padding: "var(--space-5) var(--space-4)",
          display: "grid",
          gap: "var(--space-4)",
          alignContent: "start",
        }}
      >
        <Field label="Folder name" hint="The slug. It becomes the folder name and never changes.">
          <PanelInput value={slug} onChange={(v) => setSlug(v.trim())} onBlur={() => {}} />
          {slugError !== null && <FieldError>{slugError}</FieldError>}
        </Field>
        <Field label="Name" hint="How the agent refers to this skill. Defaults to the folder name.">
          <PanelInput
            value={name}
            onChange={(v) => setName(v)}
            onBlur={() => {}}
            placeholder={slug === "" ? undefined : slug}
          />
        </Field>
        <Field label="Works in" hint="Where this skill applies. You can change it later in the detail view.">
          <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            <Chip active={scope === "global"} onClick={() => setScope("global")}>
              Global
            </Chip>
            {props.skills.workspaces.map((ws) => (
              <Chip key={ws.id} active={scope === ws.id} onClick={() => setScope(ws.id)}>
                {ws.name}
              </Chip>
            ))}
            <Chip active={scope === "none"} onClick={() => setScope("none")}>
              Not linked yet
            </Chip>
          </span>
        </Field>
        {error !== null && <FieldError>Couldn’t create. {error}</FieldError>}
      </div>
    </RightPanelFrame>
  );
}

function FieldError(props: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>
      {props.children}
    </span>
  );
}
