---
name: zotero
description: How to use the user's Zotero library with Orbita's read-only zotero_search, zotero_item and zotero_fulltext tools (they read Zotero's data directly; Zotero need not be running) — how search matches words, collections, annotations, full text vs the PDF, quoting a Zotero PDF with read_pdf / cite_pdf without copying it, and what to tell the user when the library cannot be found or read. Read it BEFORE the first zotero_* call in a conversation. Use when the user mentions Zotero, their library, references, a paper they saved, their highlights / annotations, or asks to find / read / quote a paper they have (文献 / 文献库 / 参考文献 / 论文 / 批注 / 高亮 / Zotero). Not for papers that are only plain files in the workspace (use read_pdf), and not for adding or changing anything in Zotero — these tools cannot write.
---

# Zotero (read-only)

The user's literature lives in Zotero: items, PDFs, Zotero's full-text index and their annotations. Orbita reads Zotero's data directory on this computer directly, so **Zotero does not need to be running** (when it is open you see what it has saved so far). Orbita keeps no copy: no .bib, no copied PDF, no .txt. These tools only read; they cannot add items, notes, tags or annotations, and nothing in Zotero's folder is ever written.

## When the library cannot be read

Every tool fails with one sentence that names the case. Relay it in the user's language, plainly:

- **Zotero not found** — there is no Zotero data directory with `zotero.sqlite`. Orbita looks where Zotero keeps it: the data directory set in Zotero › Settings › Advanced › Files and Folders (设置 › 高级 › 文件和文件夹 › 数据目录位置), otherwise the default `~/Zotero`. Ask whether they use Zotero and where their data directory is.
- **Database newer than Orbita knows** — Zotero was updated past what Orbita has checked; Orbita does not guess at an unknown database. Say so; Orbita needs an update.
- **Database too old** — Zotero 6 or earlier; updating Zotero and opening it once upgrades it.

Do not retry in a loop. Never touch Zotero's files or settings yourself, and never start or quit Zotero.

## zotero_search

- Every word in `query` must match somewhere in the title, a creator, the year or the publication (words are ANDed; case and accents are ignored). Fewer words find more; wrap a phrase in double quotes to match it as one word.
- Chinese titles have no spaces, so a Chinese phrase is one word: use a short distinctive part (`城市智能体`, not the whole title). For a Chinese author try the full name (`张三`) and then the surname alone.
- `collection` takes a name (case-insensitive; a path tail such as `第二章` works) or a key. If a name is ambiguous the tool lists candidates with keys — pick one and pass its key. Only items placed directly in that collection count, not those in its subcollections (Zotero's default view).
- `item_type` (journalArticle, book, thesis, conferencePaper …) and `tag` narrow the list. Only top-level items are searched: attachments, notes and annotations of an item, standalone notes and the trash are left out. Group libraries are included.
- Default 20 results per call, at most 50 (`limit`); the reply states the total. More: pass `offset`. Newest-modified first.
- Each line: `key · title · creators · year · type · PDF`. "PDF" means the best attachment is a PDF.

## zotero_item

Give the 8-character `key`. You get the metadata fields, abstract, collections as paths (`博士论文 / 第二章`), tags, attachments and annotations.

- **Attachments** come with their absolute path inside Zotero's storage (or wherever a linked file sits). "not on this machine" means Zotero lists the file but it is missing here (not synced to this computer) — say so instead of trying to read it.
- The reply also gives the item's canonical Zotero URI (`http://zotero.org/users/…/items/KEY`); it identifies the item for Word / citation tools later.
- **Annotations** are the user's own highlights and comments, in page order: page label, type, colour, highlighted text, comment. 30 per call; pass `annotation_offset` for the next page. They are a strong signal of what the user cared about — use them when summarising or comparing papers.
- Child notes are counted, not shown.

## zotero_fulltext

The text Zotero extracted from the item's PDF (or EPUB / web snapshot) when it indexed it, by character range: default 20,000 characters, at most 40,000 (`length`); continue with `start`. Use it to find where something is discussed and to skim. If Zotero never indexed the item, the tool says so and gives the PDF path — then use `read_pdf` on that path.

## Quoting and reading a Zotero PDF

Zotero extracts the full text with pdf.js, the same engine `cite_pdf` uses, so text copied from `zotero_fulltext` verifies just as well as text copied from `read_pdf` (tested on 6 papers × 15 sentences: the only failures in either source were sentences that ran across a page break). Quote straight from the full text:

1. Find the passage with `zotero_fulltext` (or from an annotation).
2. Copy the exact sentence and verify it with `cite_pdf` on the same path the tool gave (the PDF in Zotero's storage). The citation marker opens the PDF in place in the Files panel.
3. **Keep each quote within one page.** Pages in the full text are separated by a form-feed character, usually next to a page number or running header; a quote that runs across one is NOT CITED. Split a sentence that crosses a page into two quotes, one per page, and cite each.
4. Use `read_pdf` on the same path when the passage lies beyond the pages Zotero indexed (the reply says how many pages the index covers), when you need a figure or table, or when the item has no full text. A scanned PDF usually has no full text at all (there was no text layer to extract): read its pages as images with `read_pdf` instead of quoting.

Never copy, move or rename a Zotero PDF, and never write into Zotero's storage folder. If the user wants notes about a paper, write them in a document in the workspace (mention the Zotero item key in it).
