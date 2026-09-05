import { useEffect, useRef, useState } from "react";
import { Chip } from "../../shell/Chip";
import { Icon } from "../../shell/Icon";
import { describeList } from "../chat/load-state";
import type { SkillsState } from "./useSkills";
import { api } from "../../api";
import type { SkillContent } from "@shared/skill";


/**
 * Skills 面。**和设置面同一个壳**：列表长在侧栏，右边还是同一张 `.pane`。
 *
 * 这个面是**开会话前的准备工具，不是会话中的控制台**：skill 的索引进 system prompt，
 * 而 prompt 是 provider 缓存的第一个断点——启停改的正是那一段，所以它对已经开着的
 * 会话不生效，下次新建才生效。界面必须把这句话说出来，否则用户点了没反应会以为坏了。
 */
export function SkillsView(props: { skills: SkillsState }) {
  const { skills } = props;
  const selected = skills.skills.find((s) => s.slug === skills.selected) ?? null;
  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr)",
      }}
    >
      {/* 与聊天页同一个页头形状——同一张卡，页头就该长一样 */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          minWidth: 0,
          height: 30,
          padding: "12px 18px",
          boxSizing: "content-box",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
          {selected === null ? "Skills" : selected.name}
        </strong>
        {selected !== null && (
          <span
            style={{
              fontSize: "var(--font-size-caption)",
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-family-mono)",
            }}
            title="Folder name. Renaming the skill does not rename this."
          >
            {selected.slug}
          </span>
        )}
      </header>

      <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
        <div style={{ width: "min(100%, var(--content-max-width))", margin: "0 auto" }}>
          {selected === null ? (
            <Overview skills={skills} />
          ) : (
            <Detail
              key={selected.slug}
              slug={selected.slug}
              enabled={selected.enabled}
              skills={skills}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** 没选中时：说清楚这个面是干什么的，以及 skill 从哪来。 */
function Overview(props: { skills: SkillsState }) {
  const { skills } = props;
  const list = describeList(skills.load, skills.skills.length);
  const on = skills.skills.filter((s) => s.enabled).length;
  return (
    <section style={{ display: "grid", gap: "var(--space-4)" }}>
      <p style={{ margin: 0, fontSize: "var(--font-size-body)", color: "var(--color-text-secondary)" }}>
        A skill is a folder with a <code>SKILL.md</code> inside. Enabled skills are listed for the
        agent by name and description; it reads the full file only when a task matches.
      </p>
      {list.error !== null && <Line tone="bad">{list.error}</Line>}
      {list.body === "loading" ? (
        <Line tone="busy">Loading skills…</Line>
      ) : list.body === "empty" ? (
        <Line tone="busy">No skill yet. Put a folder with a SKILL.md into the skills directory.</Line>
      ) : list.body === "list" ? (
        <Line tone="busy">
          {on} of {skills.skills.length} enabled. Pick one on the left to read or edit it.
        </Line>
      ) : null}
      <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
        Enabling or disabling takes effect in the next new task, not in tasks already running.
      </p>
      <span>
        <button type="button" onClick={() => skills.reveal(null)} style={buttonStyle}>
          <Icon name="folder" size={14} /> Open skills folder
        </button>
      </span>
    </section>
  );
}

/**
 * 详情：启停 + 三段编辑。
 *
 * **失焦保存，不做 700ms 自动保存那套状态机**——那套复杂度来自并发写入与冲突合并，
 * 而这里只有一个写入者。保存失败当场说出来，不静默重试（同 D-3 的纪律）。
 */
function Detail(props: { slug: string; enabled: boolean; skills: SkillsState }) {
  const { slug, enabled, skills } = props;
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
      .read(slug)
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
  }, [slug]);

  const commit = (field: keyof SkillContent) => () => {
    const draft = content;
    const base = saved.current;
    if (draft === null || base === null || draft[field] === base[field]) return;
    setSaving(true);
    setError(null);
    void skills
      .save(slug, { [field]: draft[field] })
      .then(() => {
        saved.current = { ...base, [field]: draft[field] };
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  };

  if (error !== null && content === null) return <Line tone="bad">{error}</Line>;
  if (content === null) return <Line tone="busy">Loading…</Line>;

  return (
    <section style={{ display: "grid", gap: "var(--space-5)" }}>
      <Field
        label="Status"
        hint="Enabling moves the folder into skills/; disabling moves it into skills-inactive/. Applies to the next new task."
      >
        <span style={{ display: "flex", gap: 2 }}>
          <Chip active={enabled} onClick={() => !enabled && skills.toggle(slug, true)}>
            Enabled
          </Chip>
          <Chip active={!enabled} onClick={() => enabled && skills.toggle(slug, false)}>
            Disabled
          </Chip>
        </span>
      </Field>

      <Field label="Name" hint="How the agent refers to this skill. The folder name does not change.">
        <input
          value={content.name}
          onChange={(e) => setContent({ ...content, name: e.target.value })}
          onBlur={commit("name")}
          style={inputStyle}
        />
      </Field>

      <Field
        label="Description"
        hint="The agent sees this in every task and uses it to decide whether to read the skill. Keep it about when to use it."
      >
        <textarea
          value={content.description}
          onChange={(e) => setContent({ ...content, description: e.target.value })}
          onBlur={commit("description")}
          rows={3}
          style={{ ...inputStyle, height: "auto", padding: "var(--space-2) var(--space-3)", resize: "vertical" }}
        />
      </Field>

      <Field label="Instructions" hint="Read only when a task matches the description.">
        <textarea
          value={content.body}
          onChange={(e) => setContent({ ...content, body: e.target.value })}
          onBlur={commit("body")}
          rows={16}
          style={{
            ...inputStyle,
            height: "auto",
            padding: "var(--space-2) var(--space-3)",
            resize: "vertical",
            fontFamily: "var(--font-family-mono)",
            lineHeight: 1.6,
          }}
        />
      </Field>

      {error !== null && <Line tone="bad">Couldn’t save. {error}</Line>}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <button type="button" onClick={() => skills.reveal(slug)} style={buttonStyle}>
          <Icon name="folder" size={14} /> Show in folder
        </button>
        <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {saving ? "Saving…" : "Saved when you leave a field"}
        </span>
      </div>
    </section>
  );
}

function Field(props: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: "var(--space-2)" }}>
      <span style={{ fontSize: "var(--font-size-label)", fontWeight: "var(--weight-medium)" }}>
        {props.label}
      </span>
      {props.children}
      <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
        {props.hint}
      </span>
    </label>
  );
}

function Line(props: { tone: "bad" | "busy"; children: React.ReactNode }) {
  return (
    <p
      role={props.tone === "bad" ? "alert" : undefined}
      style={{
        margin: 0,
        fontSize: "var(--font-size-caption)",
        color: props.tone === "bad" ? "var(--color-danger)" : "var(--color-text-tertiary)",
      }}
    >
      {props.children}
    </p>
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

const buttonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  height: "var(--control-height-md)",
  padding: "0 var(--space-4)",
  background: "var(--color-bg-muted)",
  color: "var(--color-text-primary)",
  border: 0,
  borderRadius: "var(--radius-md)",
  font: "inherit",
  fontSize: "var(--font-size-control)",
  cursor: "pointer",
};
