/**
 * 设置 › 手机（2026-11-25，手机端「看与回」第一刀）：手机配对到这台电脑之前，电脑这头要做的三件事——
 * 开监听（选地址与端口）、生成配对码、管已配对的设备。手机设计稿上写的「地址和配对码都在电脑的
 * 设置 › 手机 里」指的就是这一页。
 *
 * 数据全走 `api.mobile`（契约在 src/shared/mobile.ts）：
 * - 开关 / 地址 / 端口改完，主进程回最新的 MobileSettings，页面不另拉；
 * - 设备的「此刻在线」没有推送通道，页面开着时每 3 秒拉一次 devices()（离开就停）；
 * - 主进程给的 message / hostKeyNotice 是原话，如实照显示——地址不在本机时不静默换别的；
 * - 配对码只在这一页上看得到：离开这一页就作废它（offerCancel），不留一组没人看着的码。
 *
 * 版式照现有设置页（`.set-page` 两栏、`SettingGroup` / `SettingRow`），控件照 SettingControls；
 * 撤销的行内二次确认照插件详情「卸载…」那一套（`.pl-ic` + `.pl-btn.solid-danger`），
 * 告示照插件页的 `.pl-note`，空态 / 加载 / 读失败照 `PanelEmpty`。
 */
import { useEffect, useRef, useState } from "react";
import { MOBILE_DEFAULT_PORT, type MobileBindCandidate, type MobileDevice, type MobileOffer, type MobileSettings } from "@shared/mobile";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { relativeTime } from "../../shell/relative-time.ts";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { formatDay } from "./migration-groups.ts";
import {
  bindView,
  formatCountdown,
  groupPairingCode,
  newlyPaired,
  offerSecondsLeft,
  parsePortInput,
  sortDevices,
} from "./mobile-settings.ts";
import { SettingGroup, SettingRow } from "./SettingRow";
import { SelectButton, Switch } from "./SettingControls";

/** 设备在线状态的轮询间隔：没有推送通道，3 秒是「刚连上 / 刚断开」不让人等太久的上限 */
const DEVICE_POLL_MS = 3_000;

type Load<T> = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; value: T };

