# Source Connectors

Use the best available structured reader before browser screenshots. Enumerate pagination, cursors, child blocks, embeds, and attachments until exhausted.

## Routing Order

1. Native structured API or installed connector.
2. Original downloadable file or media URL.
3. Site adapter, network response, or DOM resource URL.
4. Element screenshot.
5. Whole-page screenshot as a last resort.

For media, prefer:

```text
original media > API/network URL > DOM media URL > element screenshot > page screenshot
```

Record the chosen method and failures in `extraction/media-manifest.yaml`.

## Craft

Use Craft MCP document discovery and block reads:

- Resolve the document or shared link.
- Read all blocks in structured form and follow every cursor.
- Fetch images with the image-view capability.
- For whiteboards, fetch whiteboard elements rather than relying on a thumbnail.
- Traverse linked child documents, collections, cards, and attachments when they carry source content.

Preserve block IDs or equivalent source anchors so claims and images remain traceable. If tools are deferred, discover the Craft read tools first.

## Feishu / Lark

Read the relevant `lark-*` Skill before using Lark tooling.

- Fetch the document with full detail, not a summary view.
- Preview or download media at original quality.
- Follow synced blocks and embedded documents.
- Continue into whiteboards, Sheets, Base, Notes, Wiki pages, and attachments when embedded.
- Preserve block IDs, document tokens, and source hierarchy.

Images embedded in Lark documents are evidence, not decoration by default. Inspect them visually after download or preview.

## Web Pages and Other Systems

- Prefer an official or site-specific adapter when available.
- Use OpenCLI/browser network and DOM access to locate original resources.
- Expand lazy-loaded sections, tabs, code blocks, and pagination.
- Download original images and attachments where permitted.
- Capture screenshots only when the original resource cannot be obtained.

Do not treat rendered page text as complete until hidden sections, footnotes, captions, and linked supplements have been checked.

## Local and Office Files

Use the corresponding bundled Skill:

- PDF: `pdf:pdf`
- Word and general documents: `documents:documents`
- PowerPoint: `presentations:Presentations`
- Spreadsheets: `spreadsheets:Spreadsheets`

For PDF and slide decks, render pages/slides and inspect diagrams and screenshots in addition to extracting text. For spreadsheets, inspect formulas, units, headers, hidden assumptions, and charts. For archives, inventory contents before selecting readers.

## Image and Video Evidence

Use visual inspection for every potentially load-bearing image. For videos, inspect relevant keyframes and available captions/transcripts; do not imply full viewing if only a subset was inspected.

For each media item record:

- Stable ID and source anchor
- Original URL or file
- Local copy or preview
- Type and dimensions when known
- Importance: `load-bearing`, `supporting`, `decorative`
- Read status: `complete`, `partial`, `unreadable`
- Confidence: `high`, `medium`, `low`
- Proposed knowledge destination

If OCR is used, distinguish OCR text from visual interpretation and verify critical labels manually.
