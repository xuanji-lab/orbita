/**
 * 设置页「LaTeX 论文」面板 —— preflight 环境自检（用户 2026-11-22 定：
 * 开功能时先把这台机器验一遍，缺什么、怎么修、交给 agent 修时用什么提示词，都在面板里）。
 *
 * checklist 全部走真实探测（latex:probe / latex:env-check），不是写死的状态；
 * 「让 agent 装/修」把修复指令交给会话（App 的 repairLatex），不在面板里自己装。
 *
 * 2026-11-27 三处修正（Windows 实拍 + 用户裁决）：
 * - **行一律走 SettingRow**：原来三行是「标签 + 说明 + 按钮」塞进两列网格，第三个子元素
 *   换到第二行第一列——「latexmk 路径」的文件夹按钮因此掉在标签下方（1600 宽全幅也一样，
 *   不是挤的）；控件列由 `.set-row-ctl` 承担，按钮回到行尾；
 * - **删掉「保存即编译」这一行**：它是项目级开关，住在项目 ⋮ 菜单里；设置页没有「当前项目」
 *   这个上下文，做成开关也是错的层级。存在的提示并进顶部那句说明；
 * - **「中文模板」不再长得像设置项**：它不是开关，是「学校模板还不能导入」这个事实，
 *   改成一段说明文字；不再画行线与右侧值；
 * - **文案进 messages**：这一页原来整页写死中文（切英文界面不变），现在按语言取。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { PanelIconButton } from "../../shell/RightPanel";
import { SettingGroup } from "./SettingRow";
import { envRowsOf, type EnvRowTexts } from "./latex-settings-rows.ts";
import type { LatexEnvCheckResult, LatexProbeResult } from "@shared/latex";

/** 「让 agent 修」的结局：false = 没能开好会话（面板要如实说，不再静默丢掉） */
export type RepairOutcome = { ok: boolean };

export function LatexSettings(props: { onRepair: (item: string) => Promise<RepairOutcome> }) {
  const t = useT();
  const [probe, setProbe] = useState<LatexProbeResult | null>(null);
  const [env, setEnv] = useState<LatexEnvCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 正在等会话开好的那一行（按钮转圈 + 禁用，防连点开出一串任务） */
  const [repairing, setRepairing] = useState<string | null>(null);
  const [repairFailed, setRepairFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.latex
      .probe()
      .then((result) => { if (!cancelled) setProbe(result); })
      .catch((err: unknown) => { if (!cancelled) setError(String(err)); });
    void api.latex
      .envCheck()
      .then((result) => { if (!cancelled) setEnv(result); })
      .catch((err: unknown) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, []);

  const texts = t.latexSettings;
  const platform = api.platform === "darwin" ? "macOS" : t.latexSettings.platformWindows;
  const rows = envRowsOf(
    { probe, env },
    {
      latexmk: texts.latexmk,
      synctex: texts.synctex,
      chktex: texts.chktex,
      pandoc: texts.pandoc,
      probing: texts.probing,
      notFound: texts.notFound,
      synctexMissing: texts.synctexMissing,
      chktexMissing: texts.chktexMissing,
      pandocMissing: texts.pandocMissing,
      pandocTooOld: texts.pandocTooOld,
      pandocReady: texts.pandocReady,
    } satisfies EnvRowTexts,
  );

  const repair = (id: string): void => {
    setRepairFailed(null);
    setRepairing(id);
    void props
      .onRepair(id)
      .then((outcome) => { if (!outcome.ok) setRepairFailed(texts.repairFailed); })
      .catch((cause: unknown) => setRepairFailed(String(cause)))
      .finally(() => setRepairing(null));
  };

  return (
    <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
      <SettingGroup label={texts.title}>
        <p className="set-row-desc">{texts.intro(platform)}</p>
      </SettingGroup>

      <SettingGroup label={texts.checks}>
        {error !== null && <p className="set-row-desc" role="alert">{error}</p>}
        {repairFailed !== null && <p className="set-row-error" role="alert">{repairFailed}</p>}
        {/* 自查清单不是「设置行」：它是三列——名字 / 路径（可截断一条长路径）/ 动作。
            用 SettingRow 的两列网格会把路径挤到名字下面、四行变成八行高；这里用
            一个专用三列网格，路径永远单行省略号，扳手永远在同一行的最右。 */}
        {rows.map((row) => (
          <div className="latex-env-row" key={row.id}>
            <span className="latex-env-name">
              <Icon
                name={row.ok ? "circle-check" : "octagon-x"}
                size={14}
                style={{ color: row.ok ? "var(--color-success)" : "var(--color-danger)" }}
              />
              {row.name}
            </span>
            <span className="set-row-note latex-env-detail" title={row.detail}>{row.detail}</span>
            {row.ok ? (
              <span aria-hidden="true" />
            ) : (
              <PanelIconButton
                title={repairing === row.id ? texts.repairing : texts.repair(row.id)}
                disabled={repairing !== null}
                onClick={() => repair(row.id)}
              >
                <Icon name={repairing === row.id ? "loader-circle" : "wrench"} size={14} spin={repairing === row.id} />
              </PanelIconButton>
            )}
          </div>
        ))}
      </SettingGroup>

      <SettingGroup label={texts.config}>
        <div className="latex-env-row">
          <span className="latex-env-name">{texts.latexmkPath}</span>
          <span className="set-row-note latex-env-detail" title={(probe?.ok === true ? probe.latexmk : null) ?? texts.latexmkNotFound}>
            {(probe?.ok === true ? probe.latexmk : null) ?? texts.latexmkNotFound}
          </span>
          <PanelIconButton title={texts.locate} onClick={() => { void api.latex.locate(); }}>
            <Icon name="folder-open" size={14} />
          </PanelIconButton>
        </div>
        <p className="set-row-desc">{texts.cnTemplate}</p>
      </SettingGroup>

      <SettingGroup label={texts.promptTitle}>
        <pre className="set-row-note" style={{
          border: "1px solid var(--color-border-default)",
          borderRadius: 8,
          padding: "var(--space-3)",
          whiteSpace: "pre-wrap",
          fontFamily: "var(--font-family-mono)",
          fontSize: "var(--font-size-xs)",
          color: "var(--color-text-secondary)",
        }}>{api.platform === "darwin" ? texts.promptMac : texts.promptWin}</pre>
      </SettingGroup>
    </div>
  );
}
