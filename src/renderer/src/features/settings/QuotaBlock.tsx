/**
 * 账号额度块 —— 设置页的 provider 卡片（`density="full"`）与（将来）环卡的紧凑档共用。
 *
 * 三个决定：
 *  1. **打开才拉**（decisions 12）：组件挂载 = 用户打开了这张卡。成功后主进程 60s 内复用，
 *     失败退 15s——这里不写任何定时器，也不在背后轮询。
 *  2. **失败保留旧值**：页脚写「多久以前 + 原因分类」，不把整块换成错误页；
 *     从来没成功过时才会走到单行状态（鉴权 / 不支持 / 网络）。
 *  3. **绝不显示 0 冒充「查不到」**：没有快照就明确说「还没有查过」，或说清是哪类失败。
 *
 * 金额与百分比一律 mono + tabular-nums；不到 100% 只有墨色，100% 才 danger（条与数字同时）。
 */
import { useCallback, useEffect, useState } from "react";
import "./quota.css";
import { api } from "../../api";
import { useT } from "../../locale";
import { Icon } from "../../shell/Icon";
import type { QuotaProbe, QuotaResult, QuotaSnapshot } from "@shared/quota";
import {
  checkedLabel,
  creditsBreakdownText,
  failedLabel,
  formatMoney,
  progressOf,
  quotaProblemText,
  snapshotOf,
  usedPercent,
  windowValueText,
} from "./quota-view.ts";

export function QuotaBlock(props: {
  providerId: string;
  probe: QuotaProbe;
  density: "full" | "compact";
  /** 盘上有密钥吗：没有时鉴权失败要说「先填密钥」，而不是「厂商拒绝了」 */
  hasKey?: boolean;
}) {
  const t = useT();
  const compact = props.density === "compact";
  const [result, setResult] = useState<QuotaResult | null>(null);
  // 首帧就当「查过了」在跑：挂载即拉，否则第一帧会闪一下「还没有查过」
  const [busy, setBusy] = useState(true);

  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      try {
        setResult(
          await api.provider.quota(
            refresh ? { providerId: props.providerId, refresh: true } : { providerId: props.providerId },
          ),
        );
      } catch {
        // IPC reject（主进程没注册通道之类）：按网络类失败处理，保留上一次的值
        setResult((prev): QuotaResult => ({
          status: "error",
          reason: "network",
          cached: prev === null || prev.status === "none" ? null : prev.status === "ok" ? prev.snapshot : prev.cached,
        }));
      } finally {
        setBusy(false);
      }
    },
    [props.providerId],
  );

  useEffect(() => {
    // 换了一个 provider：先把上一份值清掉，别让 A 的余额短暂挂在 B 的卡上
    setResult(null);
    void load(false);
  }, [load]);

  if (props.probe === "none") return null;

  const snapshot = snapshotOf(result);
  const failure = result !== null && result.status === "error" ? result.reason : null;
  const now = Date.now();

  /** 鉴权 / 不支持：说清是哪种不通，**不给按钮**让用户反复点（要改的是上面那把钥匙） */
  const problemLine =
    failure === null ? null : (
      <div className="q-line" data-tone={failure === "auth" ? "danger" : undefined}>
        <Icon name={failure === "unsupported" ? "info" : "triangle-alert"} size={14} />
        <span>{quotaProblemText(failure, t, props.hasKey)}</span>
        {failure === "auth" || failure === "unsupported" ? null : (
          <button type="button" className="q-retry" disabled={busy} onClick={() => void load(true)}>
            {t.quota.checkNow}
          </button>
        )}
      </div>
    );

  const body =
    snapshot !== null ? (
      <QuotaFacts snapshot={snapshot} now={now} />
    ) : problemLine !== null ? (
      problemLine
    ) : busy || result === null ? (
      <div className="q-line">
        <Icon name="loader-circle" size={14} spin />
        <span>{t.quota.checking}</span>
      </div>
    ) : (
      <div className="q-line">
        <span>{t.quota.notCheckedYet}</span>
        <button type="button" className="q-retry" onClick={() => void load(true)}>
          {t.quota.checkNow}
        </button>
      </div>
    );

  return (
    <section
      className={`q-block${compact ? " q-compact" : ""}`}
      aria-label={props.probe === "balance" ? t.quota.balance : t.quota.planQuota}
    >
      {compact ? null : (
        <div className="q-head">
          <span className="section-label">
            {props.probe === "balance" ? t.quota.balance : t.quota.planQuota}
          </span>
          <span className="q-head-end">
            <button
              type="button"
              className="q-refresh"
              aria-label={t.quota.refresh}
              title={t.quota.refresh}
              disabled={busy}
              onClick={() => void load(true)}
            >
              <Icon name={busy ? "loader-circle" : "refresh-cw"} size={13} spin={busy} />
            </button>
          </span>
        </div>
      )}
      {body}
      {snapshot !== null && !compact ? (
        <div className="q-foot">
          <Icon name={busy ? "loader-circle" : failure === null ? "clock" : "triangle-alert"} size={12} spin={busy} />
          <span className="q-foot-text">
            {busy
              ? t.quota.checking
              : failure === null
                ? checkedLabel(snapshot.fetchedAt, now, t)
                : failedLabel(failure, snapshot.fetchedAt, now, t)}
          </span>
          {failure !== null && !busy ? (
            <button type="button" className="q-retry" onClick={() => void load(true)}>
              {t.common.retry}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** 快照的事实部分：余额是标量（没有条），套餐窗口是「值行 + 满宽条」 */
function QuotaFacts(props: { snapshot: QuotaSnapshot; now: number }) {
  const t = useT();
  const { snapshot, now } = props;
  const credits = snapshot.credits;
  const breakdown = credits === undefined ? null : creditsBreakdownText(credits, t);
  return (
    <>
      {credits !== undefined && (
        <div className="q-money-row">
          <span className="q-money">
            {credits.unlimited === true ? t.quota.unlimited : formatMoney(credits)}
          </span>
          {breakdown === null ? null : <span className="q-money-sub">{breakdown}</span>}
        </div>
      )}
      {snapshot.windows.length === 0 ? null : (
        <div className="q-rows">
          {snapshot.windows.map((window) => {
            const percent = usedPercent(window);
            return (
              <div className="q-win" key={window.id} data-tone={percent >= 100 ? "spent" : undefined}>
                <div className="q-win-top">
                  <span className="q-label">{window.label}</span>
                  <span className="q-value">{windowValueText(window, now, t)}</span>
                </div>
                <span className="q-bar" aria-hidden>
                  <i style={{ width: `${progressOf(window) * 100}%` }} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
