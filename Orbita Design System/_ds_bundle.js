/* @ds-bundle: {"format":4,"namespace":"OrbitaDesignSystem_994749","components":[{"name":"AssistantText","sourcePath":"components/chat/AssistantText.jsx"},{"name":"RespondingIndicator","sourcePath":"components/chat/RespondingIndicator.jsx"},{"name":"ThinkingCard","sourcePath":"components/chat/ThinkingCard.jsx"},{"name":"ToolCard","sourcePath":"components/chat/ToolCard.jsx"},{"name":"UserBubble","sourcePath":"components/chat/UserBubble.jsx"},{"name":"Composer","sourcePath":"components/composer/Composer.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Modal","sourcePath":"components/core/Modal.jsx"},{"name":"SelectField","sourcePath":"components/core/SelectField.jsx"},{"name":"TextField","sourcePath":"components/core/TextField.jsx"},{"name":"BrandLockup","sourcePath":"components/navigation/BrandLockup.jsx"},{"name":"ModeChip","sourcePath":"components/navigation/ModeChip.jsx"},{"name":"RailButton","sourcePath":"components/navigation/RailButton.jsx"},{"name":"SessionRow","sourcePath":"components/navigation/SessionRow.jsx"},{"name":"Chip","sourcePath":"components/surfaces/Chip.jsx"},{"name":"GlassCard","sourcePath":"components/surfaces/GlassCard.jsx"},{"name":"SessionCard","sourcePath":"components/surfaces/SessionCard.jsx"}],"sourceHashes":{"components/chat/AssistantText.jsx":"8c66f3597bdf","components/chat/RespondingIndicator.jsx":"572aa53fe39b","components/chat/ThinkingCard.jsx":"97c32cb4e853","components/chat/ToolCard.jsx":"7cc251be32e0","components/chat/UserBubble.jsx":"fbce09bd3cb2","components/composer/Composer.jsx":"24bbc85e1ece","components/core/Badge.jsx":"68bdbb78ae05","components/core/Button.jsx":"7daa305e8091","components/core/Icon.jsx":"78f215e05db4","components/core/IconButton.jsx":"0c86b6d3f9bc","components/core/Modal.jsx":"f26e12139286","components/core/SelectField.jsx":"e337596a8d2a","components/core/TextField.jsx":"35ea5fdc2ba6","components/navigation/BrandLockup.jsx":"eef0794ceb21","components/navigation/ModeChip.jsx":"4aa5bae0415c","components/navigation/RailButton.jsx":"61fbef5ef1c4","components/navigation/SessionRow.jsx":"5da600f2e5f4","components/surfaces/Chip.jsx":"fb7d50186c60","components/surfaces/GlassCard.jsx":"108cc55df9aa","components/surfaces/SessionCard.jsx":"d22093960641","ui_kits/orbita-desktop/App.jsx":"d387d0581367","ui_kits/orbita-desktop/ChatScreen.jsx":"07bacf8ece9c","ui_kits/orbita-desktop/Drawer.jsx":"cb0452cdd83e","ui_kits/orbita-desktop/HomeScreen.jsx":"781083e23119","ui_kits/orbita-desktop/SettingsDialog.jsx":"a92f31ca8678","ui_kits/orbita-desktop/Sidebar.jsx":"e212f5f1f044","ui_kits/orbita-desktop/data.js":"3518f15e80d1"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.OrbitaDesignSystem_994749 = window.OrbitaDesignSystem_994749 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/chat/AssistantText.jsx
try { (() => {
/** Assistant reply: flat markdown-ish prose, no bubble, full content width. */
function AssistantText({
  children,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%",
      maxWidth: "100%",
      minWidth: 0,
      color: "var(--color-text-primary)",
      fontSize: "var(--font-size-chat)",
      lineHeight: "var(--line-height-chat)",
      textWrap: "pretty",
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { AssistantText });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chat/AssistantText.jsx", error: String((e && e.message) || e) }); }

// components/chat/RespondingIndicator.jsx
try { (() => {
/** Streaming status line under the last turn. */
function RespondingIndicator({
  label = "Responding",
  tone = "running",
  style
}) {
  const color = tone === "error" ? "var(--color-danger)" : tone === "waiting" ? "var(--color-text-secondary)" : "var(--color-text-secondary)";
  const dot = tone === "error" ? "var(--color-danger)" : tone === "waiting" ? "var(--color-text-tertiary)" : "var(--color-warning)";
  return /*#__PURE__*/React.createElement("p", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: "var(--space-2)",
      margin: 0,
      padding: "8px 12px",
      minHeight: 36,
      boxSizing: "border-box",
      border: "1px solid var(--color-border-subtle)",
      borderRadius: "var(--radius-md)",
      background: "var(--color-bg-muted)",
      color,
      fontSize: "var(--font-size-control)",
      transition: "border-color 0.25s ease, background-color 0.25s ease, color 0.25s ease",
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: "var(--radius-pill)",
      border: `2px solid color-mix(in srgb, ${dot} 30%, transparent)`,
      borderTopColor: dot,
      animation: tone === "running" ? "orbita-spin 0.7s linear infinite" : "none"
    }
  }), label);
}
Object.assign(__ds_scope, { RespondingIndicator });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chat/RespondingIndicator.jsx", error: String((e && e.message) || e) }); }

// components/chat/UserBubble.jsx
try { (() => {
/** Right-aligned narrow user message bubble. */
function UserBubble({
  children,
  time,
  delivery,
  attachments = [],
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-end",
      width: "100%",
      minWidth: 0,
      ...style
    }
  }, attachments.length ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      justifyContent: "flex-end",
      gap: "var(--space-2)",
      maxWidth: "var(--bubble-max-width)",
      marginBottom: "var(--space-2)"
    }
  }, attachments.map((src, i) => /*#__PURE__*/React.createElement("img", {
    key: i,
    src: src,
    alt: "",
    style: {
      width: 64,
      height: 64,
      objectFit: "cover",
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--color-border-subtle)"
    }
  }))) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "fit-content",
      maxWidth: "var(--bubble-max-width)",
      minWidth: 0,
      background: "var(--color-chat-card-bg)",
      border: "1px solid var(--color-border-subtle)",
      borderRadius: "var(--radius-bubble)",
      padding: "9px 13px",
      overflowWrap: "anywhere"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      whiteSpace: "pre-wrap",
      lineHeight: "var(--line-height-bubble)",
      color: "var(--color-text-primary)",
      fontSize: "var(--font-size-chat)"
    }
  }, children)), time || delivery ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: "var(--space-2)",
      marginTop: "var(--space-1)",
      color: "var(--color-text-tertiary)",
      fontSize: "var(--font-size-micro)",
      fontVariantNumeric: "tabular-nums"
    }
  }, delivery ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      height: 18,
      padding: "0 7px",
      borderRadius: "var(--radius-md)",
      fontFamily: "var(--font-family-business)",
      fontWeight: "var(--weight-semibold)",
      lineHeight: 1,
      border: delivery === "follow-up" ? "1px solid color-mix(in srgb, var(--color-info) 20%, var(--color-border-subtle))" : "1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border-subtle))",
      background: delivery === "follow-up" ? "color-mix(in srgb, var(--color-info) 10%, var(--color-bg-panel))" : "var(--color-bg-muted)",
      color: delivery === "follow-up" ? "var(--color-info)" : "var(--color-accent)"
    }
  }, delivery) : null, time ? /*#__PURE__*/React.createElement("time", {
    style: {
      fontFamily: "var(--font-family-business)"
    }
  }, time) : null) : null);
}
Object.assign(__ds_scope, { UserBubble });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chat/UserBubble.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const VARIANTS = {
  secondary: {
    background: "var(--color-bg-muted)",
    color: "var(--color-text-primary)",
    borderColor: "transparent"
  },
  outline: {
    background: "transparent",
    color: "var(--color-text-primary)",
    borderColor: "var(--color-border-subtle)"
  },
  muted: {
    background: "var(--color-bg-muted)",
    color: "var(--color-text-secondary)",
    borderColor: "transparent"
  },
  accent: {
    background: "var(--color-bg-muted)",
    color: "var(--color-accent)",
    borderColor: "color-mix(in srgb, var(--color-accent) 24%, var(--color-border-subtle))"
  },
  info: {
    background: "color-mix(in srgb, var(--color-info) 10%, var(--color-bg-panel))",
    color: "var(--color-info)",
    borderColor: "color-mix(in srgb, var(--color-info) 20%, var(--color-border-subtle))"
  }
};
function Badge({
  variant = "secondary",
  badgeSize = "sm",
  mono = false,
  children,
  style,
  ...rest
}) {
  const tone = VARIANTS[variant] || VARIANTS.secondary;
  return /*#__PURE__*/React.createElement("span", _extends({}, rest, {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      width: "fit-content",
      whiteSpace: "nowrap",
      padding: badgeSize === "md" ? "4px 10px" : "2px 8px",
      border: "1px solid",
      borderRadius: "var(--radius-md)",
      fontFamily: mono ? "var(--font-family-business)" : "var(--font-family-base)",
      fontSize: "var(--font-size-micro)",
      fontWeight: "var(--weight-semibold)",
      lineHeight: 1.4,
      ...tone,
      ...style
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  sm: {
    height: 32,
    padding: "0 12px",
    gap: 6
  },
  md: {
    height: 36,
    padding: "8px 16px",
    gap: 8
  }
};
const VARIANTS = {
  primary: {
    background: "var(--color-text-primary)",
    color: "var(--color-text-inverse)",
    border: "1px solid transparent"
  },
  secondary: {
    background: "var(--color-bg-muted)",
    color: "var(--color-text-primary)",
    border: "1px solid var(--color-border-subtle)"
  },
  danger: {
    background: "var(--color-danger)",
    color: "#fff",
    border: "1px solid transparent"
  },
  ghost: {
    background: "transparent",
    color: "var(--color-text-primary)",
    border: "1px solid transparent"
  },
  accent: {
    background: "var(--color-accent)",
    color: "var(--color-accent-fg)",
    border: "1px solid transparent"
  }
};
const HOVER = {
  primary: "color-mix(in srgb, var(--color-text-primary) 90%, transparent)",
  secondary: "var(--color-bg-hover)",
  danger: "color-mix(in srgb, var(--color-danger) 90%, transparent)",
  ghost: "var(--color-bg-hover)",
  accent: "var(--color-accent-strong)"
};
function Button({
  variant = "secondary",
  buttonSize = "md",
  loading = false,
  disabled,
  children,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const size = SIZES[buttonSize] || SIZES.md;
  const tone = VARIANTS[variant] || VARIANTS.secondary;
  const off = disabled || loading;
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    disabled: off,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, rest, {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      whiteSpace: "nowrap",
      gap: size.gap,
      height: size.height,
      padding: size.padding,
      borderRadius: "var(--radius-md)",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-body)",
      fontWeight: "var(--weight-medium)",
      cursor: off ? "not-allowed" : "pointer",
      opacity: off ? 0.5 : 1,
      transition: "var(--transition-hover)",
      ...tone,
      ...(hover && !off ? {
        background: HOVER[variant]
      } : null),
      ...style
    }
  }), loading && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 14,
      borderRadius: "var(--radius-pill)",
      border: "2px solid currentColor",
      borderTopColor: "transparent",
      animation: "orbita-spin 0.7s linear infinite"
    }
  }), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CACHE = new Map();

