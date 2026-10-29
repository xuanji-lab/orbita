import { MEMORY_USER_TOKEN, type MemoryEntry } from "@shared/memory";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { MemoryEntryCard } from "./MemoryEntryCard";
import { rememberedTurns } from "./memory-view.ts";
import { useMemorySession } from "./useMemory.ts";
import "./memory.css";

/** 开轮时刻的「时:分」（轮头用；跨天的轮少，日期在条目卡的元信息里有）。 */
function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 审查面板 ›「记忆」页签：这个任务**记住了什么**——按轮倒序，悬停可改 / 别再用 / 删。
 * 用到的记忆是输入，去上下文面板；待确认与「整理中」不在这里出现（用户 2026-10-29：
 * 「我只需要知道，有在记录记忆，记得对……其他的我不需要感知到」），待确认只在记忆库。
 */
export function MemoryTab(props: { sessionId: string | null }) {
  const t = useT();
  const session = useMemorySession(props.sessionId);
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

  const turns = rememberedTurns(view);
  const tokenOf = (entry: MemoryEntry): string => (entry.layer === "user" ? MEMORY_USER_TOKEN : (view.token ?? ""));

  return (
    <div className="mem-tab">
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
