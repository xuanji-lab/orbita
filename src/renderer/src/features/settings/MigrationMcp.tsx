import type { ImportMcpItem } from "@shared/import";
import { Icon } from "../../shell/Icon";
import { isSelectableMcp, mcpOriginLabel, mcpStatusLabel } from "./migration-mcp.ts";
import type { StepState } from "./migration-page.ts";
import { Step, TipBadge, Tipped } from "./MigrationStep.tsx";
import { useT } from "../../locale.ts";

/**
 * Migration 页第 4 步：MCP servers。一个名字一行（同名的多份按来源顺序取第一份，出处都写上）。
 * 导进来一律停用（设计稿裁决 #7）——这是这段唯一需要说的话，收成段头一枚 Off 徽标，整句进悬停。
 * 配置里带 headers / env 的行尾挂一把钥匙：它们会原样带过来，密钥也在里面。
 */
export function McpSection(props: {
  state: StepState;
  /** null = 还没扫描 */
  items: readonly ImportMcpItem[] | null;
  home: string;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onSet: (names: readonly string[], on: boolean) => void;
}) {
  const t = useT();
  const items = props.items ?? [];
  const selectable = items.filter(isSelectableMcp).map((item) => item.name);
  const all = selectable.length > 0 && selectable.every((name) => props.selected.has(name));
  return (
    <Step
      n={4}
      title={t.migration.stepMcp}
      state={props.state}
      summary={
        <TipBadge icon="power" tip={t.migration.addedOffTip} focusable>
          {t.migration.addedOff}
        </TipBadge>
      }
      tools={
        selectable.length > 0 && (
          <span className="mg-tools">
            <button type="button" className="mg-textbtn" disabled={props.disabled} onClick={() => props.onSet(selectable, !all)}>
              {all ? t.migration.clearAll : t.migration.selectAll}
            </button>
          </span>
        )
      }
    >
      {props.items === null ? (
        <p className="mg-caption">
          <Icon name="plug" size={12} strokeWidth={1.8} />
          {t.migration.mcpCaption}
        </p>
      ) : items.length === 0 ? (
        <div className="mg-block mg-empty">
          <Icon name="circle-check" size={15} />
          {t.migration.noMcpInSources}
        </div>
      ) : (
        <div className="mg-block">
          {items.map((item) => {
            const can = isSelectableMcp(item);
            const status = mcpStatusLabel(item, t);
            return (
              <label key={item.name} className="mg-mrow" data-disabled={!can || undefined}>
                <input
                  type="checkbox"
                  aria-label={t.migration.importItem(item.name)}
                  checked={can && props.selected.has(item.name)}
                  disabled={props.disabled || !can}
                  onChange={(event) => props.onSet([item.name], event.target.checked)}
                />
                <span className="mg-gcopy">
                  <span className="mg-gname">
                    <span className="mg-name mg-mono">{item.name}</span>
                    <span className="mg-meta">{mcpOriginLabel(item.origins, props.home, t)}</span>
                  </span>
                  {item.detail !== "" && (
                    <span className="mg-gpath mg-gpath-flush" title={item.detail}>
                      {item.detail}
                    </span>
                  )}
                </span>
                <span className="mg-trail">
                  {status !== null ? (
                    <span className="mg-status">{status}</span>
                  ) : (
                    item.carriesSecrets && (
                      <Tipped
                        className="mg-sub"
                        tip={
                          item.transport === "http"
                            ? t.migration.headersTip
                            : t.migration.envTip
                        }
                      >
                        <Icon name="key" size={12} strokeWidth={1.8} />
                        {item.transport === "http" ? t.migration.headers : t.migration.env}
                      </Tipped>
                    )
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </Step>
  );
}