/**
 * Inlines a Lucide SVG copied into assets/icons/lucide so it inherits
 * currentColor and the app's stroke weight.
 */
function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  base,
  style,
  ...rest
}) {
  const root = base || typeof window !== "undefined" && window.ORBITA_ICON_BASE || "assets/icons/lucide";
  const url = `${root}/${name}.svg`;
  const [markup, setMarkup] = React.useState(() => CACHE.get(url) || "");
  React.useEffect(() => {
    if (CACHE.has(url)) {
      setMarkup(CACHE.get(url));
      return;
    }
    let alive = true;
    fetch(url).then(r => r.ok ? r.text() : "").then(text => {
      const cleaned = text.replace(/<\?xml[^>]*\?>/, "").trim();
      CACHE.set(url, cleaned);
      if (alive) setMarkup(cleaned);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);
  return /*#__PURE__*/React.createElement("span", _extends({
    "aria-hidden": "true"
  }, rest, {
    style: {
      display: "inline-flex",
      flex: "0 0 auto",
      width: size,
      height: size,
      lineHeight: 0,
      ["--icon-stroke"]: strokeWidth,
      ...style
    },
    ref: node => {
      if (!node || !markup) return;
      node.innerHTML = markup;
      const svg = node.firstElementChild;
      if (svg) {
        svg.setAttribute("width", size);
        svg.setAttribute("height", size);
        svg.setAttribute("stroke-width", strokeWidth);
      }
    }
  }));
}
Object.assign(__ds_scope, { Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/chat/ThinkingCard.jsx
try { (() => {
/** Reasoning block, collapsed to one line until clicked. */
function ThinkingCard({
  label = "thinking",
  subtitle,
  duration,
  hint,
  detail,
  defaultOpen = false,
  style
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%",
      minWidth: 0,
      borderRadius: "var(--radius-md)",
      overflow: "hidden",
      ...style
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setOpen(v => !v),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)",
      width: "100%",
      minHeight: 32,
      padding: "6px 10px",
      border: 0,
      background: hover ? "color-mix(in srgb, var(--color-bg-hover) 50%, transparent)" : "transparent",
      color: "var(--color-text-secondary)",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-control)",
      lineHeight: "var(--line-height-control)",
      textAlign: "left",
      cursor: "pointer",
      transition: "background-color var(--duration-instant) var(--ease-standard)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--color-info)",
      display: "inline-flex"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "brain",
    size: 14,
    strokeWidth: 1.8
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: "0 0 auto",
      fontWeight: "var(--weight-strong)",
      fontSize: "var(--font-size-body)",
      color: "var(--color-text-primary)"
    }
  }, label), subtitle ? /*#__PURE__*/React.createElement("span", {
    style: {
      flex: "1 1 auto",
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "var(--color-text-tertiary)",
      fontFamily: "var(--font-family-mono)",
      fontSize: "var(--font-size-caption)"
    }
  }, subtitle) : null, hint ? /*#__PURE__*/React.createElement("em", {
    style: {
      flex: "1 1 auto",
      textAlign: "right",
      color: "var(--color-info)",
      fontStyle: "normal",
      fontSize: "var(--font-size-caption)"
    }
  }, hint) : null, duration ? /*#__PURE__*/React.createElement("small", {
    style: {
      flex: "0 0 auto",
      color: "var(--color-text-tertiary)",
      fontFamily: "var(--font-family-business)",
      fontSize: "var(--font-size-micro)",
      fontVariantNumeric: "tabular-nums"
    }
  }, duration) : null, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: "0 0 auto",
      color: "var(--color-text-tertiary)",
      transform: open ? "rotate(180deg)" : "none",
      transition: "transform var(--duration-fast) var(--ease-standard)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-down",
    size: 14,
    strokeWidth: 1.8
  }))), open && detail ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "var(--space-2) var(--space-3) var(--space-3)",
      borderTop: "1px solid var(--color-border-subtle)",
      color: "var(--color-text-tertiary)",
      fontSize: "var(--font-size-caption)",
      lineHeight: 1.6,
      whiteSpace: "pre-wrap",
      fontFamily: "var(--font-family-mono)",
      maxHeight: 160,
      overflow: "auto"
    }
  }, detail) : null);
}
Object.assign(__ds_scope, { ThinkingCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chat/ThinkingCard.jsx", error: String((e && e.message) || e) }); }

// components/chat/ToolCard.jsx
try { (() => {
const TONE_COLOR = {
  running: "var(--color-warning)",
  error: "var(--color-danger)",
  done: "var(--color-text-tertiary)"
};

/** One tool call, collapsed to a single line until clicked. */
function ToolCard({
  name,
  subtitle,
  icon = "wrench",
  tone = "done",
  status,
  duration,
  detail,
  defaultOpen = false,
  style
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%",
      minWidth: 0,
      borderRadius: "var(--radius-sm)",
      overflow: "hidden",
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      minHeight: 32,
      background: hover ? "color-mix(in srgb, var(--color-bg-hover) 50%, transparent)" : "transparent",
      transition: "background-color var(--duration-instant) var(--ease-standard)"
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setOpen(v => !v),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)",
      flex: "1 1 auto",
      minWidth: 0,
      minHeight: 32,
      padding: "6px 10px",
      border: 0,
      background: "transparent",
      color: "var(--color-text-secondary)",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-control)",
      lineHeight: "var(--line-height-control)",
      textAlign: "left",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      color: "var(--color-text-tertiary)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 14,
    strokeWidth: 1.8
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: "0 0 auto",
      fontWeight: "var(--weight-strong)",
      fontSize: "var(--font-size-body)",
      color: "var(--color-text-primary)",
      textTransform: "lowercase"
    }
  }, name), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: "1 1 auto",
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "var(--color-text-tertiary)",
      fontFamily: "var(--font-family-mono)",
      fontSize: "var(--font-size-caption)"
    }
  }, subtitle), tone === "running" ? /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      flex: "0 0 auto",
      borderRadius: "var(--radius-pill)",
      border: "2px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
      borderTopColor: "var(--color-warning)",
      animation: "orbita-spin 0.7s linear infinite"
    }
  }) : null, status ? /*#__PURE__*/React.createElement("span", {
    style: {
      flex: "0 0 auto",
      color: TONE_COLOR[tone] || TONE_COLOR.done,
      fontSize: "var(--font-size-micro)",
      fontFamily: "var(--font-family-business)",
      fontVariantNumeric: "tabular-nums"
    }
  }, status) : null, duration ? /*#__PURE__*/React.createElement("span", {
    style: {
      flex: "0 0 auto",
      color: "var(--color-text-tertiary)",
      fontFamily: "var(--font-family-business)",
      fontSize: "var(--font-size-micro)",
      fontVariantNumeric: "tabular-nums"
    }
  }, duration) : null, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: "0 0 auto",
      color: "var(--color-text-tertiary)",
      transform: open ? "rotate(180deg)" : "none",
      transition: "transform var(--duration-fast) var(--ease-standard)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-down",
    size: 14,
    strokeWidth: 1.8
  })))), open && detail ? /*#__PURE__*/React.createElement("pre", {
    style: {
      margin: 0,
      padding: "var(--space-2)",
      maxHeight: 320,
      overflow: "auto",
      borderTop: "1px solid var(--color-border-subtle)",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "var(--font-family-mono)",
      fontSize: "var(--font-size-caption)",
      lineHeight: 1.6,
      color: "var(--color-text-secondary)"
    }
  }, detail) : null);
}
Object.assign(__ds_scope, { ToolCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chat/ToolCard.jsx", error: String((e && e.message) || e) }); }

// components/composer/Composer.jsx
try { (() => {
/**
 * The input box. One treatment everywhere: a layer-3 glass card. It carries the
 * home screen, then glides to the bottom of the chat page — the width, surface
 * and radius never change, only the vertical position.
 *
 * Radius follows the surface: as a glass card it takes --radius-xl (10px), the
 * same as every other glass surface in the system.
 */
function Composer({
  value = "",
  onChange,
  onSubmit,
  placeholder = "Ask anything, or start a task",
  topSlot,
  bottomSlot,
  rows = 2,
  disabled = false,
  running = false,
  style
}) {
  const [hover, setHover] = React.useState(false);
  const send = () => {
    if (!disabled && value.trim() && onSubmit) onSubmit(value.trim());
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%",
      minWidth: 0,
      display: "flex",
      flexDirection: "column",
      gap: 6,
      padding: "10px 12px 8px",
      borderRadius: "var(--radius-xl)",
      background: "var(--glass-bg)",
      border: "1px solid var(--glass-border)",
      boxShadow: "var(--shadow-composer)",
      WebkitBackdropFilter: "blur(var(--glass-blur))",
      backdropFilter: "blur(var(--glass-blur))",
      ...style
    }
  }, topSlot ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)"
    }
  }, topSlot) : null, /*#__PURE__*/React.createElement("textarea", {
    rows: rows,
    value: value,
    disabled: disabled,
    placeholder: placeholder,
    onChange: e => onChange && onChange(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    style: {
      width: "100%",
      border: 0,
      background: "transparent",
      resize: "none",
      outline: "none",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-input)",
      lineHeight: "var(--line-height-input)",
      color: "var(--color-text-primary)",
      padding: "2px 4px"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, bottomSlot, /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-label": running ? "Stop" : "Send",
    title: running ? "Stop" : "Send",
    onClick: send,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      marginLeft: "auto",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 28,
      height: 28,
      border: 0,
      borderRadius: "var(--radius-pill)",
      background: running ? "color-mix(in srgb, var(--color-danger) 8%, transparent)" : hover ? "var(--color-accent-strong)" : "var(--color-accent)",
      color: running ? "var(--color-danger)" : "var(--color-accent-fg)",
      cursor: "pointer",
      transition: "var(--transition-hover)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: running ? "square" : "arrow-up",
    size: 16,
    strokeWidth: 2
  }))));
}
Object.assign(__ds_scope, { Composer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/composer/Composer.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  sm: 32,
  md: 36
};
const VARIANTS = {
  ghost: {
    background: "transparent",
    border: "1px solid transparent"
  },
  outline: {
    background: "var(--color-bg-panel)",
    border: "1px solid var(--color-border-subtle)",
    boxShadow: "var(--shadow-border)"
  },
  soft: {
    background: "var(--color-bg-muted)",
    border: "1px solid transparent"
  }
};
function IconButton({
  label,
  variant = "ghost",
  buttonSize = "sm",
  active = false,
  disabled,
  children,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const box = SIZES[buttonSize] || SIZES.sm;
  const tone = VARIANTS[variant] || VARIANTS.ghost;
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    "aria-label": label,
    title: rest.title || label,
    "aria-pressed": active || undefined,
    disabled: disabled,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, rest, {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      flex: "0 0 auto",
      width: box,
      height: box,
      borderRadius: "var(--radius-md)",
      color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      transition: "var(--transition-hover)",
      ...tone,
      ...(active ? {
        background: "var(--color-bg-active)"
      } : null),
      ...(hover && !disabled ? {
        background: "var(--color-bg-hover)",
        color: "var(--color-text-primary)"
      } : null),
      ...style
    }
  }), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Modal.jsx
try { (() => {
const WIDTH = {
  full: "min(1300px, calc(100% - 48px))",
  medium: "min(800px, calc(100% - 48px))",
  small: "min(480px, calc(100% - 48px))"
};
function Modal({
  open,
  onClose,
  title,
  size = "medium",
  children,
  style
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      zIndex: 50,
      display: "grid",
      placeItems: "center",
      background: "var(--overlay-backdrop)"
    },
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    role: "dialog",
    "aria-modal": "true",
    onClick: e => e.stopPropagation(),
    style: {
      width: WIDTH[size] || WIDTH.medium,
      maxHeight: size === "full" ? "min(850px, calc(100% - 48px))" : "calc(100% - 48px)",
      overflow: "auto",
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-4)",
      padding: "var(--space-6)",
      border: "1px solid var(--color-border-subtle)",
      borderRadius: "var(--radius-lg)",
      background: "var(--color-bg-panel)",
      boxShadow: "var(--shadow-modal)",
      ...style
    }
  }, title ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "var(--space-4)"
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-title)",
      fontWeight: "var(--weight-semibold)",
      color: "var(--color-text-primary)"
    }
  }, title), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    label: "Close",
    buttonSize: "md",
    onClick: onClose
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 18,
    strokeWidth: 2.2
  }))) : null, children));
}
Object.assign(__ds_scope, { Modal });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Modal.jsx", error: String((e && e.message) || e) }); }