export function MobileSettingsPage() {
  const t = useT();
  const copy = t.settings.mobile;
  const [settings, setSettings] = useState<Load<MobileSettings>>({ kind: "loading" });
  const [devices, setDevices] = useState<Load<MobileDevice[]>>({ kind: "loading" });
  /** 正在改开关 / 地址：控件先锁住，主进程回了真状态再放开 */
  const [busy, setBusy] = useState<"enable" | "bind" | null>(null);
  /** 改开关 / 地址时 IPC 本身抛的错（主进程校验不过等）；监听失败的原因在 settings.message 里 */
  const [actionError, setActionError] = useState<string | null>(null);

  const loadSettings = () =>
    api.mobile
      .get()
      .then((value) => setSettings({ kind: "ready", value }))
      .catch((cause: unknown) => setSettings({ kind: "error", message: ipcErrorText(cause) }));
  const loadDevices = () =>
    api.mobile
      .devices()
      .then((value) => setDevices({ kind: "ready", value }))
      .catch((cause: unknown) => setDevices({ kind: "error", message: ipcErrorText(cause) }));

  useEffect(() => {
    void loadSettings();
    void loadDevices();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadDevices();
      void loadSettings();
    }, DEVICE_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const apply = (kind: "enable" | "bind", call: () => Promise<MobileSettings>) => {
    setBusy(kind);
    setActionError(null);
    void call()
      .then((value) => setSettings({ kind: "ready", value }))
      .catch((cause: unknown) => setActionError(ipcErrorText(cause)))
      .finally(() => setBusy(null));
  };

  if (settings.kind === "loading") {
    return (
      <div className="set-page">
        <PanelEmpty busy className="mobile-page-empty">
          {copy.loading}
        </PanelEmpty>
      </div>
    );
  }
  if (settings.kind === "error") {
    return (
      <div className="set-page">
        <PanelEmpty
          tone="danger"
          className="mobile-page-empty"
          hint={settings.message}
          exit={{ label: t.common.retry, onClick: () => void loadSettings() }}
        >
          {copy.loadFailed}
        </PanelEmpty>
      </div>
    );
  }

  const state = settings.value;
  const deviceList = devices.kind === "ready" ? devices.value : [];
  return (
    <div className="set-page">
      <SettingGroup label={copy.connectGroup}>
        <SettingRow
          name={copy.enable}
          info={copy.enableInfo}
          note={<ListenStatus settings={state} busy={busy === "enable"} actionError={actionError} />}
        >
          <Switch
            label={copy.enable}
            checked={state.enabled}
            disabled={busy !== null}
            onChange={(next) => apply("enable", () => api.mobile.setEnabled(next))}
          />
        </SettingRow>
        {/* 关着也能先选地址：开关一开就监听在选好的那张网卡上，不先落到默认的第一个候选上 */}
        <AddressRow
          settings={state}
          busy={busy !== null}
          onBind={(address, port) => apply("bind", () => api.mobile.setBind({ address, port }))}
        />
      </SettingGroup>
      <SettingGroup label={copy.pairGroup}>
        <PairRow
          enabled={state.enabled}
          listening={state.enabled && state.listening}
          deviceIds={devices.kind === "ready" ? new Set(deviceList.map((device) => device.id)) : null}
          devices={deviceList}
          onRefresh={() => void loadDevices()}
        />
      </SettingGroup>
      <SettingGroup label={copy.devicesGroup}>
        <SettingRow name={copy.devices} info={copy.devicesInfo}>
          {devices.kind === "ready" && devices.value.length > 0 && (
            <span className="set-row-hint mobile-count">{copy.devicesCount(devices.value.length)}</span>
          )}
        </SettingRow>
        {/* 主机密钥丢过：设备被清空的告示放在设备清单上方——它说的就是这里为什么空了 */}
        {state.hostKeyNotice !== null && (
          <div className="pl-note warn mobile-notice" role="alert">
            <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
            <span>{state.hostKeyNotice}</span>
          </div>
        )}
        {devices.kind === "loading" ? (
          <PanelEmpty busy className="mobile-list-empty">
            {t.common.loading}
          </PanelEmpty>
        ) : devices.kind === "error" ? (
          <PanelEmpty
            tone="danger"
            className="mobile-list-empty"
            hint={devices.message}
            exit={{ label: t.common.retry, onClick: () => void loadDevices() }}
          >
            {copy.devicesFailed}
          </PanelEmpty>
        ) : devices.value.length === 0 ? (
          <PanelEmpty icon={FEATURE_ICON.mobile} className="mobile-list-empty" hint={copy.devicesEmptyHint}>
            {copy.devicesEmpty}
          </PanelEmpty>
        ) : (
          <DeviceList devices={devices.value} onChanged={(value) => setDevices({ kind: "ready", value })} />
        )}
      </SettingGroup>
    </div>
  );
}

/** 开关下面那一行：在开 → 监听中（地址:端口）→ 没能监听的原因（主进程原话，红） */
function ListenStatus(props: { settings: MobileSettings; busy: boolean; actionError: string | null }) {
  const copy = useT().settings.mobile;
  const { settings } = props;
  if (props.busy) {
    return (
      <span className="set-row-hint">
        <Icon name="loader-circle" size={12} spin /> {copy.starting}
      </span>
    );
  }
  const reason = props.actionError ?? settings.message;
  // 地址不在本机的那句由地址行说（它离「换一个地址」更近），这里不重复
  const view = bindView(settings);
  if (reason !== null && !(view?.missing === true && settings.enabled)) {
    return (
      <span className="set-row-error mobile-reason" role="alert">
        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
        <span>{reason}</span>
      </span>
    );
  }
  if (settings.enabled && settings.listening && view !== null) {
    return (
      <span className="set-row-note" role="status">
        <Icon name="circle-check" size={12} strokeWidth={1.8} />
        <span>
          {copy.listening} · <span className="mobile-mono">{`${view.address}:${view.port}`}</span>
        </span>
      </span>
    );
  }
  if (settings.enabled && !settings.listening && view?.missing !== true) {
    return <span className="set-row-hint">{copy.notListening}</span>;
  }
  return null;
}

/**
 * 地址与端口：地址从主进程现算的候选里选（Tailscale → 局域网 → 回环，主进程排好序）；
 * 端口是个窄输入框，回车或离开时才提交。选局域网地址写明谁都连得到这个端口；地址此刻不在本机
 * 如实说、留在原地址上，等用户自己换。
 */
function AddressRow(props: { settings: MobileSettings; busy: boolean; onBind: (address: string, port: number) => void }) {
  const t = useT();
  const copy = t.settings.mobile;
  const view = bindView(props.settings);
  const [portText, setPortText] = useState(String(view?.port ?? MOBILE_DEFAULT_PORT));
  const [portInvalid, setPortInvalid] = useState(false);
  // 主进程回来的端口变了（别处改的、或提交成功）：输入框跟上
  const committedPort = view?.port ?? null;
  useEffect(() => {
    if (committedPort !== null) setPortText(String(committedPort));
  }, [committedPort]);

  const kindLabel = (candidate: Pick<MobileBindCandidate, "kind">) => copy.kind[candidate.kind];
  const items: MenuItem[] = props.settings.candidates.map((candidate) => ({
    id: candidate.address,
    label: candidate.address,
    hint: `${kindLabel(candidate)} · ${candidate.interfaceName}`,
    checked: candidate.address === view?.address,
    onSelect: () => props.onBind(candidate.address, parsePortInput(portText) ?? view?.port ?? MOBILE_DEFAULT_PORT),
  }));

  const commitPort = () => {
    const port = parsePortInput(portText);
    if (port === null) {
      setPortInvalid(true);
      return;
    }
    setPortInvalid(false);
    if (view !== null && port !== view.port) props.onBind(view.address, port);
  };

  const note =
    view === null ? (
      props.settings.candidates.length === 0 ? (
        <span className="set-row-error" role="alert">
          {copy.noCandidates}
        </span>
      ) : undefined
    ) : view.missing ? (
      <span className="set-row-error mobile-reason" role="alert">
        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
        <span>{copy.addressMissing(view.address)}</span>
      </span>
    ) : view.kind === "private" ? (
      <span className="set-row-note mobile-reason" role="status">
        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
        <span>{copy.lanWarning}</span>
      </span>
    ) : view.kind === "loopback" ? (
      <span className="set-row-hint">{copy.loopbackNote}</span>
    ) : undefined;

  return (
    <SettingRow
      name={copy.address}
      info={copy.addressInfo}
      note={
        <>
          {note}
          {portInvalid && (
            <span className="set-row-error" role="alert">
              {copy.portInvalid}
            </span>
          )}
        </>
      }
    >
      <span className="set-inline mobile-bind">
        <Menu
          items={items}
          searchable={items.length > 8}
          trigger={({ open, toggle }) => (
            <SelectButton open={open} onClick={toggle} title={copy.addressPick} disabled={props.busy || items.length === 0}>
              {view === null ? (
                copy.addressPick
              ) : (
                <>
                  <span className="mobile-mono">{view.address}</span>
                  {view.kind !== null && <span className="mobile-bind-kind"> · {copy.kind[view.kind]}</span>}
                </>
              )}
            </SelectButton>
          )}
        />
        <span className="mobile-port-sep" aria-hidden="true">
          :
        </span>
        <input
          className="text-field mobile-port"
          inputMode="numeric"
          aria-label={copy.port}
          title={copy.port}
          value={portText}
          disabled={props.busy}
          aria-invalid={portInvalid}
          onChange={(event) => {
            setPortText(event.target.value);
            setPortInvalid(false);
          }}
          onBlur={commitPort}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitPort();
            if (event.key === "Escape" && view !== null) {
              setPortText(String(view.port));
              setPortInvalid(false);
            }
          }}
        />
      </span>
    </SettingRow>
  );
}

