---
name: reading
description: How to read PDF and Word files well with Orbita's native read_pdf, cite_pdf and read_docx tools — the figure/table index, image_pages vs images=true, crop in pixels, scanned PDFs, models without vision, Word block numbers / outline / comments / images, and how to quote a PDF so the user can click through to the highlighted original. Read it when a question goes beyond plain text — a figure, table, chart or page layout in a PDF; a scanned PDF; a long Word document you must jump around in; or the user asks you to quote / cite / show the original wording of a PDF (原文 / 引用 / 出处 / 图 3 / 表 2). For any .pdf use read_pdf and for any .docx use read_docx, never read — read only produces garbage for them; this skill is for the details. Not for plain text, markdown or image files (use read).
---

# Reading PDF and Word files

`read_pdf`, `cite_pdf` and `read_docx` are built into Orbita and read the file directly from disk (workspace, attached directory, or an absolute path). This file is the "how to use them well" part.

**Never use `read` on a `.pdf` or `.docx`** — it returns compressed binary as text. A legacy `.doc` is not supported: ask the user to save it as `.docx`. If a user-attached file list names a PDF or Word file, call the matching tool straight away. Do not fall back to `bash` + Python/pymupdf/PIL to crop or re-render pages: `image_pages` and `crop` below do that, and giant self-made images flood the context.

## read_pdf

Default call: text of pages 1–20 (`offset` = first page, 1-indexed; `limit` = how many pages, max 20). The result starts with a header line that tells you:

- total pages and the range shown, and `Use offset=N to continue.` when there are more pages — keep reading with that offset for a full read (a long paper is several calls);
- **Pages with little text** (fewer than 80 characters on the page) — likely full-page figures or blank pages;
- **Figures and tables**: an index `Figure 3 p.7; Table 2 p.5; …` built from caption lines that start with Figure / Fig. / Table / 图 / 表 plus a number (first occurrence of each number, at most 15 entries, sorted by page). Sentences that merely mention "Figure 3" are not indexed. A long document may have more captions than the index lists; if the one you need is missing, read the pages where it likely sits and look for its caption.

Text mode only sees characters. Charts, plots, diagrams and scanned pages are invisible to it. So:

### Looking at a figure or table (needs a vision model)

1. Read the text first for the overall picture (or skip it if the user only asked about one figure).
2. Find the page in the figures index, then call again with `image_pages: "7"`. Syntax: `"3"`, `"2-5"`, `"1,4"` — absolute page numbers, at most 5 pages per call, ascending, duplicates removed. A bad spec returns an error with the valid range; fix it and retry.
3. The page comes back as an image after the text, rendered 2000 px wide (width can be 600–2000, values outside are clamped). The header reports each image's exact size.
4. **`image_pages` does not shrink the text range**: the text of `offset…offset+limit-1` (default 20 pages) is still returned. To look at page 7 without re-reading 20 pages of text, pair it with `offset: 7, limit: 1`.
5. **Close-up with `crop`** (only together with `image_pages`): `crop: "x1,y1,x2,y2"` in **pixels on the page image you already saw** — left-top origin, `x2` ≤ the image width reported in the header, `y` is clamped to the page height. Look at the whole page first, then crop the figure; the region is rendered at the full `width`, so a small figure becomes sharp without costing more tokens. Never guess crop coordinates before you have seen the page.

**`images: true`** is the other mode: it renders every page of the current text range (default 1080 px wide) — use it only for browsing a few pages whose layout matters, not for a particular figure; because of image cost the text range is also capped at 5 pages in this mode. Prefer `image_pages` for anything targeted. One page image costs roughly 1–1.5k tokens.

### Scanned PDFs and models without vision

- A PDF with no text layer (under 50 characters in total) on a vision model is **rendered as page images automatically** (5 pages per call, 2000 px; continue with `offset`). Read the text from the images yourself.
- On a model without vision, a scanned PDF is an error ("has no text layer") — tell the user plainly that you cannot read it, do not pretend the document is empty. In a mixed document, pages without a text layer are marked `[page N has no text layer]`.
- On a model without vision, `images: true` / `image_pages` degrade to text only with a note that images were omitted. Say so when the answer depends on a figure.
- A password-protected PDF is an error; ask the user for an unlocked copy. A file that is not a PDF (checked by its header, not its extension) is an error pointing at `read`.

## cite_pdf — quote the original so the user can click through

`cite_pdf` is an experimental feature ("PDF citations" in settings); when it is off the tool does not exist, so just quote the passage in your reply instead. When it is on, use it whenever you explain or summarise a PDF and a statement relies on specific wording in the document, or the user asks for the original text / the source of a claim.

1. Read the PDF with `read_pdf` first, then call `cite_pdf` with `path` and `quotes: [{ text, page? }, …]` — up to 12 quotes per call, so batch everything one answer needs.
2. `text` must be **the original wording copied from the `read_pdf` output**, a sentence or phrase of at least 4 letters/digits — not a paraphrase, not a translation, not text from memory. Line breaks, spacing, punctuation, hyphenation at line ends and ligatures do not matter. `page` is only a hint; the tool searches the whole document.
3. Each verified quote returns a marker like `[^c4k2]`. Put it **exactly as written** right after the sentence it supports, e.g. `…uses double buffering[^c4k2].` The user clicks it and the PDF opens at that passage, highlighted. Do not also paste the quoted text into your reply — the marker already shows it.
4. Read the notes after each marker: `found on page N, not M` (fine), `appears K times; cited the one on page N` (pick a longer, more specific quote if you meant another occurrence), and `approximate match — the PDF actually reads: "…"` (the beginning and end of your quote matched but the middle differs; make sure your sentence fits the real wording, or fix the quote).
5. A quote marked **NOT CITED** — too short, or not found (the result shows the closest passage on the PDF) — has no marker. Fix the quote from the closest passage, or drop the claim, and call again. Never invent a marker or cite from memory.
6. A scanned PDF cannot be cited (no text layer); describe the page instead.

## read_docx

Word documents have no pages; the unit is the **block** (a heading, paragraph, table, or list each count as one). The result is markdown: headings as `#`, lists, tables, links, footnotes.

- The header gives the title, total blocks and characters, and **Sections: Heading (block N); …** (at most 15 headings). Jump to a section with `offset: N`. `limit` caps the number of blocks.
- A call returns up to about 30,000 characters; it stops at a block boundary and says `Use offset=N to continue.` — keep going with that offset for a full read.
- **Comments** (review notes) are marked in the text with superscript anchors such as `[Z1]` and listed at the end of the output; tracked changes are read as accepted. Headers and footers are not read.
- **Images** appear as `[image N: alt text]` placeholders. Pass `images: true` to receive the images in the current block range as pictures (vision models only, at most 6 per call — narrow `offset`/`limit` to see the rest; only png/jpg/gif/webp are inlined, others are skipped with a note). Do it only when the answer depends on a picture.
- An encrypted `.docx` is an error (ask the user to remove the password); an empty document says so.
