import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { fontSize, lineHeight, space, weight, type Theme } from "../theme/theme.ts";
import { Icon, type IconName } from "./Icon.tsx";

/**
 * 空态、加载、出错的一句话（桌面 `PanelEmpty` 的手机版）：行首 14 的图标、一句说现在是什么（sm 次级墨）、
 * 可选的提示（三级墨）、至多一个出口（主墨、半粗、下划线）。靠左，不居中、不放大图标。
 * 加载时图标换成转圈的 loader-circle；出错时整行变红。
 */
export function PanelEmpty(props: {
  theme: Theme;
  icon?: IconName;
  busy?: boolean;
  tone?: "danger";
  hint?: string;
  exit?: { label: string; onPress: () => void };
  children: string;
}) {
  const { color } = props.theme;
  const danger = props.tone === "danger";
  const ink = danger ? color.danger : color.textSecondary;
  return (
    <View style={styles.row} accessibilityRole={danger ? "alert" : undefined}>
      <View style={styles.glyph}>
        {props.busy ? <Spinner color={color.textTertiary} /> : props.icon !== undefined && <Icon name={props.icon} size={14} color={danger ? color.danger : color.textTertiary} />}
      </View>
      <Text style={[styles.text, { color: ink }]}>
        {props.children}
        {props.hint !== undefined && <Text style={{ color: danger ? color.danger : color.textTertiary }}> {props.hint}</Text>}
        {props.exit !== undefined && (
          <>
            {" "}
            <Text
              onPress={props.exit.onPress}
              accessibilityRole="button"
              style={[styles.exit, { color: color.textPrimary }]}
            >
              {props.exit.label}
            </Text>
          </>
        )}
      </Text>
    </View>
  );
}

/** 转圈（只在加载时出现；动效只用来说明「在进行」） */
export function Spinner(props: { color: string; size?: number }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Icon name="loader-circle" size={props.size ?? 14} color={props.color} />
    </Animated.View>
  );
}

/** 文字按钮（出口、「重试」）：触控区补足，字面不变 */
export function TextButton(props: { theme: Theme; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} hitSlop={12} accessibilityRole="button">
      <Text style={[styles.exit, { color: props.theme.color.textPrimary }]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    columnGap: space.s2,
  },
  glyph: {
    width: 14,
    height: lineHeight(fontSize.sm),
    justifyContent: "center",
  },
  text: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: lineHeight(fontSize.sm),
  },
  exit: {
    fontSize: fontSize.sm,
    lineHeight: lineHeight(fontSize.sm),
    fontWeight: weight.semibold,
    textDecorationLine: "underline",
  },
});
