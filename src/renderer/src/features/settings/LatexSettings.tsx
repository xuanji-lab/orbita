/**
 * 设置页「LaTeX 论文」面板 —— preflight 环境自检（用户 2026-11-22 定：
 * 开功能时先把这台机器验一遍，缺什么、怎么修、交给 agent 修时用什么提示词，都在面板里）。
 *
 * checklist 全部走真实探测（latex:probe / latex:env-check），不是写死的状态；
 * 「让 agent 装/修」把修复指令交给会话（App 的 repairLatex），不在面板里自己装。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { PanelIconButton } from "../../shell/RightPanel";
import type { LatexEnvCheckResult, LatexProbeResult } from "@shared/latex";

interface EnvRow {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
}

export function LatexSettings(props: { onRepair: (item: string) => void }) {
  const t = useT();
  const [probe, setProbe] = useState<LatexProbeResult | null>(null);
  const [env, setEnv] = useState<LatexEnvCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const platform = api.platform === "darwin" ? "macOS" : "Windows";
  const rows: EnvRow[] = [
    {
      id: "latexmk",
      name: "latexmk 编译器",
      ok: probe?.ok === true,
      detail: probe === null ? "探测中…" : probe.ok ? `${probe.latexmk ?? ""}（${probe.source ?? ""}）` : probe.message,
    },
    ...(env?.items.map((item) => ({
      id: item.id,
      name: item.id === "synctex" ? "synctex（源码↔PDF 定位）" : item.id === "chktex" ? "chktex（行内检查）" : "pandoc ≥ 3.10.2（导出 Word）",
      ok: item.ok,
      detail: item.detail,
    })) ?? []),
  ];

  return (
    <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
      <section className="set-group">
        <span className="section-label">LaTeX 论文</span>
        <p className="set-row-desc">
          编译、PDF 预览、源码↔PDF 定位、引文核验、导出 Word。开启前已自动验过一遍这台机器（{platform}）。
        </p>
      </section>

      <section className="set-group">
        <span className="section-label">启用检查</span>
        {error !== null && <p className="set-row-desc" role="alert">{error}</p>}
        {rows.map((row) => (
          <div key={row.id} className="set-row" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <Icon name={row.ok ? "circle-check" : "octagon-x"} size={14}
              style={{ color: row.ok ? "var(--color-success)" : "var(--color-danger)" }} />
            <span style={{ minWidth: 220 }}>{row.name}</span>
            <span className="set-row-note" style={{ flex: 1 }} title={row.detail}>{row.detail}</span>
            {!row.ok && (
              <PanelIconButton title={`让 agent 修好 ${row.id}`} onClick={() => props.onRepair(row.id)}>
                <Icon name="wrench" size={14} />
              </PanelIconButton>
            )}
          </div>
        ))}
      </section>

      <section className="set-group">
        <span className="section-label">配置</span>
        <div className="set-row">
          <span style={{ minWidth: 220 }}>latexmk 路径</span>
          <span className="set-row-note" style={{ flex: 1 }}>
            {probe?.ok ? probe.latexmk : "未找到（可显式指定）"}
          </span>
          <PanelIconButton title="指定位置…" onClick={() => { void api.latex.locate(); }}>
            <Icon name="folder-open" size={14} />
          </PanelIconButton>
        </div>
        <div className="set-row">
          <span style={{ minWidth: 220 }}>保存即编译</span>
          <span className="set-row-note" style={{ flex: 1 }}>默认关；可在项目的 ⋮ 菜单里按项目开</span>
        </div>
        <div className="set-row">
          <span style={{ minWidth: 220 }}>中文模板（ctex / xelatex）</span>
          <span className="set-row-note" style={{ flex: 1 }}>未配置 —— 需要你的学校模板</span>
        </div>
      </section>

      <section className="set-group">
        <span className="section-label">交给 agent 修复时用的系统提示词（只读，可按项目覆盖）</span>
        <pre className="set-row-note" style={{
          border: "1px solid var(--color-border-default)", borderRadius: 8,
          padding: "var(--space-3)", whiteSpace: "pre-wrap", fontFamily: "var(--font-family-mono)",
          fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)",
        }}>{platform === "macOS"
          ? "你在帮用户修好 LaTeX 环境（macOS）。先跑平台检查清单：latexmk / synctex / chktex / pandoc。缺 synctex 且 TinyTeX 是旧年度版时，不跑 tlmgr install（跨版本会拒），改为引导装 MacTeX；装之前先问。所有写入限用户确认的目录。"
          : "你在帮用户修好 LaTeX 环境（Windows）。先跑平台检查清单：latexmk / synctex / chktex / pandoc。缺组件时优先 MiKTeX / TeX Live 的用户态安装；装之前先问。所有写入限用户确认的目录。"}
        </pre>
      </section>
    </div>
  );
}
