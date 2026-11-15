/**
 * 设置 › 通用 › Word 导出 —— pandoc 状态与学校模板。
 *
 * 两行，都是**机器级**配置（换项目不该重选一次）：
 *
 * 1. pandoc：把 Markdown / LaTeX 转成 Word 的引擎。路径可手填 / 文件选择器选 /
 *    重新检测；版本 < 3.10.2 时这里明确说「版本过低」并给出**可点**的升级链接——
 *    公式编号依赖 3.10.2 的 `\tag` 修复，静默降级会让论文的公式号全错。
 *    手填 / 选择都先 `verifyPandoc`（不回退 PATH）：坏路径给行内错误、不写设置。
 * 2. 模板：内置默认（pandoc reference.docx + 中文字体）/ 项目内 template.docx /
 *    学校模板（文件选择器）。选了学校模板立刻体检，把「有没有页眉页脚 / 宏 / 标题样式」
 *    摊开给用户看；不可用的文件**不写设置**。
 *
 * 导出本身不在这里：它由 agent 工具 `export_docx` 走会话授权，设置页只管来源。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { PanelButton } from "../../shell/RightPanel";
import type { AppSettings, SettingsPatch } from "../../../../shared/settings.ts";
import type { DocxTemplateMode, DocxTemplateReport, PandocProbeResult } from "../../../../shared/docx-export.ts";
import { SettingGroup, SettingRow } from "./SettingRow";
import { Segmented } from "./SettingControls";

type Loadable<T> = { kind: "loading" } | { kind: "ready"; value: T } | { kind: "error"; error: string };

const PANDOC_INSTALL_URL = "https://pandoc.org/installing.html";

/** 设置层只认绝对路径（相对路径会随 cwd 漂）；这里先拦一道，错在输入时就说 */
function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path);
}

