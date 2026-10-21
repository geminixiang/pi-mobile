# How open-source chat apps handle attachments

Research for pi-mobile's file attachments (no sandbox). Read from source, shallow clones of 2026-10-21:

- Chatbox `chatboxai/chatbox` @ `0ac6385`: Electron desktop plus a **Capacitor Android/iOS app** (closest to pi-mobile)
- LobeChat `lobehub/lobe-chat` @ `9cdbc934`: web app with a server
- Cherry Studio `CherryHQ/cherry-studio` @ `843a297`: Electron desktop

## ChatGPT and Claude

Neither publishes its implementation; this is what their help centers say, plus system prompts people have extracted
(marked as such: not authenticated, and possibly out of date).

**Formats.** ChatGPT: pdf, docx, txt, xlsx/xls/csv/tsv, pptx, images
([help](https://help.openai.com/en/articles/8555545-uploading-files-and-audio-to-chatgpt)). Claude: pdf, docx, csv,
txt, html, odt, rtf, epub, json, xlsx, images; **xlsx only with code execution on**
([help](https://support.claude.com/en/articles/8241126-upload-files-to-claude)).

**Documents: some text in context, the rest searched.** ChatGPT Enterprise puts a document's full text in context up to
110,000 tokens in total; past that, the first 110,000 and a private search index for the rest, with context split
across several files ([help](https://help.openai.com/en/articles/10029836-optimizing-file-uploads-in-chatgpt-enterprise)).
Extracted prompts show the search as a tool, `msearch(queries)` over the conversation's files, told to use it when
the content already in context is not enough
([extracted prompt](https://sawradip.medium.com/chatgpt-system-prompts-analysis-how-openai-llms-use-persistent-memory-tool-usage-code-e6022cd8c2ea)).
Claude's extracted prompt puts each file in `<document><source>name</source><document_content>…</document_content></document>`,
leaving `document_content` out for large files, which the model then reads with code
([extracted prompt](https://huggingface.co/datasets/Nymbo/Official_LLM_System_Prompts/blob/main/Claude%205.06.2025.md)).

**PDFs: page images as well as text.** Claude: up to 100 pages, each page's text and an image of the page (charts,
layout); 101 to 1,000 pages text only; over 1,000 refused
([help](https://support.claude.com/en/articles/8241126-upload-files-to-claude),
[API docs](https://platform.claude.com/docs/en/build-with-claude/pdf-support): 1,500 to 3,000 text tokens a page,
plus the image). ChatGPT reads images embedded in PDFs (Enterprise only) by extracting them, not by rendering every
page ([FAQ](https://help.openai.com/en/articles/10416312-visual-retrieval-with-pdfs-faq)). Other documents (docx …)
are text only in both.

**Spreadsheets: code, not text.** ChatGPT analyses csv/xlsx with Python on the files in `/mnt/data`
([help](https://help.openai.com/en/articles/8437071-data-analysis-with-chatgpt)); Claude needs code execution for
xlsx and finds uploads under `/mnt/user-data/uploads`
([system prompt](https://platform.claude.com/docs/en/release-notes/system-prompts/claude-opus-4-8)). Tables are
computed over, not read.

## Where the text comes from

| App | Where it parses | Formats | Libraries |
|---|---|---|---|
| Chatbox mobile | In the WebView (`src/renderer/platform/mobile_platform.ts` → `web_platform_utils.ts`) | Text/code by extension, PDF | `pdfjs-dist` (`src/renderer/packages/pdf-parser.ts`) |
| Chatbox desktop | Main process (`src/main/file-parser.ts`) | + docx/pptx/xlsx/odt, epub | `officeparser` 5, `epub` |
| Chatbox fallback | Their cloud parser when local parsing fails or is empty (`src/renderer/stores/sessionHelpers.ts` `fallbackToChatboxAIParser`) | anything | paid service |
| LobeChat | Server (`packages/file-loaders`) | pdf, doc, docx, pptx, xlsx, ipynb, text | `pdfjs-dist`, `mammoth`, `officeparser`, `word-extractor`, SheetJS `xlsx` from cdn.sheetjs.com |
| Cherry Studio | Main process (`src/main/ai/messages/attachmentTextExtraction.ts`) | pdf, doc, docx/pptx/xlsx/od*, text with encoding detection | own PDF util, `word-extractor`, `officeparser` |

Chatbox's mobile app, the one that is a WebView like ours, does **text and PDF only**. Office files need its desktop
build or its cloud parser.

## How the text reaches the model

All three turn the file into text and put it **inside the user message**, then deal with size the same way: inline
when it fits, otherwise a preview plus a tool to read the rest.

| App | Inline up to | Bigger: preview | Tool for the rest |
|---|---|---|---|
| Chatbox | 500 lines (`src/shared/context/builder.ts` `MAX_INLINE_FILE_LINES`) | first 100 lines | `read_file(fileKey, lineOffset, maxLines=200)`, `search_file_content(fileKey, query, context, maxResults=10)` (`src/renderer/packages/model-calls/toolsets/file.ts`) |
| LobeChat | 100,000 characters (`packages/prompts/src/prompts/files/file.ts` `FILE_INLINE_MAX_CHARS`) | first 4,000 characters | `readAttachment(fileId, offset, limit)`, at most ~10k characters per call (`packages/builtin-tool-attachments/src/manifest.ts`, `packages/prompts/src/textWindow`) |
| Cherry Studio | a per-request budget split across files (`attachmentBudget.ts` `allocateInlineCaps`) | the head | `read_file` with a handle (`src/main/ai/messages/attachmentRouting.ts`) |

Details worth copying:

- **Wrapped with metadata.** Chatbox writes `<ATTACHMENT_FILE>` with index, name, key, line count, size, then
  `<FILE_CONTENT>`, and a `<TRUNCATED>` note that names the exact tool call to continue. LobeChat's notice also names
  the next call (`call readAttachment with fileId="…" and offset=…`), and only when the tool is actually offered.
- **Why the cap matters**, from LobeChat's comment on `FILE_INLINE_MAX_CHARS`: parsed spreadsheets, CSVs and logs can
  be 100+ MiB of text; history re-sends attachments every turn, so one oversized file makes every later request in
  the conversation fail, and compaction cannot help because the latest user message is always kept whole.
- **Always some content inline.** Cherry Studio inlines at least the head even when a tool exists, "so visibility
  never depends on the model choosing to call `read_file`; weak and non-tool models see it too".
- **Pages marked.** Chatbox's PDF text has `==== Page N ====` between pages, which lets the model cite pages.
- **Scanned PDFs.** Cherry Studio tells the model "No extractable text found … may be a scanned or image-only
  document" instead of sending nothing. Chatbox falls back to its cloud parser.
- **Read-only tool, separate from search.** LobeChat keeps `readAttachment` apart from its knowledge-base tool on
  purpose: enabling the knowledge base for one large file also exposed search and write/delete.

## Native files instead of text

Cherry Studio sends a PDF to the provider as a file when the provider/model takes PDFs (Anthropic, Gemini, OpenAI),
and only extracts text otherwise (`src/main/ai/runtime/aiSdk/params/nativeFileSupport.ts`,
`attachmentRouting.ts`); an unknown third-party provider does not get native PDF.

pi-ai's user content is `string | (TextContent | ImageContent)[]` (`@earendil-works/pi-ai` `dist/types.d.ts`), with
no document part. Native PDF would need pi-ai to add one; until then, text plus page images is what every provider
can take.

## Libraries for the WebView

- `pdfjs-dist` 6.4.299: what Chatbox mobile uses; text per page, and page rendering for scans.
- `officeparser` 8.2.0 now ships browser builds (`exports` `browser`, `./slim`) and parses docx, pptx, xlsx, odt/ods/odp,
  pdf, rtf, epub, csv, html, md into an AST with Markdown/CSV output. Each browser bundle is about 5.5 MB (it also
  generates documents and bundles tesseract.js for OCR), so it would be a lazy chunk.
- `mammoth` 1.13.0: docx to HTML/Markdown only.
- SheetJS `xlsx`: the npm package is stale; current versions install from cdn.sheetjs.com (LobeChat does so).
- `read-excel-file` 9.3.12: xlsx to rows only, on `fflate` and a SAX parser; maintained on npm.
