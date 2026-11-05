/**
 * 详情页的「工作流」：清单 `orbita.workflow` 画成竖向步骤列表（给人看，不执行）。
 * 步骤上的技能可点开只读查看 SKILL.md；写了技能名却对不上本插件任何一条的，原样显示并标出来。
 * 没写 workflow 的插件整块不出现（调用方判）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PluginWorkflowStep } from "@shared/plugin";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";

export function WorkflowCard(props: { pluginName: string; steps: readonly PluginWorkflowStep[] }) {
  const t = useT().plugins;
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <section className="pl-card">
      <div className="pl-card-h">
        {t.workflowTitle}
        <span className="hint">{t.workflowHint}</span>
      </div>
      <ol className="pl-wf">
        {props.steps.map((step, index) => (
          <li key={index} className="pl-wf-step">
            <span className="pl-wf-n" aria-hidden="true">
              {index + 1}
            </span>
            <div className="pl-wf-body">
              <b>{step.title}</b>
              {step.detail !== null && <small>{step.detail}</small>}
              {(step.skill !== null || step.output !== null) && (
                <span className="pl-wf-chips">
                  {step.skill !== null &&
                    (step.skillSlug !== null ? (
                      <button
                        type="button"
                        className="pl-wf-chip"
                        title={t.workflowViewSkill(step.skillSlug)}
                        onClick={() => setViewing(step.skillSlug)}
                      >
                        <Icon name="book-open" size={12} strokeWidth={1.8} />
                        {step.skill}
                      </button>
                    ) : (
                      <span className="pl-wf-chip missing" title={t.workflowSkillMissing}>
                        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
                        {step.skill}
                        <em>{t.workflowSkillMissing}</em>
                      </span>
                    ))}
                  {step.output !== null && (
                    <span className="pl-wf-chip out" title={t.workflowOutput}>
                      <Icon name="file-text" size={12} strokeWidth={1.8} />
                      <code>{step.output}</code>
                    </span>
                  )}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
      {viewing !== null && <SkillViewer pluginName={props.pluginName} slug={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}

/** 只读看一条插件技能的 SKILL.md：原文，不渲染、不可编辑。Esc / 点遮罩关。 */
function SkillViewer(props: { pluginName: string; slug: string; onClose: () => void }) {
  const messages = useT();
  const t = messages.plugins;
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; path: string; content: string } | { kind: "failed"; message: string }>({ kind: "loading" });
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    api.plugin
      .skillFile(props.pluginName, props.slug)
      .then((file) => {
        if (alive) setState({ kind: "ready", path: file.path, content: file.content });
      })
      .catch((cause: unknown) => {
        if (alive) setState({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      alive = false;
    };
  }, [props.pluginName, props.slug]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return createPortal(
    <div className="pv-modal-root">
      <div
        className="pv-modal-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <div className="pv-modal pl-modal" role="dialog" aria-modal="true" aria-label={t.skillViewTitle(props.slug)}>
          <div className="pv-modal-head">
            <strong>{t.skillViewTitle(props.slug)}</strong>
            <span className="pl-wf-ro">{t.skillViewReadOnly}</span>
            <span style={{ flex: 1 }} />
            <button ref={closeRef} type="button" className="pv-btn icon" aria-label={messages.common.close} title={messages.common.close} onClick={props.onClose}>
              <Icon name="x" size={15} />
            </button>
          </div>
          <div className="pv-modal-body">
            {state.kind === "loading" && <span className="pl-muted">{t.skillViewLoading}</span>}
            {state.kind === "failed" && (
              <div className="pl-note danger" role="alert">
                <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
                <span>{t.skillViewFailed(state.message)}</span>
              </div>
            )}
            {state.kind === "ready" && (
              <>
                <span className="pl-code">{state.path}</span>
                <pre className="pl-skillmd">{state.content}</pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
