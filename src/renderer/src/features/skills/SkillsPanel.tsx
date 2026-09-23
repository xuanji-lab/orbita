import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { IconButton } from "../../shell/IconButton";
import { SetDots } from "../../shell/SetDots";
import { useHoverTooltip } from "../../shell/useHoverTooltip.ts";
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
import { SkillsMap } from "./SkillsMap";
import { filterSkills } from "./skill-filter.ts";

/** 行 hover tooltip 出现的延迟——比 IconButton 的 200ms 更慢，快速划过列表不惊扰 */
const ROW_TOOLTIP_DELAY_MS = 350;

/**
 * Skills 面板（1-4 / 2-1d）：列表视图按集合分组 + 详情视图改归属与三段编辑。
 * 长在 S-0 的面板框架上；韦恩图视图（2-1e）在 wafo 看过 3 圆静态稿后接进来，
 * 届时页头加 [list|blend] 两枚 Chip——现在只有一档，不放假的切换器。
 *
 * 列表的分组本职是回答「这个集合现在有哪些 skill」，所以**多集合的行在每组
 * 都出现**（行尾的归属点阵说明它共享，见 SkillRow），不是对 skill 集合做划分。
 */
export function SkillsPanel(props: {
  skills: SkillsState;
  onClose: () => void;
  /** 表单默认归属的 workspace（会话当前所在）；null = 默认 Global */
  defaultWorkspaceId: string | null;
  /** Create skill…：新建会话并预填 composer，让 agent 用 create_skill 落盘 */
  onCreateSkill: () => void;
}) {
  const { skills } = props;
  /** 当前面板视图：列表 / 详情 / 新建表单（4-1） */
  const [view, setView] = useState<"list" | "detail" | "map">("list");
  /** +N more 跳列表后要滚到的组（global 或 workspaceId）；一次性的 */
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  /** 当前详情的 slug；null = 列表。面板内状态，不进 useSkills（侧栏列表已删） */
  const [selected, setSelected] = useState<string | null>(null);
  const meta = selected === null ? null : (skills.skills.find((s) => s.slug === selected) ?? null);

  // 列表刷新后选中的那条没了（被清理）→ 回列表
  useEffect(() => {
    if (selected !== null && meta === null) setView("list");
  }, [selected, meta]);

  const workspaceName = (id: string): string =>
    skills.workspaces.find((w) => w.id === id)?.name ?? id;

  // +N more 的落点：回到列表后滚到对应组（组容器挂了 id），滚完清掉一次性意图
  useEffect(() => {
    if (view !== "list" || scrollTo === null) return;
    const target = document.getElementById(`skills-group-${scrollTo}`);
    target?.scrollIntoView({ block: "start" });
    setScrollTo(null);
  }, [view, scrollTo]);

  if (view === "map") {
    return (
      <SkillMapView
        skills={skills}
        onOpenDetail={(slug) => {
          setSelected(slug);
          setView("detail");
        }}
        onJumpToGroup={(group) => {
          setScrollTo(group);
          setView("list");
        }}
        onSwitchToList={() => setView("list")}
        onCreateSkill={props.onCreateSkill}
        onClose={props.onClose}
      />
    );
  }
  if (meta !== null) {
    return (
      <SkillDetail
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
      skills={skills}
      workspaceName={workspaceName}
      onSelect={(slug) => {
        setSelected(slug);
        setView("detail");
      }}
      onCreateSkill={props.onCreateSkill}
      onSwitchToMap={() => setView("map")}
      onClose={props.onClose}
    />
  );
}

/**
 * 组标题：mono/micro/大写/secondary（与侧栏 NodeLabel 同款字学）+ 计数。
 * 计数是**该组当前显示的行数**——搜索过滤时跟着变，不是集合里的总数。
 *
 * **自己带 `padding: 0 14px`**（不是外层 `.skill-group` 容器）：组间发丝线
 * （`.skill-group + .skill-group`）要通栏，缩进只能落在标题自己身上，不能
 * 落在包住发丝线的容器上——否则线也跟着缩进，两侧留白，不贴边。
 */
function GroupLabel(props: { children: React.ReactNode; count: number; danger?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 26,
        padding: "0 14px",
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-micro)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: props.danger === true ? "var(--color-danger)" : "var(--color-text-secondary)",
      }}
    >
      {props.children}
      <span style={{ color: "var(--color-text-tertiary)" }}>&nbsp;· {props.count}</span>
    </span>
  );
}

