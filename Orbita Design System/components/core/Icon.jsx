import React from "react";

const CACHE = new Map();

/**
 * Inlines a Lucide SVG copied into assets/icons/lucide so it inherits
 * currentColor and the app's stroke weight.
 */
export function Icon({ name, size = 16, strokeWidth = 2, base, style, ...rest }) {
  const root = base || (typeof window !== "undefined" && window.ORBITA_ICON_BASE) || "assets/icons/lucide";
  const url = `${root}/${name}.svg`;
  const [markup, setMarkup] = React.useState(() => CACHE.get(url) || "");
  React.useEffect(() => {
    if (CACHE.has(url)) { setMarkup(CACHE.get(url)); return; }
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => {
        const cleaned = text.replace(/<\?xml[^>]*\?>/, "").trim();
        CACHE.set(url, cleaned);
        if (alive) setMarkup(cleaned);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [url]);
  return (
    <span
      aria-hidden="true"
      {...rest}
      style={{
        display: "inline-flex",
        flex: "0 0 auto",
        width: size,
        height: size,
        lineHeight: 0,
        ["--icon-stroke"]: strokeWidth,
        ...style,
      }}
      ref={(node) => {
        if (!node || !markup) return;
        node.innerHTML = markup;
        const svg = node.firstElementChild;
        if (svg) {
          svg.setAttribute("width", size);
          svg.setAttribute("height", size);
          svg.setAttribute("stroke-width", strokeWidth);
        }
      }}
    />
  );
}
