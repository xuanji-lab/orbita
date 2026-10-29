import { useT } from "../locale.ts";

/** 能力面板的两页：Skills（绿）与 MCP（蓝） */
export type AbilityKind = "skills" | "mcp";

/**
 * Skills 与 MCP 合成一个入口后（2026-10-30），面板头的标题换成两个页签。颜色是
 * 第二信号：Skills 绿点、MCP 蓝点，与输入框里两种 token 胶囊同色。「/ + 空格」的选取
 * 态里 Tab 键照旧在两页之间切（App 的 onSwitch），点页签同样切、选取态不退。
 */
export function AbilityTabs(props: { kind: AbilityKind; onKind?: ((kind: AbilityKind) => void) | undefined }) {
  const t = useT();
  const tab = (kind: AbilityKind, label: string) => (
    <button
      type="button"
      role="tab"
      className="cap-tab no-drag ability-tab"
      data-kind={kind}
      aria-selected={props.kind === kind}
      onClick={() => props.onKind?.(kind)}
    >
      <span className="ability-dot" aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <div className="cap-tabs ability-tabs" role="tablist" aria-label={t.rail.abilities}>
      {tab("skills", t.rail.abilitiesSkills)}
      {tab("mcp", t.rail.abilitiesMcp)}
    </div>
  );
}
