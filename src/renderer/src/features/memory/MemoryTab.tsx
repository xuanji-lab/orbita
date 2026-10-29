import { MEMORY_USER_TOKEN, type MemoryEntry, type MemoryScopeSummary } from "@shared/memory";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { MemoryEntryCard } from "./MemoryEntryCard";
import { PendingCard } from "./PendingCard";
import { rememberedTurns } from "./memory-view.ts";
import { useMemoryPending, useMemoryScopes, useMemorySession } from "./useMemory.ts";
import "./memory.css";

/** 开轮时刻的「时:分」（轮头用；跨天的轮少，日期在条目卡的元信息里有）。 */
function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 作用域 token → 显示名。user 层（所有工作区）的名字用界面语言的文案——服务给的
 * name 是写死的中文；工作区 / Home 是专名，照服务给的显示。拿不到就用 userName。
 */
export function scopeNameOf(scopes: readonly MemoryScopeSummary[] | null, token: string, userName: string): string {
  if (token === MEMORY_USER_TOKEN) return userName;
  const scope = scopes?.find((item) => item.token === token);
  return scope === undefined || scope.kind === "user" ? userName : scope.name;
}

/**
 * 审查面板 ›「记忆」页签：这个任务**产出**了什么（2026-10-29 用户裁决：用到的
 * 记忆是输入，去上下文面板；审查只看输出）。
 * - 顶上是和这个任务有关的待确认卡（本作用域 + 所有工作区层）；
 * - 下面按轮倒序列出「记住」的条目，悬停可改 / 别再用 / 删。
 */
export function MemoryTab(props: { sessionId: string | null }) {
  const t = useT();
  const session = useMemorySession(props.sessionId);
  const pending = useMemoryPending(props.sessionId !== null);
  const scopes = useMemoryScopes(props.sessionId !== null);
  const view = session.data;

  if (props.sessionId === null) return <p className="mem-empty">{t.memory.noTask}</p>;
  if (session.error !== null && view === null) {
    return (
      <div className="mem-empty" role="alert">
        <span>{t.memory.loadFailed}</span>
        <button type="button" className="mem-btn" onClick={session.reload}>
          {t.memory.retry}
        </button>
      </div>
    );
  }
  if (view === null) return <p className="mem-empty">{t.common.loading}</p>;

  const relevant = (pending.data?.items ?? []).filter((item) =>
    item.resolution === undefined
      ? item.token === view.token || item.token === MEMORY_USER_TOKEN
      : item.entry.sessionId === view.sessionId,
  );
  const turns = rememberedTurns(view);
  const tokenOf = (entry: MemoryEntry): string => (entry.layer === "user" ? MEMORY_USER_TOKEN : (view.token ?? ""));

  return (
    <div className="mem-tab">
      {relevant.length > 0 && (
        <div className="mem-tab-asks">
          {relevant.map((item) => (
            <PendingCard
              key={`${item.kind}:${item.entry.id}`}
              item={item}
              scopeName={scopeNameOf(scopes.data, item.token, t.memory.scopeUser)}
            />
          ))}
        </div>
      )}
      {view.organizing && (
        <span className="mem-tab-organizing">
          <Icon name="loader-circle" size={12} spin />
          {t.memory.organizing}
        </span>
      )}
      {turns.length === 0 ? (
        <div className="mem-empty">
          <Icon name="brain-circuit" size={16} strokeWidth={1.6} />
          <span>{t.memory.sessionEmpty}</span>
          <span className="hint">{t.memory.sessionEmptyHint}</span>
        </div>
      ) : (
        turns.map((row) => (
          <section key={row.turn} className="mem-tab-turn">
            <header className="mem-tab-turn-head">
              <span>{t.memory.turnHeader(row.turn, clock(row.at))}</span>
              <span className="mem-tab-turn-count">{t.memory.remembered(row.remembered.length)}</span>
            </header>
            <ul className="mem-list">
              {row.remembered.map((entry) => (
                <MemoryEntryCard
                  key={entry.id}
                  view={{ entry, token: tokenOf(entry), sessionTitle: null, quote: null, evolution: [] }}
                  scopeName={entry.layer === "user" ? t.memory.scopeUser : null}
                  showOrigin={false}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
