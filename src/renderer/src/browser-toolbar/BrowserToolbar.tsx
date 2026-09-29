import { useCallback, useEffect, useRef, useState } from "react";
import { effectiveLanguage, type Language, type ThemePreference } from "@shared/settings";
import type { BrowserTabSummary, BrowserWindowState } from "@shared/browser";
import { api } from "../api.ts";
import { LocaleContext, useT } from "../locale.ts";
import { useTheme } from "../useTheme.ts";
import { Icon } from "../shell/Icon";
import { IconButton } from "../shell/IconButton";

const EMPTY_STATE: BrowserWindowState = {
  tabs: [],
  shownTabId: "",
  page: { url: "", title: "", loading: false, canGoBack: false, canGoForward: false },
};

/**
 * 沙盒窗口的工具条：上面一行 tab 条（用户的 tab + 各会话的 agent tab），下面一行
 * 后退 / 前进 / 刷新（加载中变停止）/ 地址栏，作用于正在显示的 tab。
 *
 * 主题与语言：首帧读建窗参数；之后窗口每次获得焦点重读一次设置——用户在主窗口改了
 * 主题，切到浏览器窗口时跟上。不为这件事另开一条推送通道。
 */
export function BrowserToolbar() {
  const [preference, setPreference] = useState<ThemePreference>(api.initialTheme ?? "system");
  const [language, setLanguage] = useState<Language | undefined>(api.initialLanguage ?? undefined);
  useEffect(() => {
    const refresh = (): void => {
      void api.settings
        .get()
        .then((current) => {
          setPreference(current.theme);
          setLanguage(current.language);
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const resolved = useTheme(preference, language);
  return (
    <LocaleContext.Provider value={effectiveLanguage(resolved, language)}>
      <Toolbar />
    </LocaleContext.Provider>
  );
}

function Toolbar() {
  const [state, setState] = useState<BrowserWindowState>(EMPTY_STATE);
  const handoff = state.tabs.find((tab) => tab.id === state.shownTabId)?.handoff;
  return (
    <div className="browser-toolbar" data-handoff={handoff !== undefined || undefined}>
      <TabStrip tabs={state.tabs} shownTabId={state.shownTabId} />
      <NavRow state={state} onState={setState} />
      {handoff !== undefined && <HandoffBar toolCallId={handoff.toolCallId} reason={handoff.reason} />}
    </div>
  );
}

/**
 * 交接提示栏：显示中的 tab 正交给用户时出现在导航行下面（主进程同步把网页往下让，
 * 上下分区不重叠）。用户登录完人就在这里，就地交还——不必切回聊天去找那张卡。
 */
function HandoffBar(props: { toolCallId: string; reason: string }) {
  const t = useT();
  return (
    <div className="browser-handoff" role="status">
      <Icon name="user" size={14} />
      <span className="browser-handoff-text">{t.browser.handoffBar(props.reason)}</span>
      <button
        type="button"
        className="btn-accent browser-handoff-done"
        onClick={() => void api.browser.resolveHandoff(props.toolCallId, "done")}
      >
        <Icon name="check" size={13} /> {t.browser.handoffBarDone}
      </button>
      <button
        type="button"
        className="browser-handoff-cancel"
        onClick={() => void api.browser.resolveHandoff(props.toolCallId, "cancelled")}
      >
        {t.common.cancel}
      </button>
    </div>
  );
}

/**
 * tab 条。用户的 tab 用地球图标 + 页面标题（空白页写「新标签页」），可以有多个；agent tab 用 bot 图标 +
 * 会话标题（后面跟页面）。每个 tab 都能关（用户的最后一个关掉时主进程补一个空白的），末尾「+」新开用户 tab。
 * 状态用图标 + 文字说话，颜色只是第二信号（设计系统）。
 */
function TabStrip(props: { tabs: readonly BrowserTabSummary[]; shownTabId: string }) {
  const t = useT();
  return (
    <div className="browser-tabs" role="tablist" aria-label={t.browser.tabs}>
      {props.tabs.map((tab) => {
        const agent = tab.owner.kind === "agent";
        const session = tab.owner.kind === "agent" ? tab.owner.sessionTitle : "";
        const page = tab.title !== "" ? tab.title : tab.url;
        const shown = tab.id === props.shownTabId;
        return (
          <div key={tab.id} className="browser-tab" data-shown={shown || undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={shown}
              className="browser-tab-main"
              title={agent ? t.browser.agentTabTip(session, page) : t.browser.yourTabTip(page)}
              onClick={() => void api.browser.selectTab(tab.id)}
            >
              <Icon
                name={tab.loading ? "loader-circle" : agent ? "bot" : "globe"}
                size={12}
                spin={tab.loading}
              />
              {agent ? (
                <>
                  <span className="browser-tab-label">{t.browser.agentTab(session)}</span>
                  {page !== "" && <span className="browser-tab-page">{page}</span>}
                </>
              ) : (
                <span className="browser-tab-title">{page !== "" ? page : t.browser.newTab}</span>
              )}
            </button>
            <IconButton label={t.browser.closeTab} size={20} onClick={() => void api.browser.closeTab(tab.id)}>
              <Icon name="x" size={11} />
            </IconButton>
          </div>
        );
      })}
      <span className="browser-tab-new">
        <IconButton label={t.browser.newTab} size={24} onClick={() => void api.browser.newTab()}>
          <Icon name="plus" size={13} />
        </IconButton>
      </span>
    </div>
  );
}

function NavRow(props: { state: BrowserWindowState; onState: (state: BrowserWindowState) => void }) {
  const t = useT();
  const { onState } = props;
  const page = props.state.page;
  /** null = 没在编辑，地址栏显示页面真实地址；字符串 = 用户正在打的字 */
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const focusAddress = useCallback(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  useEffect(() => {
    let alive = true;
    const offState = api.browser.onState(onState);
    const offFocus = api.browser.onFocusAddress(focusAddress);
    void api.browser
      .getState()
      .then((state) => {
        if (!alive) return;
        onState(state);
        // 空白页：此刻用户要做的只有输入网址这一件事
        if (state.page.url === "") focusAddress();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      offState();
      offFocus();
    };
  }, [focusAddress, onState]);

  // 切了 tab：放弃正在打的字（它属于上一个 tab），地址栏回到新 tab 的真实地址
  useEffect(() => {
    setDraft(null);
    setInvalid(false);
  }, [props.state.shownTabId]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const input = draft ?? page.url;
    void api.browser
      .navigate(input)
      .then((result) => {
        if (!result.ok) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        setDraft(null);
        inputRef.current?.blur();
      })
      .catch(() => setInvalid(true));
  };

  return (
    <div className="browser-nav">
      <IconButton label={t.browser.back} size={28} disabled={!page.canGoBack} onClick={() => void api.browser.back()}>
        <Icon name="arrow-left" size={15} />
      </IconButton>
      <IconButton
        label={t.browser.forward}
        size={28}
        disabled={!page.canGoForward}
        onClick={() => void api.browser.forward()}
      >
        <Icon name="arrow-right" size={15} />
      </IconButton>
      <IconButton
        label={page.loading ? t.browser.stop : t.browser.reload}
        size={28}
        disabled={page.url === "" && !page.loading}
        onClick={() => void api.browser.reloadOrStop()}
      >
        <Icon name={page.loading ? "x" : "refresh-cw"} size={15} />
      </IconButton>
      <form className="browser-toolbar-form" onSubmit={submit}>
        <span className="browser-address-icon" aria-hidden="true">
          <Icon name={page.loading ? "loader-circle" : "globe"} size={13} spin={page.loading} />
        </span>
        <input
          ref={inputRef}
          className="text-field browser-address"
          aria-label={t.browser.address}
          aria-invalid={invalid}
          aria-describedby={invalid ? "browser-address-error" : undefined}
          placeholder={t.browser.addressPlaceholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={draft ?? page.url}
          onFocus={(event) => {
            setDraft(page.url);
            event.currentTarget.select();
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onBlur={() => {
            setDraft(null);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setDraft(null);
            setInvalid(false);
            event.currentTarget.blur();
          }}
        />
        {invalid && (
          <span id="browser-address-error" role="alert" className="browser-toolbar-error">
            <Icon name="triangle-alert" size={12} />
            {t.browser.notAnAddress}
          </span>
        )}
      </form>
      {/* 链接默认进内置浏览器（2026-09-29 裁决），想用系统浏览器就从这里交出去 */}
      <IconButton
        label={t.browser.openExternal}
        size={28}
        disabled={page.url === ""}
        onClick={() => void api.browser.openExternal().catch(() => undefined)}
      >
        <Icon name="external-link" size={15} />
      </IconButton>
    </div>
  );
}
