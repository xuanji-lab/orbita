import React from "react";

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
export function GlassCard({ layer = 2, as = "div", padding, radius, children, style, ...rest }) {
  const Tag = as;
  return (
    <Tag
      {...rest}
      style={{
        background: "var(--glass-bg)",
        border: "1px solid var(--glass-border)",
        borderRadius: radius || GLASS_RADIUS,
        boxShadow: "var(--shadow-composer)",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        backdropFilter: "blur(var(--glass-blur))",
        padding,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