export function WordExportSettings(props: {
  settings: AppSettings;
  onChange: (patch: SettingsPatch) => void;
}) {
  const t = useT();
  const [probe, setProbe] = useState<Loadable<PandocProbeResult>>({ kind: "loading" });
  const [probeBusy, setProbeBusy] = useState(false);
  const [draftPath, setDraftPath] = useState(props.settings.pandocPath ?? "");
  const [pathError, setPathError] = useState<string | null>(null);
  const [pathBusy, setPathBusy] = useState(false);
  const [pickingPandoc, setPickingPandoc] = useState(false);
  const [report, setReport] = useState<Loadable<DocxTemplateReport>>({ kind: "loading" });
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const mode: DocxTemplateMode = props.settings.docxTemplateMode ?? "default";

  // 设置里的路径变了（选择器写完 / 别处改了设置）→ 输入框跟着走
  useEffect(() => {
    setDraftPath(props.settings.pandocPath ?? "");
  }, [props.settings.pandocPath]);

  // pandoc 探测随设置里的路径变化重跑：指向 3.12.1 后状态要当场变绿
  useEffect(() => {
    let cancelled = false;
    setProbe({ kind: "loading" });
    void api.docxExport
      .probe()
      .then((value) => {
        if (!cancelled) setProbe({ kind: "ready", value });
      })
      .catch((error: unknown) => {
        if (!cancelled) setProbe({ kind: "error", error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [props.settings.pandocPath]);

  // 模板报告随模式 / 路径变化重读：切到「学校模板」要立刻看到那一份的体检结论
  useEffect(() => {
    let cancelled = false;
    setReport({ kind: "loading" });
    void api.docxExport
      .inspect()
      .then((value) => {
        if (!cancelled) setReport({ kind: "ready", value });
      })
      .catch((error: unknown) => {
        if (!cancelled) setReport({ kind: "error", error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [mode, props.settings.docxTemplatePath]);

  const recheck = (): void => {
    setProbeBusy(true);
    setPathError(null);
    void api.docxExport
      .probe({ refresh: true })
      .then((value) => setProbe({ kind: "ready", value }))
      .catch((error: unknown) => setProbe({ kind: "error", error: error instanceof Error ? error.message : String(error) }))
      .finally(() => setProbeBusy(false));
  };

  /** 手填路径：绝对路径 → 现验 → 通过才写设置；空串 = 清除，回到 PATH 探测 */
  const applyPandocPath = (raw: string): void => {
    const value = raw.trim();
    setPathError(null);
    if (value === "") {
      props.onChange({ pandocPath: "" });
      return;
    }
    if (!isAbsolutePath(value)) {
      setPathError(t.settings.pandocPathAbsolute);
      return;
    }
    if (value === (props.settings.pandocPath ?? "")) return;
    setPathBusy(true);
    void api.docxExport
      .verifyPandoc({ path: value })
      .then((outcome) => {
        if (!outcome.ok) {
          setPathError(t.settings.pandocPathInvalid);
          return;
        }
        props.onChange({ pandocPath: value });
      })
      .catch(() => setPathError(t.settings.pandocPathInvalid))
      .finally(() => setPathBusy(false));
  };

  const choosePandoc = (): void => {
    setPickingPandoc(true);
    setPathError(null);
    void api.docxExport
      .pickPandoc()
      .then((outcome) => {
        if (outcome.kind === "cancelled") return;
        if (outcome.kind === "invalid") {
          setPathError(t.settings.pandocPathInvalid);
          return;
        }
        props.onChange({ pandocPath: outcome.path });
      })
      .catch(() => setPathError(t.settings.pandocPathInvalid))
      .finally(() => setPickingPandoc(false));
  };

  const choose = (): void => {
    setPicking(true);
    setPickError(null);
    void api.docxExport
      .pickTemplate()
      .then((outcome) => {
        if (outcome.kind === "cancelled") return;
        if (outcome.kind === "invalid") {
          setPickError(`${t.settings.docxTemplateInvalid}: ${outcome.report.summary}`);
          return;
        }
        setReport({ kind: "ready", value: outcome.report });
      })
      .catch((error: unknown) => setPickError(error instanceof Error ? error.message : String(error)))
      .finally(() => setPicking(false));
  };

  const probeNote = ((): { text: string; error: boolean } | null => {
    if (pathError !== null) return { text: pathError, error: true };
    if (pathBusy || pickingPandoc) return { text: t.settings.pandocDetecting, error: false };
    if (probe.kind === "loading") return { text: t.settings.pandocDetecting, error: false };
    if (probe.kind === "error") return { text: probe.error, error: true };
    const value = probe.value;
    if (!value.ok) return { text: t.settings.pandocMissing, error: true };
    if (!value.supported) return { text: `${t.settings.pandocTooOld} · ${value.versionText ?? ""}`, error: true };
    return { text: `${value.versionText ?? ""}${value.path === null ? "" : ` · ${value.path}`}`, error: false };
  })();

  const probeTooltip = probe.kind === "ready" ? probe.value.message : undefined;
  const needsUpgrade = probe.kind === "ready" && (!probe.value.ok || !probe.value.supported);

  const reportValue = report.kind === "ready" ? report.value : null;
  const findings = reportValue === null ? [] : reportValue.findings.slice(0, 6);

  return (
    <SettingGroup label={t.settings.wordExportGroup}>
      <SettingRow
        name={t.settings.pandocStatus}
        info={t.settings.pandocStatusInfo}
        note={
          probeNote === null ? undefined : (
            <span className={probeNote.error ? "set-row-error" : "set-row-note"} title={probeTooltip}>
              {probeNote.error && <Icon name="triangle-alert" size={12} strokeWidth={1.8} />}
              <span>{probeNote.text}</span>
              {needsUpgrade && (
                <a
                  className="upd-link"
                  href={PANDOC_INSTALL_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    event.preventDefault();
                    window.open(PANDOC_INSTALL_URL);
                  }}
                >
                  <Icon name="external-link" size={12} />
                  {t.settings.pandocUpgrade}
                </a>
              )}
            </span>
          )
        }
      >
        <span className="pandoc-path-row">
          <input
            className="text-field voice-field"
            aria-label={t.settings.pandocPathAria}
            spellCheck={false}
            value={draftPath}
            placeholder={t.settings.pandocPathPlaceholder}
            onChange={(event) => {
              setDraftPath(event.target.value);
              if (pathError !== null) setPathError(null);
            }}
            onBlur={() => applyPandocPath(draftPath)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              applyPandocPath(draftPath);
            }}
          />
          <PanelButton onClick={choosePandoc} disabled={pickingPandoc || pathBusy}>
            {t.settings.pandocChoose}
          </PanelButton>
          <PanelButton onClick={recheck} disabled={probeBusy || pathBusy}>
            <Icon name="refresh-cw" size={14} /> {probeBusy ? t.settings.pandocDetecting : t.settings.pandocDetect}
          </PanelButton>
        </span>
      </SettingRow>

      <SettingRow
        name={t.settings.docxTemplate}
        info={t.settings.docxTemplateInfo}
        note={
          report.kind === "error" ? (
            <span role="alert" className="set-row-error">
              {report.error}
            </span>
          ) : reportValue === null ? (
            <span className="set-row-note">{t.settings.pandocDetecting}</span>
          ) : (
            <span
              className={reportValue.ok ? "set-row-note" : "set-row-error"}
              title={reportValue.path ?? undefined}
            >
              {!reportValue.ok && <Icon name="triangle-alert" size={12} strokeWidth={1.8} />}
              <span>{reportValue.summary}</span>
            </span>
          )
        }
        below={
          findings.length === 0 ? undefined : (
            <ul className="docx-template-findings">
              {findings.map((finding) => (
                <li key={`${finding.level}:${finding.label}`} data-level={finding.level}>
                  <span>{finding.label}</span>
                  {finding.detail !== undefined && <span className="docx-template-finding-detail">{finding.detail}</span>}
                </li>
              ))}
            </ul>
          )
        }
      >
        <span className="set-inline">
          <Segmented<DocxTemplateMode>
            label={t.settings.docxTemplate}
            value={mode}
            options={[
              { value: "default", label: t.settings.docxTemplateDefault },
              { value: "project", label: t.settings.docxTemplateProject },
              { value: "custom", label: t.settings.docxTemplateCustom },
            ]}
            onChange={(next) => props.onChange({ docxTemplateMode: next })}
          />
          {mode === "custom" && (
            <PanelButton onClick={choose} disabled={picking} title={t.settings.docxTemplateChoose}>
              {picking ? t.settings.docxTemplateChoosing : t.settings.docxTemplateChoose}
            </PanelButton>
          )}
        </span>
        {mode === "custom" && (
          <span className="docx-template-path">
            {props.settings.docxTemplatePath === undefined ? (
              <span className="set-row-desc">{t.settings.docxTemplateNone}</span>
            ) : (
              <code className="data-dir-path" title={props.settings.docxTemplatePath}>
                <bdi dir="ltr">{props.settings.docxTemplatePath}</bdi>
              </code>
            )}
            {pickError !== null && (
              <span role="alert" className="set-row-error">
                {pickError}
              </span>
            )}
          </span>
        )}
        {mode === "project" && <span className="set-row-desc">{t.settings.docxTemplateProjectHint}</span>}
      </SettingRow>
    </SettingGroup>
  );
}
