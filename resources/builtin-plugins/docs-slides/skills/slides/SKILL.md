---
name: slides
description: How to make good presentations / slide decks / PPT with Orbita's native slides_* tools (slides_create, slides_write, slides_edit, slides_read, slides_insert_image, slides_export). Read it BEFORE the first slides_create / slides_write in a conversation — it has the layout list, the design rules, the theme guide, the free-form element format and the export differences. Use whenever the user wants a presentation, slides, deck, PPT, keynote or talk (演示文稿 / 幻灯片 / PPT / 汇报 / 讲稿). Not for markdown or HTML pages, and not for plain documents (that is the docs skill).
---

# Slides — making a deck that looks designed

The tools and the right-hand panel are built into Orbita; this file is the "how to do it well" part. A deck is one file, `<name>.slides.json` (a list of slides, each a list of positioned elements), with pictures in a sibling `<name>.assets/` folder. The user can edit everything by hand in the panel and export to PDF / PPTX / HTML / PNG.

**Language**: write the slide text in the language the user writes in. Reply in that language too.

## Recommended workflow

1. **Outline first** (in your head or in the reply): one idea per slide; mark the cover, section dividers (decks of 7+ pages) and the closing slide; decide which slides carry the user's picture.
2. **`slides_create`** — pick a theme that fits the topic (see Themes). It creates the file with 0 slides and opens it in the right panel.
3. **`slides_write`** — write several pages in one call, as `layout` + `slots` (see Layouts). Do not place things by coordinates unless no layout fits.
4. **Fix by the warnings** in the `slides_write` result (title too long, too many bullets, text that does not fit, elements outside the canvas): rewrite that slide shorter or split it into two. Never shrink the font or squeeze the box.
5. **After the user edits by hand** (they may have changed anything in the panel), `slides_read` before touching the deck again, then use `slides_edit` for small changes instead of rewriting whole slides.
6. **Export** with `slides_export` when asked (see Export).

## Design rules

A deck made from raw coordinates looks bad — follow these:

1. Use layouts, not coordinates. Give { layout, slots } and the app lays the slide out with the deck's theme (colours, serif headings, eyebrow label, footer "title · page"). Only fall back to raw `elements` for something no layout covers (a diagram, arrows).
2. One idea per slide. Title ≤16 characters (a short claim, not a topic word list). At most 6 bullets, each ≤20 characters — cut words, do not shrink the font. A slide that needs more is two slides.
3. Body text is never smaller than the theme's body size (28px on 16:9). If a warning says the text does not fit, split the slide; never reduce the font or squeeze the box.
4. A slide with a picture AND text always uses image-left / image-right (or image-full). Never place a picture on a bullets slide by coordinates.
5. Rhythm: start with cover, end with closing; in 7+ slides add a section slide between groups; alternate layouts (bullets → image-right → stat → quote → two-column) — never the same layout 4 times in a row. Give every content slide a short `eyebrow` label (e.g. "02 · 景观").
6. Colours and sizes are theme tokens ($ink $muted $accent $accent2 $bg $surface $onAccent $line; $display $title $h2 $body $caption; $heading $body fonts) — write "color":"$accent" instead of hex so a later theme switch re-colours the whole deck. No emoji as decoration, no gradients.
7. Give every slide speaker notes when the user asked for a talk.

## Layouts

`slides_write` takes `slides: [{ at, layout, slots, notes }]`. `at` is a 1-based page number (replaces that slide; page = current count + 1 appends) or "append" (default). Text slots take plain text; **double asterisks** make a phrase bold; lists are string arrays. Picture slots (`slots.image`) take a workspace file path, or "attached" / "attached:2" for a picture the user attached to the chat (the most recent / second most recent); the file is copied into the deck for you — no separate insert step. Slots marked `?` are optional.

- cover — the opening slide: eyebrow? (small label), title (≤16 chars), subtitle?, meta? (author · date). Big serif title on the left, colour-block / circles on the right. Use exactly once, first.
- section — chapter divider on a full colour block: number? ("02"), title, subtitle?. Use between groups of slides in decks of 7+ pages.
- bullets — the default content slide: eyebrow?, title, bullets (3–6 items, ≤20 chars each). One idea per slide.
- two-column — comparison or two parallel lists: eyebrow?, title, columns:[{heading?, bullets? | body?}, {…}] (≤4 bullets per column).
- image-left — picture on the left half, text on the right: eyebrow?, title, bullets? | body?, image (path, or "attached" for the picture the user sent in chat). Always use image-left/right (not free coordinates) when a slide has a picture plus text.
- image-right — same as image-left, picture on the right half.
- image-full — full-bleed picture with a caption card: eyebrow?, title, caption?, image. For a single striking photo.
- table — eyebrow?, title, rows (string[][], first row = header; ≤6 rows, ≤4 columns), note? (source / footnote).
- quote — one big sentence: quote, source? (who said it), eyebrow?. For a key claim, a testimonial or a pull-quote.
- stat — 1–3 big numbers: eyebrow?, title?, stats:[{value:"3.5%", label:"GDP growth", detail?}]. Value ≤6 chars.
- closing — last slide on a dark block: title ("谢谢" / key takeaway), subtitle?, contact? (lines), eyebrow?.