/**
 * 配对：一个主按钮「生成配对码」；有码时行底铺开一块——码、倒计时、地址，「换一组」「收起」。
 * 过期后码划掉、写「已过期」，出口是「再生成一组」。这期间冒出新设备 = 配上了：收起码，写一句「已配上」。
 * 离开这一页（卸载）时作废还在有效期里的码。
 */
function PairRow(props: {
  enabled: boolean;
  listening: boolean;
  /** 设备列表还没读到时是 null（那时不判断「配上了」） */
  deviceIds: ReadonlySet<string> | null;
  devices: readonly MobileDevice[];
  /** 生成码之后拉一次设备列表，把「生成前已有的设备」钉准 */
  onRefresh: () => void;
}) {
  const t = useT();
  const copy = t.settings.mobile;
  const [offer, setOffer] = useState<MobileOffer | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedName, setPairedName] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** 生成这组码时已有的设备：之后多出来的就是用这组码配上的 */
  const baseline = useRef<ReadonlySet<string> | null>(null);
  const live = useRef<MobileOffer | null>(null);
  live.current = offer;

  // 有码时每秒走一次倒计时
  useEffect(() => {
    if (offer === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [offer]);

  // 离开这一页：还在有效期里的码作废
  useEffect(
    () => () => {
      const current = live.current;
      if (current !== null && current.expiresAt > Date.now()) void api.mobile.offerCancel().catch(() => undefined);
    },
    [],
  );

  // 监听停了（关了开关 / 地址掉了）：主进程已作废配对簿，码收起
  useEffect(() => {
    if (!props.listening) setOffer(null);
  }, [props.listening]);

  // 有码期间冒出新设备：配上了
  useEffect(() => {
    if (offer === null || baseline.current === null) return;
    const paired = newlyPaired(baseline.current, props.devices);
    if (paired !== null) {
      setPairedName(paired.name);
      setOffer(null);
    }
  }, [props.devices, offer]);

  const create = () => {
    setCreating(true);
    setError(null);
    setPairedName(null);
    baseline.current = props.deviceIds;
    void api.mobile
      .offerCreate()
      .then((next) => {
        setOffer(next);
        props.onRefresh();
      })
      .catch((cause: unknown) => setError(ipcErrorText(cause)))
      .finally(() => setCreating(false));
  };
  const close = () => {
    setOffer(null);
    void api.mobile.offerCancel().catch(() => undefined);
  };

  const secondsLeft = offer === null ? 0 : offerSecondsLeft(offer.expiresAt, now);
  const expired = offer !== null && secondsLeft === 0;

  const note =
    error !== null ? (
      <span className="set-row-error mobile-reason" role="alert">
        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
        <span>{copy.pairFailed(error)}</span>
      </span>
    ) : pairedName !== null ? (
      <span className="set-row-note" role="status">
        <Icon name="circle-check" size={12} strokeWidth={1.8} />
        <span className="mobile-ellipsis">{copy.pairDone(pairedName)}</span>
      </span>
    ) : !props.listening ? (
      <span className="set-row-hint">{props.enabled ? copy.pairNeedsListening : copy.pairNeedsOn}</span>
    ) : undefined;

  return (
    <SettingRow
      name={copy.pair}
      info={copy.pairInfo}
      note={note}
      below={
        offer !== null && (
          <div className="mobile-offer" data-expired={expired ? "" : undefined} aria-live="polite">
            <div className="mobile-offer-main">
              <span className="mobile-offer-label">{copy.pairCode}</span>
              <span className="mobile-offer-code" aria-label={expired ? copy.pairExpired : copy.pairCode}>
                {groupPairingCode(offer.code)}
              </span>
              <span className="mobile-offer-meta">
                {expired ? (
                  <span className="mobile-offer-expired">{copy.pairExpired}</span>
                ) : (
                  <span>{copy.pairExpiresIn(formatCountdown(secondsLeft))}</span>
                )}
                <span>
                  {copy.pairAddress} <span className="mobile-mono">{`${offer.address}:${offer.port}`}</span>
                </span>
              </span>
            </div>
            <div className="mobile-offer-acts">
              <button type="button" className={expired ? "pl-btn btn-accent" : "pl-btn"} disabled={creating} onClick={create}>
                <Icon name="refresh-cw" size={13} strokeWidth={1.8} />
                {creating ? copy.pairCreating : expired ? copy.pairAgain : copy.pairRenew}
              </button>
              <button type="button" className="pl-btn" onClick={close}>
                {copy.pairClose}
              </button>
            </div>
          </div>
        )
      }
    >
      {offer === null && (
        <button
          type="button"
          className="pl-btn btn-accent"
          disabled={!props.listening || creating}
          title={props.listening ? undefined : props.enabled ? copy.pairNeedsListening : copy.pairNeedsOn}
          onClick={create}
        >
          {creating ? copy.pairCreating : copy.pairCreate}
        </button>
      )}
    </SettingRow>
  );
}

/** 已配对设备：一行一台，在线的在前；「撤销…」就地换成红底确认条（插件详情「卸载…」同一套） */
function DeviceList(props: { devices: readonly MobileDevice[]; onChanged: (devices: MobileDevice[]) => void }) {
  const t = useT();
  const copy = t.settings.mobile;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const now = Date.now();

  useEffect(() => {
    if (confirming !== null) cancelRef.current?.focus();
  }, [confirming]);

  const revoke = (device: MobileDevice) => {
    setRevoking(true);
    setError(null);
    void api.mobile
      .revoke(device.id)
      .then((next) => props.onChanged(next))
      .catch((cause: unknown) => setError(copy.revokeFailed(ipcErrorText(cause))))
      .finally(() => {
        setRevoking(false);
        setConfirming(null);
      });
  };

  return (
    <div className="mobile-devices-wrap">
      {error !== null && (
        <div className="pl-note danger" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <span>{error}</span>
        </div>
      )}
      <ul className="mobile-devices" aria-label={copy.devices}>
        {sortDevices(props.devices).map((device) => {
          const status = device.connected
            ? copy.online
            : device.lastSeenAt !== null
              ? copy.lastSeen(relativeTime(device.lastSeenAt, t))
              : copy.neverSeen;
          return (
            <li key={device.id} className="mobile-device" data-online={device.connected ? "" : undefined}>
              {confirming === device.id ? (
                <div
                  className="pl-ic mobile-device-confirm"
                  role="alertdialog"
                  aria-label={copy.revokeAsk(device.name)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setConfirming(null);
                    }
                  }}
                >
                  <div className="pl-ic-bar">
                    <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
                    <span className="pl-ic-ask">{copy.revokeAsk(device.name)}</span>
                    <button type="button" className="pl-btn solid-danger" disabled={revoking} onClick={() => revoke(device)}>
                      {revoking ? copy.revoking : copy.revokeAction}
                    </button>
                    <button type="button" className="pl-btn" ref={cancelRef} disabled={revoking} onClick={() => setConfirming(null)}>
                      {t.common.cancel}
                    </button>
                  </div>
                  <p className="pl-ic-hint">{copy.revokeHint}</p>
                </div>
              ) : (
                <>
                  <Icon name={FEATURE_ICON.mobile} size={14} strokeWidth={1.8} className="mobile-device-glyph" />
                  <span className="mobile-device-head">
                    <span className="mobile-device-name" title={device.name}>
                      {device.name}
                    </span>
                    <span className="mobile-device-meta">
                      <span className="mobile-device-status">{status}</span>
                      {" · "}
                      {copy.pairedOn(formatDay(device.pairedAt, now))}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="mg-textbtn row-trailing mobile-device-revoke"
                    disabled={confirming !== null}
                    onClick={() => {
                      setError(null);
                      setConfirming(device.id);
                    }}
                  >
                    {copy.revoke}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
