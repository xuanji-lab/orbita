---
name: docs
description: How to work on documents (.md / .markdown / .txt) with Orbita's native doc_* tools (doc_open, doc_insert_image, doc_export) and the Files panel — which Obsidian syntax the panel renders, where inserted images go, what each export format converts. Read it BEFORE the first doc_open / doc_insert_image / doc_export in a conversation. Use when the user asks to open, show, write, edit or polish a markdown document or note, add a callout / picture to it, or export it to Word / PDF / plain markdown (文档 / 笔记 / 周报 / 导出 Word / 导出 PDF). Not for presentations (that is the slides skill).
---

# Docs — editing a document the panel shows live

The tools and the Files panel on the right are built into Orbita; this file is the "how to do it well" part. A document is a plain `.md` / `.markdown` / `.txt` file inside the workspace (or an attached directory) — the file is the real thing; the panel renders it and follows your edits live.

**Language**: write in the language the user writes in. Reply in that language too.

## Workflow for editing a document

1. **`doc_open`** the file (relative to the workspace, or absolute inside it). It opens the file in the Files panel and returns the outline (headings with line numbers, first 40). Use it whenever the user asks to open / show / work on a document, before editing. `create:true` makes a new empty document if the path does not exist (it never overwrites; plan mode does not create files).
2. **`read`** the part you need (the outline's line numbers tell you where), then change it with the normal **`edit`** / **`write`** tools. The panel updates live as the file changes; the user can keep reading or editing in it.
3. Pictures: **`doc_insert_image`** (see below) — do not hand-write image paths.
4. Export when asked: **`doc_export`** (see below).

Keep edits small and targeted: the user may be editing the same file; if a tool says the document keeps changing underneath, try again in a moment.

## Obsidian syntax the panel understands

The panel renders Obsidian-flavoured markdown: `[[wikilinks]]`, `![[image.png]]` embeds, `> [!warning]` callouts (`> [!tip]-` is collapsible), `==highlight==`, `#tags`, YAML frontmatter, task lists, tables, `$math$`.

**Write plain markdown unless the user's notes already use that syntax.** If the document (or its vault) has wikilinks, callouts, `==highlights==` or frontmatter, match that style; if it does not, use ordinary headings, lists, tables, blockquotes and `![](path)` images so it reads correctly everywhere. A callout is the right tool when the user asks for one ("add a risk box" → `> [!warning] 风险提醒` followed by the lines of the box, each starting with `> `).

## doc_insert_image

Copies a picture into the document's attachments folder and inserts the reference as its own paragraph (blank line before and after).

- Attachments folder: the vault's `attachmentFolderPath` from `.obsidian/app.json` when present, else `attachments/`.
- Reference written: `![[name.png]]` in an Obsidian vault, `![](attachments/name.png)` otherwise.
- The image must be a png / jpg / gif / webp / svg / bmp / avif file ≤ 25 MB, inside the workspace (or an attached directory) — copy it there first if it is elsewhere.
- `after_line`: insert after this 1-based line (0 = right after the frontmatter / at the top). Default: end of the document. It cannot point inside the frontmatter.

## doc_export

Writes next to the document by default (`out` must stay inside the workspace and end with the format's extension) and returns the path.

- `docx` → `<name>.docx` (Word): headings, lists, tables, images, code are kept; callouts become quote blocks with a coloured bar; wikilinks become plain text; ==highlights== get a shading.
- `pdf` → `<name>.pdf`: rendered with the reading view's page style, images inlined.
- `md` → `<name> 副本.md`: a copy of the markdown as is.
- `md-plain` → `<name> (通用).md`: a universal markdown — Obsidian syntax is converted: wikilinks to text, callouts to quotes, embeds to `![](path)`, `==x==` to `<mark>`. Use it when the file is going somewhere that is not Obsidian.
