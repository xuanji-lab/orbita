import React from "react";

const labelStyle = { fontSize: "var(--font-size-body)", fontWeight: "var(--weight-medium)", color: "var(--color-text-primary)" };
const descStyle = { fontSize: "var(--font-size-caption)", color: "var(--color-text-secondary)" };

const fieldStyle = (focused) => ({
  height: 36,
  width: "100%",
  padding: "4px 12px",
  border: `1px solid ${focused ? "var(--color-accent)" : "var(--color-border-subtle)"}`,
  borderRadius: "var(--radius-md)",
  background: "var(--color-bg-panel)",
  color: "var(--color-text-primary)",
  fontFamily: "var(--font-family-base)",
  fontSize: "var(--font-size-body)",
  outline: "none",
  boxShadow: focused ? "var(--focus-ring)" : "var(--shadow-border)",
  transition: "var(--transition-hover)",
});

export function TextField({ label, value, onChange, description, placeholder, disabled, type = "text", style, ...rest }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, opacity: disabled ? 0.5 : 1, ...style }}>
      {label ? <span style={labelStyle}>{label}</span> : null}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange && onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...rest}
        style={fieldStyle(focused)}
      />
      {description ? <small style={descStyle}>{description}</small> : null}
    </label>
  );
}
