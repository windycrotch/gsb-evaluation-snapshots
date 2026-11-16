# trend-scan

## Scripted, reproducible scan

This skill ships an executable implementation in addition to the manual prompt.
All code uses the Python standard library only.

```text
skills/trend-scan/
├── SKILL.md
├── scan.py                  # CLI entry point: python scan.py ...
├── adapters.py              # SearchAdapter interface + ScrapeAtlasCLIAdapter (production)
├── models.py                # normalized page/request/result data classes
├── platforms.py             # which platform supports keyword / hashtag search
├── scan_engine.py           # orchestration: skips, failures, pagination, coverage
├── report.py                # Markdown rendering
└── tests/
    ├── fakes.py             # ScriptedFakeAdapter / fixture loader (test-only)
    ├── fixtures/            # local fake response bodies (test data, not production)
    └── test_scan.py         # automated tests, stdlib unittest only
```

### Interface contract

Both the production adapter and the test fake implement the same interface
(`adapters.SearchAdapter`):

```python
fetch_page(request: PageRequest) -> PageResult
```

- `models.PageRequest` carries platform, normalized query, query kind
  (`keyword`/`hashtag`), time window, page number and an opaque cursor.
- `models.PageResult` carries posts (already normalized), status, coverage
  flags, failure code/warnings, the raw next cursor (any type), credits and
  the cursor field name the endpoint used.

The production adapter is `adapters.ScrapeAtlasCLIAdapter`, which shells out to
the real `scrapeatlas` CLI (installed and authenticated per the
`scrapeatlas-setup` skill). The fake adapter lives under `tests/` and only
loads local fixture data. It is never imported by the production engine or CLI
— fake data cannot reach the production path.

### Run

```bash
# production, real ScrapeAtlas CLI
python skills/trend-scan/scan.py \
  --query "home espresso" --platforms tiktok,youtube,reddit,threads \
  --window-days 7 --max-pages 1

# hashtag mode (forces hashtag tools where available)
python skills/trend-scan/scan.py --query "#espresso" --hashtag \
  --platforms tiktok,facebook --max-pages 3 --out report.md

# list the platform capability table
python skills/trend-scan/scan.py --list-platforms
```

### Tests

```bash
python -I -m unittest discover -s skills/trend-scan/tests -v
```

The tests cover: normal multi-platform scans, no-tool platforms
(Instagram/X/Bluesky), failure codes and partial coverage, missing cursors,
page-limit stops, cross-platform themes, repeat accounts and CLI rendering.
