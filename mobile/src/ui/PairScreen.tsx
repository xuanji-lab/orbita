import { useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../copy.ts";
import type { AppController, AppState, PairProblem } from "../store/controller.ts";
import { fontSize, lineHeight, MONO, radius, space, TOUCH, weight, type Theme } from "../theme/theme.ts";
import type { IconName } from "./Icon.tsx";
import { PanelEmpty } from "./PanelEmpty.tsx";

/**
 * 配对页（照设计稿 android-pair-*）：标题、导语（网络前提）、地址、配对码、提示、整宽的配对键；
 * 出错时键下面一句红字（空态配方），说清楚怎么办。配对码在电脑上 3 分钟内有效。
 * accent 只给「配对」这一颗主操作键。
 */
export function PairScreen(props: { theme: Theme; state: AppState; controller: AppController; initialAddress: string; initialCode: string }) {
  const { theme, state, controller } = props;
  const { color } = theme;
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState(props.initialAddress !== "" ? props.initialAddress : state.pairing.address);
  const [code, setCode] = useState(props.initialCode);
  const busy = state.pairing.busy;
  const digits = code.replace(/\D/g, "");
  const ready = address.trim() !== "" && digits.length === 6 && !busy;
  const problem = busy ? null : state.pairing.problem;
  const label = !busy
    ? copy.pair.connect
    : state.pairing.progress !== null && state.pairing.progress < 100
      ? copy.pair.deriving(state.pairing.progress)
      : copy.pair.connecting;
  const submit = () => {
    if (ready) void controller.pair(address, digits);
  };
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.bgApp }} behavior="height">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.col, { paddingTop: insets.top + space.s8 * 2, paddingBottom: insets.bottom + space.s6 }]}
      >
        <Text style={[styles.title, { color: color.textPrimary }]} accessibilityRole="header">
          {copy.pair.title}
        </Text>
        <Text style={[styles.lead, { color: color.textSecondary }]}>{copy.pair.lead}</Text>
        <View style={styles.field}>
          <Text style={[styles.label, { color: color.textSecondary }]}>{copy.pair.hostLabel}</Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder={copy.pair.hostPlaceholder}
            placeholderTextColor={color.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
            accessibilityLabel={copy.pair.hostLabel}
            style={[
              styles.input,
              {
                color: color.textPrimary,
                backgroundColor: color.bgPanel,
                borderColor: problem === "offline" || problem === "badAddress" || problem === "hijacked" ? color.danger : color.borderSubtle,
              },
            ]}
          />
        </View>
        <View style={styles.field}>
          <Text style={[styles.label, { color: color.textSecondary }]}>{copy.pair.codeLabel}</Text>
          <TextInput
            value={formatCode(code)}
            onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
            placeholder={copy.pair.codePlaceholder}
            placeholderTextColor={color.textTertiary}
            keyboardType="number-pad"
            maxLength={7}
            editable={!busy}
            onSubmitEditing={submit}
            accessibilityLabel={copy.pair.codeLabel}
            style={[
              styles.input,
              styles.code,
              {
                color: color.textPrimary,
                backgroundColor: color.bgPanel,
                borderColor: problem === "expired" || problem === "wrongCode" ? color.danger : color.borderSubtle,
              },
            ]}
          />
          <Text style={[styles.hint, { color: color.textTertiary }]}>{copy.pair.codeWhere}</Text>
        </View>
        <Pressable
          onPress={submit}
          disabled={!ready}
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready, busy }}
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: ready ? (pressed ? color.accentStrong : color.accent) : color.bgMuted },
          ]}
        >
          <Text style={[styles.primaryText, { color: ready ? color.accentFg : color.textTertiary }]}>{label}</Text>
        </Pressable>
        {problem !== null && <ProblemLine theme={theme} problem={problem} address={address.trim()} onRetry={submit} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** 「418207」显示成「418 207」：好读好对，存的仍是 6 位数字 */
function formatCode(code: string): string {
  const digits = code.replace(/\D/g, "");
  return digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
}

const PROBLEM: Readonly<Record<PairProblem, { icon: IconName; text: (address: string) => string; hint: string; retry: boolean }>> = {
  expired: { icon: "key", text: () => copy.pair.expired, hint: copy.pair.expiredHint, retry: false },
  wrongCode: { icon: "key", text: () => copy.pair.wrongCode, hint: copy.pair.wrongCodeHint, retry: false },
  offline: { icon: "wifi-off", text: (address) => copy.pair.offline(address), hint: copy.pair.offlineHint, retry: true },
  hijacked: { icon: "triangle-alert", text: () => copy.pair.hijacked, hint: copy.pair.hijackedHint, retry: false },
  busy: { icon: "clock", text: () => copy.pair.busy, hint: copy.pair.busyHint, retry: false },
  protocol: { icon: "triangle-alert", text: () => copy.pair.protocol, hint: copy.pair.protocolHint, retry: false },
  badAddress: { icon: "triangle-alert", text: () => copy.pair.badAddress, hint: copy.pair.badAddressHint, retry: false },
};

function ProblemLine(props: { theme: Theme; problem: PairProblem; address: string; onRetry: () => void }) {
  const entry = PROBLEM[props.problem];
  return (
    <PanelEmpty
      theme={props.theme}
      tone="danger"
      icon={entry.icon}
      hint={entry.hint}
      {...(entry.retry ? { exit: { label: copy.pair.retry, onPress: props.onRetry } } : {})}
    >
      {entry.text(props.address)}
    </PanelEmpty>
  );
}

const styles = StyleSheet.create({
  col: {
    paddingHorizontal: space.s6,
    rowGap: space.s5,
  },
  title: {
    fontSize: fontSize.xl,
    lineHeight: lineHeight(fontSize.xl, "tight"),
    fontWeight: weight.medium,
  },
  lead: {
    marginTop: -space.s3,
    marginBottom: space.s2,
    fontSize: fontSize.sm,
    lineHeight: lineHeight(fontSize.sm),
  },
  field: {
    rowGap: space.s1_5,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: weight.medium,
  },
  input: {
    height: TOUCH,
    paddingHorizontal: space.s3,
    borderWidth: 1,
    borderRadius: radius.md,
    fontSize: fontSize.base,
  },
  code: {
    fontFamily: MONO,
    letterSpacing: fontSize.base * 0.2,
  },
  hint: {
    fontSize: fontSize.sm,
    lineHeight: lineHeight(fontSize.sm),
  },
  primary: {
    height: TOUCH,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: {
    fontSize: fontSize.base,
    fontWeight: weight.semibold,
  },
});