// components/core/SelectField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function SelectField({
  label,
  value,
  options = [],
  onChange,
  description,
  disabled,
  style,
  ...rest
}) {
  const [focused, setFocused] = React.useState(false);
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      opacity: disabled ? 0.5 : 1,
      ...style
    }
  }, label ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--font-size-body)",
      fontWeight: "var(--weight-medium)",
      color: "var(--color-text-primary)"
    }
  }, label) : null, /*#__PURE__*/React.createElement("select", _extends({
    value: value,
    disabled: disabled,
    onChange: e => onChange && onChange(e.target.value),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false)
  }, rest, {
    style: {
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
      appearance: "none"
    }
  }), options.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.value,
    value: o.value,
    disabled: o.disabled
  }, o.label))), description ? /*#__PURE__*/React.createElement("small", {
    style: {
      fontSize: "var(--font-size-caption)",
      color: "var(--color-text-secondary)"
    }
  }, description) : null);
}
Object.assign(__ds_scope, { SelectField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/SelectField.jsx", error: String((e && e.message) || e) }); }

// components/core/TextField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const labelStyle = {
  fontSize: "var(--font-size-body)",
  fontWeight: "var(--weight-medium)",
  color: "var(--color-text-primary)"
};
const descStyle = {
  fontSize: "var(--font-size-caption)",
  color: "var(--color-text-secondary)"
};
const fieldStyle = focused => ({
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
  transition: "var(--transition-hover)"
});
function TextField({
  label,
  value,
  onChange,
  description,
  placeholder,
  disabled,
  type = "text",
  style,
  ...rest
}) {
  const [focused, setFocused] = React.useState(false);
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      opacity: disabled ? 0.5 : 1,
      ...style
    }
  }, label ? /*#__PURE__*/React.createElement("span", {
    style: labelStyle
  }, label) : null, /*#__PURE__*/React.createElement("input", _extends({
    type: type,
    value: value,
    placeholder: placeholder,
    disabled: disabled,
    onChange: e => onChange && onChange(e.target.value),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false)
  }, rest, {
    style: fieldStyle(focused)
  })), description ? /*#__PURE__*/React.createElement("small", {
    style: descStyle
  }, description) : null);
}
Object.assign(__ds_scope, { TextField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/TextField.jsx", error: String((e && e.message) || e) }); }

// components/navigation/BrandLockup.jsx
try { (() => {
/** Sidebar wordmark. No logo mark exists yet — the name is set in the brand serif. */
function BrandLockup({
  size = 22,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    "aria-label": "orbita",
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      height: 34,
      minWidth: 0,
      lineHeight: 0,
      color: "var(--color-text-primary)",
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      display: "inline-flex",
      alignItems: "center",
      height: 34,
      fontFamily: "var(--font-family-brand)",
      fontSize: size,
      lineHeight: 1,
      fontWeight: 500,
      letterSpacing: "0.01em"
    }
  }, "orbita"));
}
Object.assign(__ds_scope, { BrandLockup });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/BrandLockup.jsx", error: String((e && e.message) || e) }); }

// components/navigation/ModeChip.jsx
try { (() => {
/** Mode selector in the expanded sidebar: Agent (current) / Orchestrate. */
function ModeChip({
  icon,
  children,
  active = false,
  disabled = false,
  onClick,
  style
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "tab",
    "aria-selected": active,
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      flex: 1,
      border: 0,
      borderRadius: "var(--radius-md)",
      padding: "4px 8px",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-control)",
      fontWeight: "var(--weight-medium)",
      cursor: disabled ? "default" : "pointer",
      background: active ? "var(--color-mode-active-bg)" : hover && !disabled ? "var(--color-bg-hover)" : "transparent",
      /* layer-1 text stays at full strength — a dimmed tertiary over glass
         reads as neither the theme's ink nor the wallpaper behind it */
      color: active ? "var(--color-mode-active-fg)" : "var(--color-text-primary)",
      opacity: 1,
      transition: "var(--transition-hover)",
      ...style
    }
  }, icon, children);
}
Object.assign(__ds_scope, { ModeChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/ModeChip.jsx", error: String((e && e.message) || e) }); }

// components/navigation/RailButton.jsx
try { (() => {
/** 32px icon-only control in the collapsed 48px sidebar rail. */
function RailButton({
  children,
  title,
  active = false,
  disabled = false,
  onClick,
  style
}) {
  const [hover, setHover] = React.useState(false);
  const Tag = disabled ? "span" : "button";
  return /*#__PURE__*/React.createElement(Tag, {
    type: disabled ? undefined : "button",
    title: title,
    "aria-disabled": disabled || undefined,
    onClick: disabled ? undefined : onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 32,
      height: 32,
      border: 0,
      borderRadius: "var(--radius-md)",
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.55 : 1,
      background: active ? "var(--color-mode-active-bg)" : hover && !disabled ? "var(--color-bg-hover)" : "transparent",
      color: active ? "var(--color-mode-active-fg)" : disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
      transition: "var(--transition-hover)",
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { RailButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/RailButton.jsx", error: String((e && e.message) || e) }); }

// components/navigation/SessionRow.jsx
try { (() => {
/* The leading slot carries STATUS, so it varies per row and earns its place.
   `running` still maps to the running state on its own. */
const STATUS = {
  running: {
    icon: "loader-circle",
    color: "var(--color-accent)",
    label: "Running",
    spin: true
  },
  done: {
    icon: "check",
    color: "var(--color-text-tertiary)",
    label: "Finished"
  },
  failed: {
    icon: "triangle-alert",
    color: "var(--color-danger)",
    label: "Failed"
  },
  idle: {
    icon: null,
    label: "Idle"
  }
};

/** One row in the sidebar session list: status, title, last-active time, read-only toggle on hover. */
function SessionRow({
  title,
  time,
  status,
  active = false,
  running = false,
  readOnly = false,
  onClick,
  onToggleReadOnly,
  style
}) {
  const [hover, setHover] = React.useState(false);
  const state = STATUS[running ? "running" : status] || STATUS.idle;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 2,
      ...style
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)",
      flex: 1,
      minWidth: 0,
      minHeight: "var(--control-height-md)",
      margin: "2px 0",
      padding: "var(--space-1) var(--space-2) var(--space-1) var(--space-1)",
      border: 0,
      borderRadius: "var(--radius-sm)",
      /* sits directly on layer 1 — hover and active are neutral, never tinted */
      background: active || hover ? "var(--color-bg-hover)" : "transparent",
      color: "var(--color-text-primary)",
      fontWeight: active ? "var(--weight-semibold)" : "var(--weight-regular)",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-control)",
      textAlign: "left",
      cursor: "pointer",
      transition: "var(--transition-hover)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    title: state.label,
    style: {
      display: "grid",
      placeItems: "center",
      width: 13,
      height: 13,
      flex: "0 0 auto",
      color: state.color
    }
  }, state.icon ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: state.icon,
    size: 13,
    strokeWidth: 1.8,
    style: state.spin ? {
      animation: "orbita-spin 1s linear infinite"
    } : undefined
  }) : null), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, title), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: "0 0 auto",
      color: "var(--color-text-tertiary)",
      fontFamily: "var(--font-family-business)",
      fontSize: "var(--font-size-micro)",
      fontVariantNumeric: "tabular-nums"
    }
  }, time)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: readOnly ? "Read-only · click to allow writes" : "Writable · click to make read-only",
    onClick: onToggleReadOnly,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 20,
      height: 20,
      border: 0,
      borderRadius: "var(--radius-xs)",
      background: "transparent",
      color: readOnly ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
      cursor: "pointer",
      opacity: hover || readOnly ? 1 : 0,
      transition: "opacity var(--duration-instant) var(--ease-standard)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: readOnly ? "lock" : "lock-open",
    size: 11,
    strokeWidth: 2
  })));
}
Object.assign(__ds_scope, { SessionRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/SessionRow.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Chip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Quiet inline control used inside the composer: label, optional icon, optional chevron. */
function Chip({
  icon,
  children,
  chevron = false,
  active = false,
  disabled = false,
  onClick,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, rest, {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      border: 0,
      borderRadius: "var(--radius-md)",
      padding: "3px 8px",
      background: active ? "var(--color-mode-active-bg)" : hover && !disabled ? "var(--color-bg-hover)" : "transparent",
      color: active ? "var(--color-mode-active-fg)" : disabled ? "var(--color-text-tertiary)" : hover ? "var(--color-text-primary)" : "var(--color-text-secondary)",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-control)",
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.55 : 1,
      whiteSpace: "nowrap",
      transition: "var(--transition-hover)",
      ...style
    }
  }), icon, children, chevron ? /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      fontSize: 9,
      opacity: 0.7,
      transform: "translateY(1px)"
    }
  }, "\u25BE") : null);
}
Object.assign(__ds_scope, { Chip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Chip.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/GlassCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* every glass surface takes the same radius, whatever the layer */
const GLASS_RADIUS = "var(--radius-xl)";

/**
 * The one card recipe in Orbita.
 *
 * Layer 1 is the app boundary — the whole window, sidebar included. Layer 2 is
 * the content pane, floating inside layer 1 with an even gap on all four sides;
 * its left edge is what sets the sidebar's width. Layer 3 is the input box and
 * the session cards.
 *
 * Every layer paints the SAME --glass-bg. The depth cue is the composite: a card
 * nested n deep reads as 1-(1-a)^n, so .60 → .84 → .936 falls out of stacking
 * on its own. The `layer` prop documents intent and drives nothing but the
 * shadow — never hand-pick a heavier background to fake depth.
 */
function GlassCard({
  layer = 2,
  as = "div",
  padding,
  radius,
  children,
  style,
  ...rest
}) {
  const Tag = as;
  return /*#__PURE__*/React.createElement(Tag, _extends({}, rest, {
    style: {
      background: "var(--glass-bg)",
      border: "1px solid var(--glass-border)",
      borderRadius: radius || GLASS_RADIUS,
      boxShadow: "var(--shadow-composer)",
      WebkitBackdropFilter: "blur(var(--glass-blur))",
      backdropFilter: "blur(var(--glass-blur))",
      padding,
      minWidth: 0,
      ...style
    }
  }), children);
}
Object.assign(__ds_scope, { GlassCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/GlassCard.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/SessionCard.jsx
try { (() => {
/** Home-screen session card: title line + up to three recent user queries. */
function SessionCard({
  name,
  queries = [],
  running = false,
  loading = false,
  onClick,
  style
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement(__ds_scope.GlassCard, {
    as: "button",
    layer: 3,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      flex: 1,
      minWidth: 0,
      textAlign: "left",
      cursor: "pointer",
      padding: "10px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 5,
      font: "inherit",
      transition: "box-shadow var(--duration-instant) var(--ease-out-quint)",
      boxShadow: hover ? "var(--shadow-popover)" : "var(--shadow-composer)",
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      fontWeight: "var(--weight-semibold)",
      fontSize: "var(--font-size-control)",
      color: "var(--color-text-primary)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 0,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, name), running ? /*#__PURE__*/React.createElement("span", {
    title: "Session running",
    style: {
      width: 6,
      height: 6,
      flex: "0 0 auto",
      borderRadius: "var(--radius-pill)",
      background: "var(--color-accent)"
    }
  }) : null), [0, 1, 2].map(i => loading ? /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      height: "var(--line-height-micro)",
      borderRadius: "var(--radius-xs)",
      background: "var(--color-bg-hover)",
      animation: "orbita-skeleton 1.2s ease-in-out infinite"
    }
  }) : /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      height: "var(--line-height-micro)",
      fontSize: "var(--font-size-control)",
      lineHeight: "var(--line-height-micro)",
      color: "var(--color-text-tertiary)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, queries[i] ?? "")));
}
Object.assign(__ds_scope, { SessionCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/SessionCard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orbita-desktop/App.jsx
try { (() => {
const {
  GlassCard,
  IconButton,
  Icon
} = window.OrbitaDesignSystem_994749;

/* Session actions live on a right-hand rail, mirroring the sidebar: both sit
   directly on layer 1 with no surface of their own. */
function ActionRail({
  drawerOpen,
  onToggleDrawer
}) {
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      flex: "0 0 auto",
      width: 32,
      height: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "var(--space-3)",
      padding: "var(--space-2) var(--space-3)",
      background: "transparent",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    label: drawerOpen ? "Close files panel" : "Open files panel",
    active: drawerOpen,
    onClick: onToggleDrawer,
    style: {
      background: "var(--color-bg-panel)",
      border: 0,
      boxShadow: "none"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "panel-right",
    size: 16
  })), /*#__PURE__*/React.createElement(IconButton, {
    label: "Copy transcript",
    style: {
      background: "var(--color-bg-panel)",
      border: 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "copy",
    size: 16
  })), /*#__PURE__*/React.createElement(IconButton, {
    label: "Terminal",
    style: {
      background: "var(--color-bg-panel)",
      border: 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "terminal",
    size: 16
  })));
}
const {
  Sidebar,
  HomeScreen,
  ChatScreen,
  Drawer,
  SettingsDialog
} = window;
function App() {
  const [page, setPage] = React.useState("home");
  const [exiting, setExiting] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [reply, setReply] = React.useState("");
  const [collapsed, setCollapsed] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [theme, setTheme] = React.useState("light");
  const [wall, setWall] = React.useState("light");
  const [activeId, setActiveId] = React.useState(undefined);
  const [transcript, setTranscript] = React.useState([]);
  const [running, setRunning] = React.useState(false);
  const [readOnly, setReadOnly] = React.useState(["s3"]);
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const send = text => {
    setExiting(true);
    window.setTimeout(() => {
      setTranscript([{
        kind: "user",
        text,
        time: "14:31"
      }, {
        kind: "thinking",
        subtitle: "Reading the composer and the home view…",
        duration: "2.4s",
        detail: "Both read --content-max-width; only the position changes."
      }, {
        kind: "tool",
        name: "read",
        subtitle: "src/renderer/src/styles.css",
        duration: "0.4s",
        icon: "file-text",
        detail: "23470 lines"
      }]);
      setActiveId("new");
      setPage("chat");
      setDraft("");
      setExiting(false);
      setRunning(true);
      window.setTimeout(() => {
        setRunning(false);
        setTranscript(t => [...t, {
          kind: "assistant",
          text: "Done. The composer keeps its width; the slogan and session cards fade out and the box glides to the bottom of the window."
        }]);
      }, 1600);
    }, 240);
  };
  const openSession = s => {
    setActiveId(s.id);
    setPage("chat");
    setTranscript(window.TRANSCRIPT);
    setRunning(true);
  };
  const newSession = () => {
    setPage("home");
    setActiveId(undefined);
    setTranscript([]);
    setRunning(false);
  };
  const openTask = window.SESSIONS.find(s => s.id === activeId);
  const title = page === "chat" ? openTask?.title ?? "Keep the composer width fixed" : "";
  /* a task with no workspace shows no badge rather than a borrowed one */
  const workspace = openTask?.project;
  return /*#__PURE__*/React.createElement("div", {
    className: wall === "dark" ? "desk wall-dark" : "desk"
  }, /*#__PURE__*/React.createElement("div", {
    className: "probe"
  }, /*#__PURE__*/React.createElement("button", {
    "aria-pressed": theme === "light",
    onClick: () => setTheme("light")
  }, "Light UI"), /*#__PURE__*/React.createElement("button", {
    "aria-pressed": theme === "dark",
    onClick: () => setTheme("dark")
  }, "Dark UI"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 1,
      background: "var(--color-border-subtle)",
      margin: "4px 2px"
    }
  }), /*#__PURE__*/React.createElement("button", {
    "aria-pressed": wall === "light",
    onClick: () => setWall("light")
  }, "Light wall"), /*#__PURE__*/React.createElement("button", {
    "aria-pressed": wall === "dark",
    onClick: () => setWall("dark")
  }, "Dark wall")), /*#__PURE__*/React.createElement(GlassCard, {
    layer: 1,
    style: {
      height: "100%",
      maxWidth: "none",
      display: "flex",
      gap: "var(--space-3)",
      padding: "var(--space-3)",
      overflow: "hidden",
      position: "relative",
      border: 0
    }
  }, /*#__PURE__*/React.createElement(Sidebar, {
    collapsed: collapsed,
    onCollapse: () => setCollapsed(true),
    onExpand: () => setCollapsed(false),
    activeId: activeId,
    onOpen: openSession,
    onNewSession: newSession,
    onSettings: () => setSettingsOpen(true),
    sessions: window.SESSIONS,
    readOnly: readOnly,
    onToggleReadOnly: id => setReadOnly(r => r.includes(id) ? r.filter(x => x !== id) : [...r, id])
  }), /*#__PURE__*/React.createElement(GlassCard, {
    layer: 2,
    as: "main",
    style: {
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
      border: 0
    }
  }, page === "home" ? /*#__PURE__*/React.createElement(HomeScreen, {
    value: draft,
    onChange: setDraft,
    onSubmit: send,
    exiting: exiting,
    onOpenSession: openSession
  }) : /*#__PURE__*/React.createElement(ChatScreen, {
    title: title,
    workspace: workspace,
    transcript: transcript,
    value: reply,
    onChange: setReply,
    onSubmit: () => setReply(""),
    running: running,
    drawerOpen: drawerOpen,
    onToggleDrawer: () => setDrawerOpen(v => !v)
  })), page === "chat" ? /*#__PURE__*/React.createElement(ActionRail, {
    drawerOpen: drawerOpen,
    onToggleDrawer: () => setDrawerOpen(v => !v)
  }) : null, /*#__PURE__*/React.createElement(Drawer, {
    open: drawerOpen && page === "chat",
    onClose: () => setDrawerOpen(false)
  }), /*#__PURE__*/React.createElement(SettingsDialog, {
    open: settingsOpen,
    onClose: () => setSettingsOpen(false),
    theme: theme,
    onTheme: setTheme
  })));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orbita-desktop/App.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orbita-desktop/ChatScreen.jsx
try { (() => {
const {
  UserBubble,
  AssistantText,
  ToolCard,
  ThinkingCard,
  RespondingIndicator,
  Composer,
  Chip,
  Badge,
  IconButton,
  Icon
} = window.OrbitaDesignSystem_994749;
function ChatHeader({
  title,
  workspace,
  onToggleDrawer,
  drawerOpen
}) {
  return /*#__PURE__*/React.createElement("header", {
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) auto",
      gap: 12,
      alignItems: "center",
      padding: "12px 18px",
      borderBottom: "1px solid var(--color-border-subtle)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      minWidth: 0,
      height: 30
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontSize: "var(--font-size-title)",
      lineHeight: "30px",
      fontWeight: "var(--weight-bold)"
    }
  }, title), workspace ? /*#__PURE__*/React.createElement(Badge, {
    variant: "outline",
    mono: true
  }, workspace) : null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    variant: "muted",
    mono: true
  }, "a7f3c1")));
}
function Turn({
  item
}) {
  if (item.kind === "user") return /*#__PURE__*/React.createElement(UserBubble, {
    time: item.time,
    delivery: item.delivery
  }, item.text);
  if (item.kind === "assistant") return /*#__PURE__*/React.createElement(AssistantText, null, item.text.split("\n\n").map((p, i) => /*#__PURE__*/React.createElement("p", {
    key: i,
    style: {
      margin: i ? "1em 0 0" : 0
    }
  }, p)));
  if (item.kind === "thinking") return /*#__PURE__*/React.createElement(ThinkingCard, {
    subtitle: item.subtitle,
    duration: item.duration,
    detail: item.detail
  });
  return /*#__PURE__*/React.createElement(ToolCard, {
    name: item.name,
    subtitle: item.subtitle,
    icon: item.icon,
    tone: item.tone,
    status: item.status,
    duration: item.duration,
    detail: item.detail
  });
}
function ChatScreen({
  title,
  workspace,
  transcript,
  value,
  onChange,
  onSubmit,
  running,
  onToggleDrawer,
  drawerOpen
}) {
  const endRef = React.useRef(null);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      display: "grid",
      gridTemplateRows: "auto minmax(0,1fr) auto",
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement(ChatHeader, {
    title: title,
    workspace: workspace,
    onToggleDrawer: onToggleDrawer,
    drawerOpen: drawerOpen
  }), /*#__PURE__*/React.createElement("div", {
    className: "scroll",
    style: {
      minHeight: 0,
      padding: "var(--space-6) var(--space-5)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "min(100%, var(--content-max-width))",
      margin: "0 auto",
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-4)"
    }
  }, transcript.map((item, i) => /*#__PURE__*/React.createElement(Turn, {
    key: i,
    item: item
  })), running ? /*#__PURE__*/React.createElement(RespondingIndicator, {
    label: "Running typecheck"
  }) : null, /*#__PURE__*/React.createElement("div", {
    ref: endRef
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "var(--space-1) var(--space-5) 10px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "min(100%, var(--content-max-width))",
      margin: "0 auto"
    }
  }, /*#__PURE__*/React.createElement(Composer, {
    value: value,
    onChange: onChange,
    onSubmit: onSubmit,
    running: running,
    placeholder: "Reply, or steer the agent",
    bottomSlot: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Chip, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "paperclip",
        size: 12
      })
    }, "Attach"), /*#__PURE__*/React.createElement(Chip, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "at-sign",
        size: 12
      })
    }, "Context"), /*#__PURE__*/React.createElement(Chip, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "shield-check",
        size: 12
      }),
      chevron: true
    }, "Full access"), /*#__PURE__*/React.createElement(Chip, {
      chevron: true
    }, "GLM-5.3"), /*#__PURE__*/React.createElement(Chip, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "gauge",
        size: 12
      }),
      chevron: true
    }, "Max"))
  }))));
}
Object.assign(window, {
  ChatScreen,
  ChatHeader,
  Turn
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orbita-desktop/ChatScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orbita-desktop/Drawer.jsx
try { (() => {
const {
  Badge,
  IconButton,
  Icon
} = window.OrbitaDesignSystem_994749;

/** Right drawer — closed by default. Files slice only; the git, terminal and
 *  browser slices are not recreated here (see README). */
function Drawer({
  open,
  onClose
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 320,
      flex: "0 0 320px",
      display: "flex",
      flexDirection: "column",
      background: "var(--color-bg-panel)",
      borderLeft: "1px solid var(--color-border-subtle)",
      boxShadow: "var(--shadow-drawer)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "12px 14px",
      borderBottom: "1px solid var(--color-border-subtle)"
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      flex: 1,
      fontSize: "var(--font-size-control)",
      fontWeight: "var(--weight-semibold)"
    }
  }, "Changed files"), /*#__PURE__*/React.createElement(Badge, {
    variant: "muted",
    mono: true
  }, window.DRAWER_FILES.length), /*#__PURE__*/React.createElement(IconButton, {
    label: "Close panel",
    onClick: onClose
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "x",
    size: 16
  }))), /*#__PURE__*/React.createElement("div", {
    className: "scroll",
    style: {
      flex: 1,
      padding: "var(--space-2)"
    }
  }, window.DRAWER_FILES.map(f => /*#__PURE__*/React.createElement("button", {
    key: f.name,
    type: "button",
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)",
      width: "100%",
      minHeight: 36,
      padding: "6px 8px",
      border: 0,
      borderRadius: "var(--radius-sm)",
      background: "transparent",
      textAlign: "left",
      cursor: "pointer",
      fontFamily: "var(--font-family-base)"
    },
    onMouseEnter: e => e.currentTarget.style.background = "var(--color-bg-hover)",
    onMouseLeave: e => e.currentTarget.style.background = "transparent"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--color-text-tertiary)",
      display: "inline-flex"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "file-text",
    size: 13,
    strokeWidth: 1.8
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      display: "flex",
      flexDirection: "column"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--font-size-control)",
      color: "var(--color-text-primary)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, f.name), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-family-mono)",
      fontSize: "var(--font-size-micro)",
      color: "var(--color-text-tertiary)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, f.path)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-family-business)",
      fontSize: "var(--font-size-micro)",
      color: "var(--color-accent)"
    }
  }, "+", f.added), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-family-business)",
      fontSize: "var(--font-size-micro)",
      color: "var(--color-danger)"
    }
  }, "\u2212", f.removed)))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 14px",
      borderTop: "1px solid var(--color-border-subtle)",
      display: "flex",
      alignItems: "center",
      gap: 6,
      color: "var(--color-text-tertiary)",
      fontSize: "var(--font-size-caption)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "git-branch",
    size: 12,
    strokeWidth: 1.8
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-family-business)"
    }
  }, "feature/glass")));
}
Object.assign(window, {
  Drawer
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orbita-desktop/Drawer.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orbita-desktop/HomeScreen.jsx
try { (() => {
const {
  SessionCard,
  Composer,
  Chip,
  Icon
} = window.OrbitaDesignSystem_994749;
function HomeScreen({
  value,
  onChange,
  onSubmit,
  exiting,
  onOpenSession
}) {
  const cards = window.SESSIONS.slice(0, 3);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "var(--space-5)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "min(100%, var(--content-max-width))",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "var(--space-5)"
    }
  }, /*#__PURE__*/React.createElement("h1", {
    className: exiting ? "fade-out" : "",
    style: {
      margin: "0 0 var(--space-1)",
      fontFamily: "var(--font-family-brand)",
      fontSize: "var(--font-size-logo)",
      fontWeight: 600,
      letterSpacing: "var(--tracking-slogan)",
      color: "var(--color-text-primary)",
      textAlign: "center"
    }
  }, "\u7487\u7391\u8FD0\u8F6C\uFF0C\u8BF8\u4E8B\u5F97\u5E8F"), /*#__PURE__*/React.createElement("div", {
    className: exiting ? "fade-out" : "",
    style: {
      display: "flex",
      gap: "var(--space-3)",
      width: "100%"
    }
  }, cards.map(c => /*#__PURE__*/React.createElement(SessionCard, {
    key: c.id,
    name: c.project,
    queries: c.queries || [],
    running: c.running,
    onClick: () => onOpenSession(c)
  }))), /*#__PURE__*/React.createElement("div", {
    className: exiting ? "slide-down" : "",
    style: {
      width: "100%"
    }
  }, /*#__PURE__*/React.createElement(Composer, {
    value: value,
    onChange: onChange,
    onSubmit: onSubmit,
    topSlot: /*#__PURE__*/React.createElement(Chip, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "folder",
        size: 12
      }),
      chevron: true
    }, "orbita-desktop"),
    bottomSlot: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Chip, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "shield-check",
        size: 12
      }),
      chevron: true
    }, "Full access"), /*#__PURE__*/React.createElement(Chip, {
      chevron: true
    }, "GLM-5.3"), /*#__PURE__*/React.createElement(Chip, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "gauge",
        size: 12
      }),
      chevron: true
    }, "Max"))
  }))));
}
Object.assign(window, {
  HomeScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orbita-desktop/HomeScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orbita-desktop/SettingsDialog.jsx
try { (() => {
const {
  Modal,
  SelectField,
  TextField,
  Button,
  Badge
} = window.OrbitaDesignSystem_994749;
function SettingsDialog({
  open,
  onClose,
  theme,
  onTheme
}) {
  return /*#__PURE__*/React.createElement(Modal, {
    open: open,
    onClose: onClose,
    title: "Settings",
    size: "medium"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-5)"
    }
  }, /*#__PURE__*/React.createElement("section", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-3)"
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      fontSize: "var(--font-size-body)",
      fontWeight: "var(--weight-semibold)"
    }
  }, "Appearance"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "var(--space-4)"
    }
  }, /*#__PURE__*/React.createElement(SelectField, {
    label: "Theme",
    value: theme,
    onChange: onTheme,
    options: [{
      value: "light",
      label: "Light"
    }, {
      value: "dark",
      label: "Dark"
    }],
    description: "Selection reads blue on light, yellow on dark."
  }), /*#__PURE__*/React.createElement(SelectField, {
    label: "UI text size",
    value: "default",
    onChange: () => {},
    options: [{
      value: "compact",
      label: "Compact"
    }, {
      value: "default",
      label: "Default"
    }, {
      value: "medium",
      label: "Medium"
    }, {
      value: "large",
      label: "Large"
    }]
  }))), /*#__PURE__*/React.createElement("section", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-3)"
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      fontSize: "var(--font-size-body)",
      fontWeight: "var(--weight-semibold)"
    }
  }, "Conversation"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "var(--space-4)"
    }
  }, /*#__PURE__*/React.createElement(TextField, {
    label: "Content width",
    value: "1000",
    onChange: () => {},
    type: "number",
    description: "Shared by the transcript and the composer."
  }), /*#__PURE__*/React.createElement(SelectField, {
    label: "Default permission",
    value: "full",
    onChange: () => {},
    options: [{
      value: "full",
      label: "Full access"
    }, {
      value: "plan",
      label: "Plan only"
    }, {
      value: "read",
      label: "Read-only"
    }]
  }))), /*#__PURE__*/React.createElement("section", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    variant: "muted",
    mono: true
  }, "orbita 0.9.4"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    buttonSize: "sm",
    onClick: onClose
  }, "Cancel"), /*#__PURE__*/React.createElement(Button, {
    variant: "accent",
    buttonSize: "sm",
    onClick: onClose
  }, "Save"))));
}
Object.assign(window, {
  SettingsDialog
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orbita-desktop/SettingsDialog.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orbita-desktop/Sidebar.jsx
try { (() => {
const {
  BrandLockup,
  ModeChip,
  RailButton,
  SessionRow,
  IconButton,
  Icon,
  Badge
} = window.OrbitaDesignSystem_994749;
function SidebarRail({
  onExpand,
  onNewSession,
  onSettings
}) {
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 48,
      flex: "0 0 48px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 4,
      padding: "4px 0",
      background: "transparent"
    }
  }, /*#__PURE__*/React.createElement(RailButton, {
    title: "Expand sidebar",
    onClick: onExpand
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "panel-left",
    size: 16
  })), /*#__PURE__*/React.createElement(RailButton, {
    title: "Agent mode",
    active: true
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "bot",
    size: 16
  })), /*#__PURE__*/React.createElement(RailButton, {
    title: "Orchestrate \u2014 opens with the orchestration phase",
    disabled: true
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "workflow",
    size: 16
  })), /*#__PURE__*/React.createElement(RailButton, {
    title: "New task",
    onClick: onNewSession
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 16
  })), /*#__PURE__*/React.createElement(RailButton, {
    title: "Search",
    onClick: onExpand
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 16
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(RailButton, {
    title: "Settings",
    onClick: onSettings
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "settings",
    size: 16
  })));
}
function NodeHeader({
  label,
  addLabel,
  addIcon,
  onAdd
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) 26px",
      alignItems: "center",
      gap: 2,
      minHeight: 28
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--font-size-micro)",
      fontFamily: "var(--font-family-business)",
      letterSpacing: ".06em",
      textTransform: "uppercase",
      color: "var(--color-text-secondary)"
    }
  }, label), /*#__PURE__*/React.createElement(IconButton, {
    label: addLabel,
    onClick: onAdd,
    style: {
      width: 26,
      height: 26
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: addIcon,
    size: 14
  })));
}
function ProjectGroup({
  project,
  sessions,
  expanded,
  onToggle,
  activeId,
  onOpen,
  onToggleReadOnly,
  onNewTask
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "var(--space-2) 0"
    },
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) 26px",
      alignItems: "center",
      gap: 2,
      borderRadius: "var(--radius-sm)",
      background: hover ? "var(--color-bg-hover)" : "transparent",
      transition: "var(--transition-hover)"
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onToggle,
    style: {
      display: "grid",
      gridTemplateColumns: "24px minmax(0,1fr) max-content",
      alignItems: "center",
      gap: "var(--space-2)",
      width: "100%",
      minHeight: 28,
      padding: "var(--space-1) var(--space-2) var(--space-1) 0",
      border: 0,
      borderRadius: "var(--radius-sm)",
      background: "transparent",
      cursor: "pointer",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "grid",
      placeItems: "center",
      width: 24,
      height: 24,
      borderRadius: "var(--radius-sm)",
      background: "transparent",
      color: "var(--color-text-secondary)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "folder",
    size: 14,
    strokeWidth: 1.8
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 0,
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      fontSize: "var(--font-size-control)",
      fontWeight: "var(--weight-semibold)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, project.name), project.branch ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 3,
      color: "var(--color-text-tertiary)",
      fontFamily: "var(--font-family-business)",
      fontSize: "var(--font-size-micro)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "git-branch",
    size: 11,
    strokeWidth: 1.8
  }), project.branch) : null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--color-text-tertiary)",
      fontFamily: "var(--font-family-business)",
      fontSize: "var(--font-size-micro)"
    }
  }, project.count)), /*#__PURE__*/React.createElement(IconButton, {
    label: "New task in " + project.name,
    onClick: onNewTask,
    style: {
      width: 26,
      height: 26
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 14
  }))), expanded ? sessions.map(s => /*#__PURE__*/React.createElement(SessionRow, {
    key: s.id,
    title: s.title,
    time: s.time,
    status: s.status,
    running: s.running,
    readOnly: s.readOnly,
    active: activeId === s.id,
    onClick: () => onOpen(s),
    onToggleReadOnly: e => {
      e.stopPropagation();
      onToggleReadOnly(s.id);
    }
  })) : null);
}
function Sidebar({
  collapsed,
  onCollapse,
  onExpand,
  activeId,
  onOpen,
  onNewSession,
  onSettings,
  sessions,
  readOnly,
  onToggleReadOnly
}) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState({
    p1: true,
    p2: true,
    p3: false
  });
  if (collapsed) return /*#__PURE__*/React.createElement(SidebarRail, {
    onExpand: onExpand,
    onNewSession: onNewSession,
    onSettings: onSettings
  });
  const byId = Object.fromEntries(sessions.map(s => [s.id, {
    ...s,
    readOnly: readOnly.includes(s.id)
  }]));
  const filed = new Set(window.PROJECTS.flatMap(p => p.sessions));
  const loose = sessions.filter(t => !filed.has(t.id) && t.title.toLowerCase().includes(search.toLowerCase())).map(t => byId[t.id]);
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 288,
      flex: "0 0 288px",
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-3)",
      padding: "var(--space-2) var(--space-3)",
      background: "transparent",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    label: "Collapse sidebar",
    onClick: onCollapse
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "panel-left",
    size: 14
  })), /*#__PURE__*/React.createElement(BrandLockup, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4
    },
    role: "tablist"
  }, /*#__PURE__*/React.createElement(ModeChip, {
    icon: /*#__PURE__*/React.createElement(Icon, {
      name: "bot",
      size: 14
    }),
    active: true
  }, "Agent mode"), /*#__PURE__*/React.createElement(ModeChip, {
    icon: /*#__PURE__*/React.createElement(Icon, {
      name: "workflow",
      size: 14
    }),
    disabled: true
  }, "Orchestrate")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onNewSession,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      width: "100%",
      height: 32,
      padding: "0 10px",
      border: 0,
      borderRadius: "var(--radius-md)",
      background: "var(--color-accent)",
      color: "var(--color-accent-fg)",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-control)",
      fontWeight: "var(--weight-medium)",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 16
  }), "New task"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      height: 32,
      padding: "0 10px",
      borderRadius: "var(--radius-md)",
      background: "transparent",
      border: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--color-text-tertiary)",
      display: "inline-flex"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 14
  })), /*#__PURE__*/React.createElement("input", {
    value: search,
    onChange: e => setSearch(e.target.value),
    placeholder: "Search",
    style: {
      flex: 1,
      minWidth: 0,
      border: 0,
      background: "transparent",
      outline: "none",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-control)",
      color: "var(--color-text-primary)"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "scroll",
    style: {
      flex: 1,
      marginRight: "calc(-1 * var(--space-3))",
      paddingRight: "var(--space-3)"
    },
    "data-comment-anchor": "8720d653bd-div-74-7"
  }, /*#__PURE__*/React.createElement(NodeHeader, {
    label: "Workspaces",
    addLabel: "New workspace",
    addIcon: "folder-plus"
  }), window.PROJECTS.map(p => {
    const rows = p.sessions.map(id => byId[id]).filter(s => s && s.title.toLowerCase().includes(search.toLowerCase()));
    return /*#__PURE__*/React.createElement(ProjectGroup, {
      key: p.id,
      project: p,
      sessions: rows,
      expanded: open[p.id],
      onToggle: () => setOpen(o => ({
        ...o,
        [p.id]: !o[p.id]
      })),
      activeId: activeId,
      onOpen: onOpen,
      onToggleReadOnly: onToggleReadOnly,
      onNewTask: onNewSession
    });
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      paddingTop: "var(--space-3)"
    }
  }, /*#__PURE__*/React.createElement(NodeHeader, {
    label: "Tasks",
    addLabel: "New task",
    addIcon: "plus",
    onAdd: onNewSession
  }), loose.map(t => /*#__PURE__*/React.createElement(SessionRow, {
    key: t.id,
    title: t.title,
    time: t.time,
    status: t.status,
    running: t.running,
    readOnly: t.readOnly,
    active: activeId === t.id,
    onClick: () => onOpen(t),
    onToggleReadOnly: e => {
      e.stopPropagation();
      onToggleReadOnly(t.id);
    }
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    label: "Archive (planned)",
    disabled: true,
    style: {
      width: 26,
      height: 26
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "archive",
    size: 14
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--font-size-caption)",
      color: "var(--color-text-primary)"
    }
  }, "Archived\uFF080\uFF09")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 26,
      height: 26,
      color: "var(--color-text-secondary)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "gauge",
    size: 14
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 3
    }
  }, [0, 1, 2, 3, 4, 5, 6].map(i => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      width: 10,
      height: 10,
      borderRadius: 2,
      background: i < 5 ? "var(--color-accent)" : "var(--color-bg-hover)"
    }
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 26,
      height: 26,
      borderRadius: "var(--radius-pill)",
      background: "var(--color-bg-muted)",
      color: "var(--color-text-tertiary)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "user",
    size: 14
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: "var(--font-size-caption)",
      color: "var(--color-text-primary)"
    }
  }, "User Name"), /*#__PURE__*/React.createElement(IconButton, {
    label: "Settings",
    onClick: onSettings
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "settings",
    size: 16
  }))));
}
Object.assign(window, {
  Sidebar,
  SidebarRail,
  ProjectGroup
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orbita-desktop/Sidebar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orbita-desktop/data.js
try { (() => {
const SESSIONS = [{
  id: "s1",
  title: "Unify the glass alphas",
  time: "14:22",
  running: true,
  project: "orbita-desktop",
  queries: ["Unify the glass alphas", "One opacity per layer", "Check the dark theme"]
}, {
  id: "s2",
  title: "Collapse tool output by default",
  time: "13:40",
  status: "done",
  project: "orbita-desktop",
  queries: ["Collapse tool output", "Keep thinking on one line"]
}, {
  id: "s3",
  title: "Split styles.css into tokens",
  time: "Aug 21",
  readOnly: true,
  project: "renderer",
  queries: ["Split styles.css", "Move fonts out", "Keep the theme scopes"]
}, {
  id: "s4",
  title: "Home screen lands in Agent mode",
  time: "Aug 21",
  status: "failed",
  project: "renderer"
}, {
  id: "s5",
  title: "Composer keeps its width",
  time: "Aug 20",
  project: "notes"
}, /* no project — these hang off the Tasks node */
{
  id: "s6",
  title: "Name the sidebar hierarchy",
  time: "Aug 19",
  status: "done"
}, {
  id: "s7",
  title: "Check the dark theme contrast",
  time: "Aug 18"
}];
const PROJECTS = [{
  id: "p1",
  name: "orbita-desktop",
  branch: "main",
  count: 12,
  sessions: ["s1", "s2"]
}, {
  id: "p2",
  name: "renderer",
  branch: "feature/glass",
  count: 7,
  sessions: ["s3", "s4"]
}, {
  id: "p3",
  name: "notes",
  count: 3,
  sessions: ["s5"]
}];
const TRANSCRIPT = [{
  kind: "user",
  text: "Collapse tool output by default, and keep the composer the same width on both pages.",
  time: "14:19"
}, {
  kind: "thinking",
  subtitle: "Both pages read --content-max-width, so the box can keep its width…",
  duration: "3.1s",
  detail: "The home composer and the chat composer are the same component. If both read --content-max-width, the transition only needs to move the box, not resize it."
}, {
  kind: "tool",
  name: "read",
  subtitle: "src/renderer/src/styles.css",
  duration: "0.4s",
  icon: "file-text",
  detail: "23470 lines · --content-max-width: 1000px"
}, {
  kind: "tool",
  name: "edit",
  subtitle: "components/app/HomeView.tsx",
  status: "2 hunks",
  duration: "1.2s",
  icon: "pencil-line",
  detail: "+ width: min(100%, var(--content-max-width))"
}, {
  kind: "assistant",
  text: "Tool calls now collapse to one line — the name, its argument, and how long it took. Click any row to read the output.\n\nThe composer reads the same width token on both pages, so sending the first message only moves it: the slogan and session cards fade up, the box glides to the bottom, and nothing resizes."
}, {
  kind: "user",
  text: "Good. Now make the thinking block quiet too.",
  time: "14:22",
  delivery: "steer"
}, {
  kind: "tool",
  name: "bash",
  subtitle: "pnpm -C renderer typecheck",
  tone: "running",
  status: "running",
  icon: "terminal"
}];
const DRAWER_FILES = [{
  name: "styles.css",
  path: "src/renderer/src",
  state: "M",
  added: 128,
  removed: 41
}, {
  name: "HomeView.tsx",
  path: "src/renderer/src/components/app",
  state: "M",
  added: 34,
  removed: 12
}, {
  name: "tokens/glass.css",
  path: "src/renderer/src",
  state: "A",
  added: 22,
  removed: 0
}, {
  name: "AgentSidebar.tsx",
  path: "src/renderer/src/features/agent/components",
  state: "M",
  added: 9,
  removed: 3
}];
Object.assign(window, {
  SESSIONS,
  PROJECTS,
  TRANSCRIPT,
  DRAWER_FILES
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orbita-desktop/data.js", error: String((e && e.message) || e) }); }

__ds_ns.AssistantText = __ds_scope.AssistantText;

__ds_ns.RespondingIndicator = __ds_scope.RespondingIndicator;

__ds_ns.ThinkingCard = __ds_scope.ThinkingCard;

__ds_ns.ToolCard = __ds_scope.ToolCard;

__ds_ns.UserBubble = __ds_scope.UserBubble;

__ds_ns.Composer = __ds_scope.Composer;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Modal = __ds_scope.Modal;

__ds_ns.SelectField = __ds_scope.SelectField;

__ds_ns.TextField = __ds_scope.TextField;

__ds_ns.BrandLockup = __ds_scope.BrandLockup;

__ds_ns.ModeChip = __ds_scope.ModeChip;

__ds_ns.RailButton = __ds_scope.RailButton;

__ds_ns.SessionRow = __ds_scope.SessionRow;

__ds_ns.Chip = __ds_scope.Chip;

__ds_ns.GlassCard = __ds_scope.GlassCard;

__ds_ns.SessionCard = __ds_scope.SessionCard;

})();
