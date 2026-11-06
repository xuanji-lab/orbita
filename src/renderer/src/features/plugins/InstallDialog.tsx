/**
 * 接入插件：先选来源（本地文件夹或 git 地址），读出来之后给一张确认单，确认才装。
 *
 * 确认单回答「装了它会发生什么」：它带了什么、它的 MCP 会在本机启动的**完整命令行**
 * （变量已替换、敏感值掩码）、要你填什么、orbita 暂不支持什么、有没有冲突、启用在哪。
 * 复制 / git 在读的时候就拷进了暂存区（previewId），确认的就是装上的；
 * 关掉对话框不装就清掉暂存。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  PluginConflict,
  PluginInstallMode,
  PluginPreview,
  PluginScope,
  PluginSource,
} from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { ScopeEditor } from "./PluginConfig.tsx";
import { McpAbility, PluginAvatar, ScriptsAbility, SkillAbility, UnsupportedAbility } from "./PluginParts.tsx";
import { conflictText, previewErrorText, problemText } from "./plugin-text.ts";

type Step =
  | { kind: "pick" }
  | { kind: "confirm"; preview: PluginPreview; mode: PluginInstallMode };

export function InstallDialog(props: {
  workspaces: readonly Workspace[];
  onClose: () => void;
  /** 装好了：把新插件的视图 id 交出去，页面跳去它的详情 */
  onInstalled: (id: string) => void;
}) {
  const messages = useT();
  const t = messages.plugins;
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [busy, setBusy] = useState<null | "reading" | "installing">(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<PluginConflict[] | null>(null);
  const [scope, setScope] = useState<PluginScope>({ kind: "global" });
  const [gitUrl, setGitUrl] = useState("");
  // 卸载时要清暂存：用 ref 拿最新的句柄，不让 effect 清理函数读到旧值
  const stagedRef = useRef<string | null>(null);
  stagedRef.current = step.kind === "confirm" ? step.preview.previewId : null;
  const doneRef = useRef(false);

  useEffect(
    () => () => {
      const id = stagedRef.current;
      if (id !== null && !doneRef.current) void api.plugin.discard(id).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // 捕获阶段拦下：对话框开着时这一下 Esc 只属于它。否则右栏版里 App 的「Esc 关右栏面板」
      // 会在同一下按键里把承载这个对话框的面板一起收掉（忙时更糟：装到一半面板没了）
      event.stopPropagation();
      if (busy === null) props.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, props]);

  const read = async (source: PluginSource, mode: PluginInstallMode): Promise<void> => {
    setBusy("reading");
    setError(null);
    setConflicts(null);
    try {
      const result = await api.plugin.preview({ source, mode });
      if (!result.ok) {
        setError(previewErrorText(t, result.error));
        return;
      }
      setStep({ kind: "confirm", preview: result.preview, mode });
    } catch (cause) {
      setError(t.install.error.readFailed(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(null);
    }
  };

  const pickFolder = async (): Promise<void> => {
    const path = await api.plugin.pickFolder().catch(() => null);
    if (path !== null) await read({ kind: "folder", path }, "copy");
  };

  /** 换装法（复制 ↔ 链接）：暂存是按装法拷的，丢掉旧的、按新装法重读一遍。 */
  const switchMode = async (preview: PluginPreview, mode: PluginInstallMode): Promise<void> => {
    if (preview.previewId !== null) await api.plugin.discard(preview.previewId).catch(() => undefined);
    await read(preview.source, mode);
  };

  const install = async (preview: PluginPreview, mode: PluginInstallMode): Promise<void> => {
    setBusy("installing");
    setError(null);
    try {
      const result = await api.plugin.install({ preview: { source: preview.source, mode }, previewId: preview.previewId, scope });
      if (result.ok) {
        doneRef.current = true;
        props.onInstalled(result.id);
        return;
      }
      if (result.error.kind === "conflict") setConflicts(result.error.conflicts);
      else setError(previewErrorText(t, result.error));
    } catch (cause) {
      setError(t.install.error.readFailed(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(null);
    }
  };

  const confirm = step.kind === "confirm" ? step : null;
  const shownConflicts = conflicts ?? confirm?.preview.conflicts ?? [];
  const blocked = shownConflicts.length > 0;

  const dialog = (
    <div className="pv-modal-root">
      <div
        className="pv-modal-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget && busy === null) props.onClose();
        }}
      >
        <div
          className="pv-modal pl-modal"
          role="dialog"
          aria-modal="true"
          aria-label={confirm === null ? t.install.title : t.install.confirmTitle(confirm.preview.displayName)}
        >
          <div className="pv-modal-head">
            <strong>{confirm === null ? t.install.title : t.install.confirmTitle(confirm.preview.displayName)}</strong>
            <span className="pv-spacer" style={{ flex: 1 }} />
            <button
              type="button"
              className="pv-btn icon"
              aria-label={messages.common.close}
              title={messages.common.close}
              onClick={props.onClose}
              disabled={busy === "installing"}
            >
              <Icon name="x" size={15} />
            </button>
          </div>

          <div className="pv-modal-body">
            {confirm === null ? (
              <div className="pl-pick">
                <div className="pl-section">
                  <button type="button" className="pl-btn btn-accent" style={{ justifySelf: "start" }} disabled={busy !== null} onClick={() => void pickFolder()}>
                    <Icon name="folder-open" size={13} strokeWidth={1.8} />
                    {t.install.pickFolder}
                  </button>
                </div>
                <div className="pl-git">
                  <span className="pl-section-h">{t.install.orGit}</span>
                  <span className="pl-field-row">
                    <input
                      className="text-field"
                      value={gitUrl}
                      spellCheck={false}
                      placeholder={t.install.gitPlaceholder}
                      aria-label={t.install.orGit}
                      onChange={(event) => setGitUrl(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && gitUrl.trim() !== "" && busy === null) void read({ kind: "git", url: gitUrl.trim() }, "copy");
                      }}
                    />
                    <button
                      type="button"
                      className="pl-btn"
                      disabled={busy !== null || gitUrl.trim() === ""}
                      onClick={() => void read({ kind: "git", url: gitUrl.trim() }, "copy")}
                    >
                      {t.install.gitRead}
                    </button>
                  </span>
                  <span className="pl-field-hint">{t.install.gitHint}</span>
                </div>
                {busy === "reading" && <span className="pl-muted">{t.install.reading}</span>}
                {error !== null && (
                  <div className="pl-note danger" role="alert">
                    <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="pl-hero" style={{ gap: "var(--space-3)" }}>
                  <PluginAvatar view={{ origin: "plugin" }} big />
                  <div className="pl-hero-main">
                    <div style={{ fontSize: "var(--font-size-lg)", fontWeight: "var(--weight-semibold)" }}>{confirm.preview.displayName}</div>
                    <div className="pl-by">
                      {[confirm.preview.author, confirm.preview.version, confirm.preview.license].filter((part): part is string => part !== null).join(" · ")}
                    </div>
                    {confirm.preview.description !== "" && <div className="pl-lead">{confirm.preview.description}</div>}
                  </div>
                </div>

                {blocked && (
                  <div className="pl-note danger" role="alert">
                    <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
                    <div style={{ display: "grid", gap: "var(--space-1)" }}>
                      <b>{t.install.cannotInstall}</b>
                      {shownConflicts.map((conflict, index) => (
                        <span key={index}>{conflictText(t, conflict)}</span>
                      ))}
                    </div>
                  </div>
                )}

                <section className="pl-section">
                  <div className="pl-section-h">{t.install.modeTitle}</div>
                  {confirm.preview.mode === "git" ? (
                    <span className="pl-confirm">
                      <Icon name="git-branch" size={13} strokeWidth={1.8} />
                      {confirm.preview.source.kind === "git" ? t.install.modeGitLine(confirm.preview.source.url) : ""}
                    </span>
                  ) : (
                    <div className="pl-radio" role="radiogroup" aria-label={t.install.modeTitle}>
                      {(["copy", "link"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={confirm.mode === mode}
                          disabled={busy !== null}
                          onClick={() => {
                            if (confirm.mode !== mode) void switchMode(confirm.preview, mode);
                          }}
                        >
                          <b>{mode === "copy" ? t.install.modeCopy : t.install.modeLink}</b>
                          <small>{mode === "copy" ? t.install.modeCopyHint : t.install.modeLinkHint}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <section className="pl-section">
                  <div className="pl-section-h">{t.install.bringsTitle}</div>
                  <div className="pl-box">
                    {confirm.preview.skills.length === 0 && !confirm.preview.hasScripts ? (
                      <span className="pl-muted">{t.abilitiesEmpty}</span>
                    ) : (
                      <>
                        {confirm.preview.skills.map((skill) => (
                          <SkillAbility key={skill.slug} skill={skill} />
                        ))}
                        {confirm.preview.hasScripts && <ScriptsAbility />}
                      </>
                    )}
                  </div>
                </section>

                <section className="pl-section">
                  <div className="pl-section-h">{t.install.commandsTitle}</div>
                  {confirm.preview.mcp.length === 0 ? (
                    <span className="pl-muted">{t.install.commandsNone}</span>
                  ) : (
                    <>
                      <div className="pl-box">
                        {confirm.preview.mcp.map((server) => (
                          <McpAbility key={server.name} server={server} />
                        ))}
                      </div>
                      <span className="pl-field-hint">{t.install.commandsNote}</span>
                    </>
                  )}
                </section>

                {confirm.preview.config.length > 0 && (
                  <section className="pl-section">
                    <div className="pl-section-h">{t.install.configTitle}</div>
                    <ul className="pl-list">
                      {confirm.preview.config.map((field) => (
                        <li key={field.key}>
                          <b>{field.title}</b>
                          {field.required ? ` · ${t.configRequired}` : ""}
                          {field.description !== "" ? ` — ${field.description}` : ""}
                        </li>
                      ))}
                    </ul>
                    <span className="pl-field-hint">{t.install.configNote}</span>
                  </section>
                )}

                {confirm.preview.unsupported.length > 0 && (
                  <section className="pl-section">
                    <div className="pl-section-h">
                      {t.install.unsupportedTitle} <span style={{ fontWeight: "var(--weight-regular)", color: "var(--color-text-tertiary)" }}>· {t.install.unsupportedNote}</span>
                    </div>
                    <div className="pl-box">
                      {confirm.preview.unsupported.map((entry) => (
                        <UnsupportedAbility key={entry.kind} entry={entry} />
                      ))}
                    </div>
                  </section>
                )}

                {confirm.preview.problems.length > 0 && (
                  <section className="pl-section">
                    <div className="pl-section-h">{t.problemsTitle}</div>
                    <ul className="pl-list">
                      {confirm.preview.problems.map((problem, index) => (
                        <li key={index}>{problemText(t, problem)}</li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="pl-section">
                  <div className="pl-section-h">{t.install.scopeTitle}</div>
                  <ScopeEditor scope={scope} workspaces={props.workspaces} offLabel={t.scopeInstallOff} onChange={setScope} />
                </section>
              </>
            )}
          </div>

          <div className="pv-modal-foot">
            {confirm !== null && error !== null && <span className="pl-modal-foot-note">{error}</span>}
            <span style={{ flex: 1 }} />
            <button type="button" className="pl-btn" disabled={busy === "installing"} onClick={props.onClose}>
              {messages.common.cancel}
            </button>
            {confirm !== null && (
              <button
                type="button"
                className="pl-btn btn-accent"
                disabled={blocked || busy !== null || (scope.kind === "workspaces" && scope.ids.length === 0)}
                onClick={() => void install(confirm.preview, confirm.mode)}
              >
                {busy === "installing" ? t.install.installing : t.install.action}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
  return createPortal(dialog, document.body);
}
