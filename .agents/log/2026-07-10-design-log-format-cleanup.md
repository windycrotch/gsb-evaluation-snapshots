---
title: Design log format cleanup
date: 2026-07-10
status: done
related_paths:
  - .agents/log/
---

## Background

The existing design log predated the current `design-log` skill format. It had useful decision records, but they were stored as numbered markdown files without an `index.md` or entry frontmatter.

## Problem

Future recall depends on a predictable index, date-based entry names, status metadata, and searchable `related_paths`. The old shape made it harder for agents to find and respect prior decisions before editing related code.

## Decision

Keep the historical decision text intact, but normalize the log structure:

- use a minimal `index.md` table with `Date`, `Name`, and `Status`
- rename numbered entries to `YYYY-MM-DD-slug.md`
- add entry frontmatter with `title`, `date`, `status`, and `related_paths`
- mark migrated historical entries as `done`

## Tradeoffs & Alternatives

The cleanup does not rewrite old implementation details that may have drifted from the current code. Those notes remain historical context; newer entries and current code win when they conflict.

## Verification

- [x] `index.md` links every entry in `.agents/log/`
- [x] each entry has design-log frontmatter
- [x] app source files are unchanged

## Implementation Notes

2026-07-10 - Migrated the existing log into the current design-log structure and added this entry to explain the cleanup.
