# DOCX fixtures

`docx-security.docx` is a synthetic, deterministic ZIP archive containing only five
OOXML text parts, created locally for these tests. It contains a heading, bold and
italic text, a table cell, a normal HTTPS hyperlink, and a hyperlink whose target is
`javascript:window.__docxXss=1`. It contains no personal data, external images,
macros, or embedded executables. Its XML can be inspected with `unzip -p`.

The test verifies that Mammoth actually emits the unsafe hyperlink before checking
that `parseDOCX` removes its target and preserves the rest of the document.

## Comparison fixtures

The DOCX comparison tests (`npm run test:docx`, `tests/docx/`) use three synthetic,
locally generated DOCX files. They are plain OOXML archives with a single
`word/document.xml` of paragraphs — no images, macros, or personal data.

| File | Contents |
|------|----------|
| `docx-comparison-a.docx` | 46 paragraphs of filler text, used as the "original" side |
| `docx-comparison-b.docx` | Same text with one isolated word replaced and one long paragraph replaced |
| `docx-comparison-short.docx` | Two short paragraphs, shorter than the viewport (cannot scroll) |

A and B differ in four word-level segments (a deleted word, an added word, a
deleted paragraph and an added paragraph), so the change counter must have four
entries, wrap in both directions, and the "changes only" view must keep only
word-boundary context around them.
