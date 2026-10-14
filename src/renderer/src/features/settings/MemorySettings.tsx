import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import type { MemoryEntry } from "@shared/memory";
import type { Workspace } from "@shared/workspace";
import { formatDay } from "./migration-groups.ts";
import { memoryGroups, type MemoryGroup } from "./memory-page.ts";
import { useT } from "../../locale.ts";
import "./memory-view.css";

/**
 * 设置 › 记忆（memory v1 的管理面）：按工作区列出蒸馏出来的条目，可删。
 *
 * 记忆是信任边界（ZCode 原则）：用户要能看见 agent 替他记住了什么，并能让某一条
 * 不存在。删除**不可恢复**（v1 没有回收站），所以行内两段式确认——与 Providers 的
 * 模型删除同款；IPC 回执的 removed=false 是幂等语义（这个 id 不在，含连点两下的
 * 第二次），这里与 true 同样当作已删。
 *
 * 作用域由 renderer 显式给出（workspaceId + cwd，契约 shared/memory.ts）：一页只列
 * **工作区**的记忆，不属于任何工作区的会话记忆 v1 不展示，UI 也不处理 null 域。
 */
export function MemorySettings() {
  const t = useT();
  /** 日期格式只看「今年还是往年」，取一次钉住——删一条不让全页日期换一遍 */
  const [now] = useState(() => Date.now());
  /** null = 首拉中；ready 之后删除只改 entries 映射，不再整体转 loading */
  const [data, setData] = useState<{ workspaces: Workspace[]; entries: Map<string, MemoryEntry[]> } | null>(null);
  const [failed, setFailed] = useState(false);
  /** 正等待二次确认的条目 id；一次只有一条，点别的行的删除键就换成那条 */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** 正在飞的删除（条目 id）——确认键上转圈 */
  const [removing, setRemoving] = useState<string | null>(null);
  /** 删除失败的条目 id：错误留在那一行底下，下一次操作时清掉 */
  const [removeFailed, setRemoveFailed] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    setConfirming(null);
    setData(null);
    void (async () => {
      try {
        const workspaces = await api.workspace.list();
        // 逐工作区问 memory:list。任何一个失败整页转错误态——重试是一次重拉全部，
        // 比「半个页面」好懂（v1 的记忆库是本机小文件，整页重拉的代价可以忽略）
        const entries = new Map<string, MemoryEntry[]>();
        await Promise.all(
          workspaces.map(async (workspace) => {
            const listed = await api.memory.list({ workspaceId: workspace.id, cwd: workspace.path });
            entries.set(workspace.id, listed.entries);
          }),
        );
        setData({ workspaces, entries });
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups: MemoryGroup[] =
    data === null ? [] : memoryGroups(data.workspaces, (workspace) => data.entries.get(workspace.id) ?? []);

  const remove = (group: MemoryGroup, entryId: string) => {
    setRemoving(entryId);
    setRemoveFailed(null);
    void api.memory
      .remove({ workspaceId: group.workspace.id, cwd: group.workspace.path, entryId })
      .then(
        () => {
          // 删掉的那条从列表消失；组被删空时整组消失（memoryGroups 不留空组）
          setData((current) => {
            if (current === null) return current;
            const entries = new Map(current.entries);
            entries.set(
              group.workspace.id,
              (entries.get(group.workspace.id) ?? []).filter((entry) => entry.id !== entryId),
            );
            return { workspaces: current.workspaces, entries };
          });
          setConfirming(null);
        },
        // 失败留着那一行与确认态，用户能立刻再点一次；原因写在那一行底下
        () => setRemoveFailed(entryId),
      )
      .finally(() => setRemoving(null));
  };

  const body =
    data === null ? (
      failed ? (
        <div className="mem-error">
          <Icon name="triangle-alert" size={13} />
          <span>{t.settings.unavailable}</span>
          <button type="button" className="mem-btn text" onClick={load}>
            {t.common.retry}
          </button>
        </div>
      ) : (
        <div className="mem-hint">
          <Icon name="loader-circle" size={13} spin />
          <span>{t.common.loading}</span>
        </div>
      )
    ) : // 没有工作区、或都没有记忆：同一句话——这一页列的单位是条目，空就是空
    groups.length === 0 ? (
      <p className="mem-empty">
        <Icon name="brain-circuit" size={16} />
        <span>{t.settings.memoryEmpty}</span>
      </p>
    ) : (
      groups.map((group) => (
        <section className="mem-group" key={group.workspace.id}>
          <header className="mem-group-head">
            <Icon name="folder" size={13} strokeWidth={1.8} />
            <span className="mem-group-name" title={group.workspace.name}>
              {group.workspace.name}
            </span>
            <span className="mem-group-count">{t.settings.memoryCount(group.entries.length)}</span>
          </header>
          <ul className="mem-list">
            {group.entries.map((entry) => {
              const confirmingThis = confirming === entry.id;
              return (
                <li className="mem-row" key={entry.id} data-confirming={confirmingThis || undefined}>
                  {/* 蒸馏句：最多两行，全文在 title 里 */}
                  <span className="mem-text" title={entry.text}>
                    {entry.text}
                  </span>
                  <span className="mem-row-foot">
                    {entry.keywords.length > 0 && (
                      <span className="mem-kws" aria-label={t.settings.memoryKeywords}>
                        {entry.keywords.map((keyword) => (
                          <span className="mem-kw" key={keyword} title={keyword}>
                            {keyword}
                          </span>
                        ))}
                      </span>
                    )}
                    {/* 日期：行尾血线，右缘钉在行右内边距；删除键浮现时让位 */}
                    <span className="mem-day">{formatDay(entry.timestamp, now)}</span>
                  </span>
                  {removeFailed === entry.id && (
                    <span className="mem-row-error" role="alert">
                      {t.settings.memoryRemoveFailed}
                    </span>
                  )}
                  <span className="mem-acts">
                    {confirmingThis ? (
                      <>
                        {/* 第二段：确认（危险键）与取消。一点就没是破坏性动作的禁忌 */}
                        <button
                          type="button"
                          className="mem-btn danger"
                          aria-label={t.settings.memoryRemoveConfirm}
                          title={t.settings.memoryRemoveTip}
                          onClick={() => remove(group, entry.id)}
                        >
                          <Icon
                            name={removing === entry.id ? "loader-circle" : "trash-2"}
                            size={13}
                            strokeWidth={1.8}
                            spin={removing === entry.id}
                          />
                        </button>
                        <button
                          type="button"
                          className="mem-btn"
                          aria-label={t.common.cancel}
                          title={t.common.cancel}
                          onClick={() => setConfirming(null)}
                        >
                          <Icon name="x" size={13} strokeWidth={1.8} />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="mem-btn danger"
                        aria-label={t.settings.memoryRemove}
                        title={t.settings.memoryRemove}
                        onClick={() => {
                          setRemoveFailed(null);
                          setConfirming(entry.id);
                        }}
                      >
                        <Icon name="trash-2" size={13} strokeWidth={1.8} />
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))
    );

  // 根是 .set-page（720px 列、块间一档间距）——与 Browser / Voice 两页同一惯例
  return <div className="set-page">{body}</div>;
}