function SkillList(props: {
  skills: SkillsState;
  workspaceName: (id: string) => string;
  onSelect: (slug: string) => void;
  onCreateSkill: () => void;
  onSwitchToMap: () => void;
  onClose: () => void;
}) {
  const { skills } = props;
  const load = skills.load;
  const error = load.kind === "failed" ? load.message : null;
  /** + 的两项菜单（4-1）：面板内展开不弹窗；再点 + 收起 */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 过滤行的查询词；分组仍在这个组件里做，过滤只决定哪些行留下（skill-filter.ts） */
  const [query, setQuery] = useState("");

  const header = (
    <>
      <Chip active title="List view">
        <Icon name="list" size={13} />
      </Chip>
      <Chip onClick={props.onSwitchToMap} title="Set map">
        <Icon name="blend" size={13} />
      </Chip>
      <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
        Skills
      </strong>
    </>
  );

  // 空态与加载：footer 的 reveal 行照常（新建的路一直在）
  if (load.kind === "loading" && skills.skills.length === 0) {
    return (
      <RightPanelFrame
        header={header}
        contentKey="list"
        onClose={props.onClose}
        headerExtra={<AddMenu skills={skills} onCreateSkill={props.onCreateSkill} />}
        footer={<FooterReveal skills={skills} />}
      >
        <div style={{ padding: "var(--space-4)" }}>
          <PanelLine>Loading…</PanelLine>
        </div>
      </RightPanelFrame>
    );
  }
  if (skills.skills.length === 0) {
    return (
      <RightPanelFrame
        header={header}
        contentKey="list"
        onClose={props.onClose}
        headerExtra={<AddMenu skills={skills} onCreateSkill={props.onCreateSkill} />}
        footer={<FooterReveal skills={skills} />}
      >
        {/* 空态自己包一层内容版式（与 MCP 面板同款）：列表行的 hover 要通到面板
            两个侧缘（行自带内边距），所以壳的内容区不能统一加 padding——
            空态没有行，忘了这层就会整段贴着面板左缘 */}
        <div
          style={{
            padding: "var(--space-4)",
            display: "grid",
            gap: "var(--space-2)",
            alignContent: "start",
          }}
        >
          {error !== null && <PanelLine danger>Couldn’t read skills. {error}</PanelLine>}
          <p style={{ margin: 0, fontSize: "var(--font-size-body)" }}>No skill yet.</p>
          <PanelLine>Create a folder with a SKILL.md in the skills directory.</PanelLine>
        </div>
      </RightPanelFrame>
    );
  }

  const total = skills.skills.length;
  const filtered = filterSkills(skills.skills, query);
  const filtering = query.trim() !== "";

  const linked = filtered.filter((s) => s.global || s.workspaces.length > 0);
  const disabled = filtered.filter((s) => !s.global && s.workspaces.length === 0);
  const globalMembers = filtered.filter((s) => s.global);

  return (
    <RightPanelFrame
      header={header}
      contentKey="list"
      onClose={props.onClose}
      headerExtra={<AddMenu skills={skills} onCreateSkill={props.onCreateSkill} />}
      footer={<FooterReveal skills={skills} />}
    >
      <>
        <div className="skills-filter-row">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Esc 清空输入；已经空了就不拦截——让它照旧冒泡去关面板（App.tsx 的
              // 全局 Esc 处理），两次 Esc 才关面板的手感和大多数搜索框一致
              if (e.key === "Escape" && query !== "") {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Filter skills…"
            aria-label="Filter skills"
          />
          <span className="skills-filter-count">{filtering ? `${filtered.length} / ${total}` : total}</span>
          {query !== "" && (
            <IconButton label="Clear" size={20} onClick={() => setQuery("")}>
              <Icon name="x" size={12} />
            </IconButton>
          )}
        </div>
        <div style={{ display: "grid", alignContent: "start" }}>
          {error !== null && (
            <div style={{ padding: "var(--space-3)" }}>
              <PanelLine danger>Couldn’t read skills. {error}</PanelLine>
            </div>
          )}
          {filtering && filtered.length === 0 ? (
            <div style={{ padding: "var(--space-4)" }}>
              <PanelLine>No skill matches “{query.trim()}”.</PanelLine>
            </div>
          ) : (
            <>
              {globalMembers.length > 0 && (
                <div className="skill-group" id="skills-group-global">
                  <GroupLabel count={globalMembers.length}>Global</GroupLabel>
                  {globalMembers.map((s) => (
                    <SkillRow
                      key={`g:${s.slug}`}
                      skill={s}
                      onSelect={props.onSelect}
                      workspaceName={props.workspaceName}
                      onClean={skills.clean}
                    />
                  ))}
                </div>
              )}
              {skills.workspaces.map((ws) => {
                const members = linked.filter((s) => !s.global && s.workspaces.includes(ws.id));
                if (members.length === 0) return null;
                return (
                  <div className="skill-group" key={ws.id} id={`skills-group-${ws.id}`}>
                    <GroupLabel count={members.length}>{ws.name}</GroupLabel>
                    {members.map((s) => (
                      <SkillRow
                        key={`${ws.id}:${s.slug}`}
                        skill={s}
                        onSelect={props.onSelect}
                        workspaceName={props.workspaceName}
                        onClean={skills.clean}
                      />
                    ))}
                  </div>
                );
              })}
              {disabled.length > 0 && (
                <div className="skill-group">
                  <GroupLabel count={disabled.length}>Disabled</GroupLabel>
                  {disabled.map((s) => (
                    <SkillRow
                      key={s.slug}
                      skill={s}
                      dim
                      onSelect={props.onSelect}
                      workspaceName={props.workspaceName}
                      onClean={skills.clean}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </>
    </RightPanelFrame>
  );
}

/**
 * 一行 skill（Global / workspace 成员 / Disabled 三处共用，原先 `row()` 闭包与
 * `DisabledRow` 是同一份骨架抄了两遍，收成一个组件）。
 *
 * 外层是 `<div>` 不是 `<button>`：missing 行要在行内浮出一个真正可点的清理键
 * （trash IconButton），`<button>` 不能嵌 `<button>`（HTML 语义 + 浏览器会把
 * 内层按钮拆出去，点击语义直接坏掉）。点击语义因此拆成两层——`.skill-row-main`
 * 是「点这行开详情」的唯一入口，外层 `.skill-row` 只管 hover 背景与布局。
 *
 * 归属点阵（SetDots）只在「非 missing、非 disabled」时画：disabled 组的成员按
 * 定义 global=false 且 workspaces=[]（这就是它被分进 Disabled 组的原因），点阵
 * 本来也是空的；missing 走行首红三角 + 红名，两套符号不共存。
 *
 * **hover tooltip**：`useHoverTooltip` 的第二个消费者（第一个是 IconButton，
 * 200ms）。行内容够长——全名、一行描述、mono 的 slug · 集合名——单行 36px 装不下，
 * 描述仍然不进列表行本身（单行纪律不破），但要看得够得着。350ms 比 IconButton
 * 的 200ms 更慢：快速划过整个列表找一行不该处处弹牌子。视觉走实色面板 + 发丝边
 * + popover 阴影（现行 *Transparency* 规则：浮在内容之上的层不用 blur、不用
 * 半透明——设计稿画的是玻璃 tooltip，那是 2026-09-23 去 blur 之前的稿）。
 * `role="tooltip"` + 行按钮 `aria-describedby` 指回它，打开时才挂 id。
 *
 * **missing 就地清理**：断链是列表里唯一需要「处理」的状态，处理入口长在现场——
 * hover（或键盘聚焦到行内）浮出红色 trash（`.reveal`，同一套 hover 浮现机制），
 * 点击进入两段式确认（与 McpPanel 删除同款：一句后果说明 + 确认 / 取消），确认
 * 后才调 `onClean`。确认态替换整行内容而不是另起一行——单行 36px 的纪律不破。
 */
function SkillRow(props: {
  skill: SkillMeta;
  /** Disabled 组：name 降到 tertiary，其余同普通行 */
  dim?: boolean;
  onSelect: (slug: string) => void;
  workspaceName: (id: string) => string;
  onClean: (slug: string) => void;
}) {
  const { skill } = props;
  const dim = props.dim === true;
  const setNames = [skill.global ? "Global" : null, ...skill.workspaces.map(props.workspaceName)].filter(
    (name): name is string => name !== null,
  );
  // 下方、左对齐行左缘 + 10px（对稿 row-tip：top:34 相对行顶即「行下方」、left:10）；
  // IconButton 的默认值（上方、居中）不受影响——只有这个调用点传了 place
  const tooltip = useHoverTooltip<HTMLButtonElement>(ROW_TOOLTIP_DELAY_MS, true, {
    side: "below",
    align: "start",
    alignOffset: 10,
  });
  const tipId = `skill-tip-${skill.slug}`;
  const [confirming, setConfirming] = useState(false);

  if (skill.missing && confirming) {
    return (
      <div className="skill-row skill-row-missing">
        <span className="skill-row-confirm-text">Clean up this missing reference?</span>
        <PanelButton
          danger
          onClick={() => {
            setConfirming(false);
            props.onClean(skill.slug);
          }}
        >
          Clean up
        </PanelButton>
        <PanelButton onClick={() => setConfirming(false)}>Cancel</PanelButton>
      </div>
    );
  }

  return (
    <div
      className={`skill-row${skill.missing ? " skill-row-missing" : dim ? " skill-row-dim" : ""}`}
    >
      <button
        ref={tooltip.anchorRef}
        type="button"
        className="skill-row-main"
        onClick={() => props.onSelect(skill.slug)}
        onMouseEnter={tooltip.handlers.onMouseEnter}
        onMouseLeave={tooltip.handlers.onMouseLeave}
        onFocus={tooltip.handlers.onFocus}
        onBlur={tooltip.handlers.onBlur}
        aria-describedby={tooltip.open ? tipId : undefined}
      >
        {skill.missing && (
          <Icon name="triangle-alert" size={13} style={{ color: "var(--color-danger)" }} />
        )}
        <span className="skill-row-name">{skill.name}</span>
      </button>
      {skill.missing && (
        <IconButton
          label="Clean up references"
          size={22}
          className="reveal"
          onClick={() => {
            // 打开确认前先收掉 tooltip：确认态整个换掉行内容，锚点按钮会被卸载，
            // 不关的话 tooltip 状态会挂在一个已经不存在的锚点上
            tooltip.handlers.onMouseLeave();
            setConfirming(true);
          }}
        >
          <Icon name="trash-2" size={14} style={{ color: "var(--color-danger)" }} />
        </IconButton>
      )}
      {!skill.missing && !dim && (
        <SetDots global={skill.global} workspaces={skill.workspaces.length} title={setNames.join(", ")} />
      )}
      {tooltip.open &&
        createPortal(
          <div
            ref={tooltip.tooltipRef}
            id={tipId}
            role="tooltip"
            className="skill-row-tip"
            style={{
              top: tooltip.placement?.top ?? 0,
              left: tooltip.placement?.left ?? 0,
              // 未落位前不显形，落位后从透明过渡进来——同 IconButton 的首帧处理
              opacity: tooltip.placement === null ? 0 : 1,
            }}
          >
            <span className="skill-row-tip-name">{skill.name}</span>
            {skill.description !== "" && <span className="skill-row-tip-desc">{skill.description}</span>}
            <span className="skill-row-tip-sets">
              {skill.slug}
              {setNames.length > 0 ? ` · ${setNames.join(", ")}` : ""}
            </span>
          </div>,
          document.body,
        )}
    </div>
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
  skills: SkillsState;
  meta: SkillMeta;
  workspaceName: (id: string) => string;
  onBack: () => void;
  onClose: () => void;
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
                className="text-field"
                style={{ cursor: disabled ? "not-allowed" : undefined }}
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
                className="text-field"
                style={{
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
      <span style={{ fontSize: "var(--font-size-caption)", fontWeight: "var(--weight-medium)" }}>
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
      className="text-field"
      style={{ cursor: props.disabled ? "not-allowed" : undefined }}
    />
  );
}

/** + 菜单：Create skill… / Link existing folder…。列表、空态、加载态三处共用。 */
function AddMenu(props: { skills: SkillsState; onCreateSkill: () => void }) {
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
              props.onCreateSkill();
            }}
          >
            <Icon name="plus" size={14} /> Create skill…
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
 * map 视图（4-4）：页头 [list][blend] 两枚 Chip + 标题 + AddMenu + x；
 * 内容是韦恩图（≥4 workspace 自动退化矩阵）。
 */
function SkillMapView(props: {
  skills: SkillsState;
  onOpenDetail: (slug: string) => void;
  onJumpToGroup: (groupId: string) => void;
  onSwitchToList: () => void;
  onCreateSkill: () => void;
  onClose: () => void;
}) {
  const { skills } = props;
  const error = skills.load.kind === "failed" ? skills.load.message : null;
  return (
    <RightPanelFrame
      contentKey="map"
      onClose={props.onClose}
      header={
        <>
          <Chip onClick={props.onSwitchToList} title="List view">
            <Icon name="list" size={13} />
          </Chip>
          <Chip active title="Set map">
            <Icon name="blend" size={13} />
          </Chip>
          <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
            Skills
          </strong>
        </>
      }
      headerExtra={<AddMenu skills={skills} onCreateSkill={props.onCreateSkill} />}
      footer={<FooterReveal skills={skills} />}
    >
      <div style={{ padding: "var(--space-3) var(--space-3) var(--space-4)" }}>
        {error !== null && <PanelLine danger>Couldn’t read skills. {error}</PanelLine>}
        {skills.load.kind === "loading" && skills.skills.length === 0 ? (
          <PanelLine>Loading…</PanelLine>
        ) : (
          <SkillsMap
            skills={skills}
            onOpenDetail={props.onOpenDetail}
            onJumpToGroup={props.onJumpToGroup}
          />
        )}
      </div>
    </RightPanelFrame>
  );
}
