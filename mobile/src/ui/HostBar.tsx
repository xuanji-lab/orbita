import { Pressable, StyleSheet, Text, View } from "react-native";
import { classifyBindAddress } from "../../../src/shared/mobile.ts";
import { copy } from "../copy.ts";
import { clockOf } from "../model/time.ts";
import type { AppState } from "../store/controller.ts";
import { fontSize, lineHeight, space, TOUCH, weight, type Theme } from "../theme/theme.ts";
import { Icon } from "./Icon.tsx";

/** 断线（含正在重连、等下一次重试）：清单与对话都写断线前的旧状态 */
export function isStale(state: AppState): boolean {
  return state.link.kind !== "open";
}

/** 走的是哪条路：地址的类别（与电脑设置页的可绑地址同一口径） */
function netLabel(address: string): string {
  const kind = classifyBindAddress(address);
  if (kind === "tailscale") return copy.host.tailscale;
  if (kind === "private") return copy.host.lan;
  if (kind === "loopback") return copy.host.loopback;
  return copy.host.other;
}

/**
 * 清单顶上的主机条（照设计稿）：laptop 图标 + 电脑名 + 「在线 · 经 Tailscale」；
 * 断线时换成 wifi-off + 「正在重连… · 最后同步 23:38」，图标退三级灰；
 * 宽限窗用完（stopped）时写「电脑没开，点一下再连」，整条可点，点了重新连。
 */
export function HostBar(props: { theme: Theme; state: AppState; topInset: number; onRetry?: () => void }) {
  const { color } = props.theme;
  const { state } = props;
  const stale = isStale(state);
  const stopped = state.link.kind === "stopped";
  const since = state.link.kind === "connecting" || state.link.kind === "waiting" ? state.link.since : null;
  const sub = stopped
    ? copy.host.stopped
    : stale
      ? since === null
        ? copy.host.reconnecting
        : `${copy.host.reconnecting} · ${copy.host.lastSync(clockOf(since))}`
      : `${copy.host.online} · ${netLabel(state.credentials?.address ?? "")}`;
  const bar = (
    <View style={[styles.bar, { paddingTop: props.topInset }]}>
      <View style={styles.glyph}>
        <Icon name={stale ? "wifi-off" : "laptop"} size={16} color={stale ? color.textTertiary : color.textSecondary} />
      </View>
      <View style={styles.main}>
        <Text numberOfLines={1} style={[styles.title, { color: color.textPrimary }]}>
          {state.hostName}
        </Text>
        <Text numberOfLines={1} style={[styles.sub, { color: color.textTertiary }]}>
          {sub}
        </Text>
      </View>
    </View>
  );
  if (stopped && props.onRetry !== undefined) {
    return (
      <Pressable onPress={props.onRetry} accessibilityRole="button" accessibilityLabel={copy.host.stopped}>
        {bar}
      </Pressable>
    );
  }
  return bar;
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: space.s2,
    minHeight: TOUCH + space.s3,
    paddingHorizontal: space.s4,
  },
  glyph: {
    width: space.s5,
    alignItems: "center",
  },
  main: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: fontSize.base,
    lineHeight: lineHeight(fontSize.base),
    fontWeight: weight.semibold,
  },
  sub: {
    fontSize: fontSize.sm,
    lineHeight: lineHeight(fontSize.sm),
  },
});
