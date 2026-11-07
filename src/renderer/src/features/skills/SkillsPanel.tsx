import { useEffect, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { PanelButton, PanelIconButton, PanelLine, RightPanelFrame } from "../../shell/RightPanel";
import { api } from "../../api";
import type { SkillsState } from "./useSkills";
import type { SkillContent, SkillMeta } from "@shared/skill";
import { useT } from "../../locale.ts";

/**
 * 一条 skill 的详情：改可用范围（全局 / 各工作区）与三段编辑（名称、描述、说明），
 * 失焦即存。列表在能力面板里（features/abilities/AbilitiesPanel.tsx，2026-10-30
 * Skills 与 MCP 合成一张列表）——点一行打开这里，返回键回列表。
 *
 * footer：中央目录 reveal（新建 / 删除仍走访达——它们是文件管理器最擅长的事）。
 */
export function SkillDetail(props: {
  skills: SkillsState;
  meta: SkillMeta;
  workspaceName: (id: string) => string;
  onBack: () => void;
}) {
  const t = useT();
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
    ? t.skills.missing
    : meta.linkedPath !== null
      ? t.skills.linked
      : meta.global
        ? t.skills.global
        : meta.workspaces.length > 0
          ? t.skills.workspace
          : t.skills.disabled;
  const disabled = meta.missing;
  const disabledTitle = t.skills.missingTip;

  return (
    <RightPanelFrame
      contentKey={`detail:${meta.slug}`}
      header={
        <>
          <PanelIconButton title={t.skills.backToList} onClick={props.onBack}>
            <Icon name="chevron-left" size={16} strokeWidth={2} />
          </PanelIconButton>
          <strong className="cap-title">{meta.name}</strong>
        </>
      }
      footer={
        meta.missing ? (
          <>
            <span style={{ flex: 1 }} />
            <PanelButton danger onClick={() => skills.clean(meta.slug)}>
              <Icon name="trash-2" size={14} /> {t.skills.cleanUpReferences}
            </PanelButton>
          </>
        ) : (
          <>
            <PanelButton onClick={() => skills.reveal(meta.slug)}>
              <Icon name="folder" size={14} /> {t.skills.showInFinder}
            </PanelButton>
            <span style={{ flex: 1 }} />
            <PanelLine>{saving ? t.skills.saving : t.skills.savedOnBlur}</PanelLine>
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
          <PanelLine danger>{t.skills.folderMissing}</PanelLine>
        )}
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <code
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-family-mono)",
            }}
            title={t.skills.folderNameTip}
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
              fontSize: "var(--font-size-xs)",
              color: meta.missing ? "var(--color-danger)" : "var(--color-text-secondary)",
            }}
          >
            {badge}
          </span>
          {/* 导入的 skill：标 Linked 并显示真身路径（4-1）；「在访达里显示」揭示的也是真身 */}
          {meta.linkedPath !== null && (
            <span
              style={{
                fontSize: "var(--font-size-xs)",
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
            <Field label={t.skills.worksIn}>
              <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                <Chip
                  active={meta.global}
                  title={t.skills.everyTask}
                  onClick={() =>
                    meta.global
                      ? skills.unlink(meta.slug, { kind: "global" })
                      : skills.link(meta.slug, { kind: "global" })
                  }
                >
                  {t.skills.global}
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
                  {t.skills.appliesNext}
                </PanelLine>
              </span>
            </Field>
          </>
        )}

        {error !== null && <PanelLine danger>{t.skills.saveFailed} {error}</PanelLine>}

        {content === null && !meta.missing && <PanelLine>{t.common.loading}</PanelLine>}
        {content !== null && (
          <div
            style={{ display: "grid", gap: "var(--space-4)", pointerEvents: disabled ? "none" : undefined }}
            title={disabled ? disabledTitle : undefined}
          >
            <Field label={t.skills.name} hint={t.skills.nameHint}>
              <PanelInput
                value={content.name}
                disabled={disabled}
                title={disabled ? disabledTitle : undefined}
                onChange={(name) => setContent({ ...content, name })}
                onBlur={commit("name")}
              />
            </Field>
            <Field label={t.skills.description} hint={t.skills.descriptionHint}>
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
            <Field label={t.skills.instructions} hint={t.skills.instructionsHint}>
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
                  lineHeight: "var(--line-height-code)",
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
      <span style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--weight-medium)" }}>
        {props.label}
      </span>
      {props.children}
      {props.hint !== undefined && (
        <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-tertiary)" }}>
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
