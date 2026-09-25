import type { ImportMcpItem } from "@shared/import";
import { Icon } from "../../shell/Icon";
import { isSelectableMcp, mcpOriginLabel, mcpStatusLabel } from "./migration-mcp.ts";

/**
 * Migration 页第 4 段：MCP servers。一个名字一行（同名的多份按来源顺序取第一份，出处都写上）。
 * 导进来一律停用（设计稿裁决 #7）——这一点是这段唯一需要说的话，写在段头下面一行。
 * 配置里带 headers / env 的行尾挂一把钥匙：它们会原样带过来，密钥也在里面。
 */
export function McpSection(props: {
  /** null = 还没扫描 */
  items: readonly ImportMcpItem[] | null;
  home: string;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onSet: (names: readonly string[], on: boolean) => void;
}) {
  const items = props.items ?? [];
  const selectable = items.filter(isSelectableMcp).map((item) => item.name);
  const all = selectable.length > 0 && selectable.every((name) => props.selected.has(name));
  return (
    <section className="mg-sec">
      <div className="mg-sec-head">
        <span className="section-label">4 · MCP servers</span>
        {selectable.length > 0 && (
          <span className="mg-sec-actions">
            <button type="button" className="mg-textbtn" disabled={props.disabled} onClick={() => props.onSet(selectable, !all)}>
              {all ? "Clear all" : "Select all"}
            </button>
          </span>
        )}
      </div>
      {props.items === null ? (
        <p className="mg-placeholder">Scan to list MCP servers. They arrive switched off.</p>
      ) : items.length === 0 ? (
        <p className="mg-placeholder">No MCP servers in the ticked sources.</p>
      ) : (
        <>
          <p className="mg-note mg-note-lead">Added switched off. Turn each on in MCP servers when you need it.</p>
          <div className="mg-list">
            {items.map((item) => {
              const can = isSelectableMcp(item);
              const status = mcpStatusLabel(item);
              return (
                <label key={item.name} className="mg-row mg-row-mcp" data-disabled={!can || undefined}>
                  <input
                    type="checkbox"
                    aria-label={`Import ${item.name}`}
                    checked={can && props.selected.has(item.name)}
                    disabled={props.disabled || !can}
                    onChange={(event) => props.onSet([item.name], event.target.checked)}
                  />
                  <span className="mg-copy">
                    <span className="mg-line1">
                      <span className="mg-name mg-mono">{item.name}</span>
                      <span className="mg-meta">{mcpOriginLabel(item.origins, props.home)}</span>
                    </span>
                    {item.detail !== "" && (
                      <span className="mg-path" title={item.detail}>
                        {item.detail}
                      </span>
                    )}
                  </span>
                  <span className="mg-trail">
                    {status !== null ? (
                      <span className="mg-status">{status}</span>
                    ) : (
                      item.carriesSecrets && (
                        <span
                          className="mg-sub"
                          title={
                            item.transport === "http"
                              ? "Its headers come over as they are, keys included"
                              : "Its environment variables come over as they are, keys included"
                          }
                        >
                          <Icon name="key" size={12} strokeWidth={1.8} />
                          {item.transport === "http" ? "headers" : "env"}
                        </span>
                      )
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
