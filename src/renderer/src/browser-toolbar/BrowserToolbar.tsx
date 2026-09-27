import { useCallback, useEffect, useRef, useState } from "react";
import { effectiveLanguage, type Language, type ThemePreference } from "@shared/settings";
import type { BrowserPageState } from "@shared/browser";
import { api } from "../api.ts";
import { LocaleContext, useT } from "../locale.ts";
import { useTheme } from "../useTheme.ts";
import { Icon } from "../shell/Icon";
import { IconButton } from "../shell/IconButton";

const EMPTY_PAGE: BrowserPageState = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false };

/**
 * 沙盒窗口的工具条：后退 / 前进 / 刷新（加载中变停止）/ 地址栏。
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
      <ToolbarRow />
    </LocaleContext.Provider>
  );
}

function ToolbarRow() {
  const t = useT();
  const [page, setPage] = useState<BrowserPageState>(EMPTY_PAGE);
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
    const offState = api.browser.onState(setPage);
    const offFocus = api.browser.onFocusAddress(focusAddress);
    void api.browser
      .getState()
      .then((state) => {
        if (!alive) return;
        setPage(state);
        // 空白页：此刻用户要做的只有输入网址这一件事
        if (state.url === "") focusAddress();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      offState();
      offFocus();
    };
  }, [focusAddress]);

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
    <div className="browser-toolbar">
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
    </div>
  );
}
