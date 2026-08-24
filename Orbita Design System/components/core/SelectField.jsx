import React from "react";

export function SelectField({ label, value, options = [], onChange, description, disabled, style, ...rest }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, opacity: disabled ? 0.5 : 1, ...style }}>
      {label ? (
        <span style={{ fontSize: "var(--font-size-body)", fontWeight: "var(--weight-medium)", color: "var(--color-text-primary)" }}>{label}</span>
      ) : null}
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange && onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...rest}
        style={{
          height: 36,
          width: "100%",
          padding: "0 10px",
          border: `1px solid ${focused ? "var(--color-accent)" : "var(--color-border-subtle)"}`,
          borderRadius: "var(--radius-md)",
          background: "var(--color-bg-panel)",
          color: "var(--color-text-primary)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-body)",
          outline: "none",
          boxShadow: focused ? "var(--focus-ring)" : "var(--shadow-border)",
          appearance: "none",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {description ? (
        <small style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-secondary)" }}>{description}</small>
      ) : null}
    </label>
  );
}