Other `slides_write` entry fields: `notes` = speaker notes (plain text); `background` = css colour or a `$token` ($surface, $accent …); `elements` = free-form (below), mutually exclusive with `layout`. Omit `layout` and `elements` to keep a slide's elements and only change `background` / `notes`.

A layout becomes ordinary editable elements (the user can drag them). Replace a slide by writing at its page number again.

## Themes

Pass `theme` to `slides_create` (default ink); the user can change it later in the panel. Each theme is a palette + fonts + type scale:

- forest — deep green with orange — bold, editorial, great for keynotes and culture / travel topics
- ink — warm off-white with ink black and terracotta — calm, book-like, safe default for reports and essays
- mono — pure white, black type, red accent — maximum contrast, for pitches, design and tech talks
- academic — cool blue-grey with serif headings — papers, lectures, data-heavy talks
- warm — cream paper with caramel and wine — food, lifestyle, storytelling, education
- night — midnight blue with warm yellow — product launches, tech, evening talks

Switching later: `slides_edit` with `{ op:"set_deck", theme:"mono" }` re-colours every element bound to a theme token (hand-set values stay).

## slides_edit operations

`ops` is a list applied in order; `slide` = 1-based page, `id` = element id from `slides_read`. The panel is not moved (the user may be looking at another slide).

- `{ op:"patch", slide, id, patch:{...} }` — change fields of one element, e.g. `patch:{ html:"新标题" }` or `patch:{ x:100, w:500 }`; `id` and `kind` cannot change.
- `{ op:"add", slide, element:{...} }` — add one element.
- `{ op:"delete", slide, id }` — remove an element.
- `{ op:"set_slide", slide, background?, notes? }`
- `{ op:"delete_slide", slide }` and `{ op:"move_slide", slide, to }`
- `{ op:"set_deck", title?, aspect?, theme? }` — `theme` is one of the theme ids above, or an object `{ id?, palette:{bg,surface,ink,muted,accent,accent2}, fonts:{heading,body}, scale:{display,title,h2,body,caption} }`.

In a themed deck write new text with theme tokens (fontSize "$body", color "$ink"); body text must not be smaller than `$body`, and a footnote / source line uses `$caption` and stays above the page footer.

## Free-form elements (only when no layout covers it)

Used in `slides_write` `elements` and in `slides_edit` `add` / `patch`. Canvas coordinates: 16:9 = 1280×720, 4:3 = 960×720 (px, origin top-left). Every element has id (optional, auto-generated), x, y, w, h, rotate (optional, deg). Kinds:

- text: { kind:"text", html, fontSize (px, default 28), color ("#rrggbb"), align left|center|right, valign top|middle|bottom, fontFamily? }. html allows only `<b> <i> <u> <br> <ul><li> <ol><li>` and `<span style="color:#...;font-size:NNpx">`; plain "text" is accepted instead of html. Everything else is stripped.
- image: { kind:"image", src:"<name>.assets/x.png", fit: contain|cover } — only reference files already in the assets folder; to add a picture use `slides_insert_image`.
- table: { kind:"table", rows:[["head1","head2"],["a","b"]], header:true, fontSize, colWidths?:[0.4,0.6], headerFill, headerColor, borderColor, color }
- shape: { kind:"shape", shape: rect|roundRect|ellipse|triangle, fill:"#rrggbb"|"none", stroke:"#rrggbb"|"none", strokeWidth, text?, fontSize, color }
- line / arrow: { kind:"line", points:[[x1,y1],[x2,y2]] (relative to the element box), startArrow:"none"|"arrow", endArrow:"none"|"arrow", stroke, strokeWidth, dash? } — the box x,y,w,h must contain both points (e.g. left→right arrow: x=100,y=300,w=400,h=1, points [[0,0],[400,0]], endArrow "arrow").

## Pictures

- Inside a layout: put the path (or "attached") in `slots.image` of image-left / image-right / image-full.
- Anywhere else: `slides_insert_image` (PNG / JPEG / GIF / WebP, ≤30 MB; a workspace file or "attached" / "attached:N"). It copies the file into `<name>.assets/` and adds an image element; size and position default to a centred box at the picture's own aspect ratio (≤ half the canvas). Pass w / h / x / y (px) to place it exactly, `fit` contain|cover.
- The user's attached picture has no path you can see; always use "attached" for it, never invent a path.

## Export

`slides_export` writes next to the deck (or to `out`) and returns the path:

- `pdf` — one page per slide.
- `html` — a single self-contained file with page turning, images inlined.
- `png` — one slide at 2× resolution; give `page` (default 1).
- `pptx` — PowerPoint, fonts kept as set.
- `pptx-basic` — PowerPoint with every font mapped to Arial / Microsoft YaHei, so it displays the same on any machine. Prefer it when the deck will be opened on another computer.
