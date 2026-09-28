# Raw Strategy Screen Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an immutable VPS `raw.jsonl` strategy-screen run into a bounded, causal data-quality and lead/lag report without reading credentials, placing orders, or modifying the source run.

**Architecture:** A pure reducer validates rows and constructs only three-snapshot, same-market pairs: external return from `t-h` to `t`, then Polymarket midpoint change from `t` to `t+h`. A streaming CLI reads the source file line-by-line, tracks coverage and gaps, and creates a new report with `wx`; invalid/missing data is counted rather than skipped.

**Tech Stack:** Node.js ESM, node:test, `node:readline`, no added dependencies.

**Spec:** `docs/strategy_research/BTC_5M_LEAD_LAG_PROTOCOL.md`

## Global Constraints

- Source raw data is immutable; no rewrite, truncation, or normalization-in-place.
- Every pair uses a single market and an external return ending no later than its target start.
- A gap over 10 seconds, valid ratio below 95%, missing Chainlink TWAP, incomplete executable book, or duration below seven days is `DATA_INSUFFICIENT`.
- This seven-day screen cannot emit `ELIGIBLE_FOR_REVIEW` or influence live execution.

---

### Task 1: Causal raw-row reducer

**Files:**
- Modify: `src/core/research/historical_strategy_screen.mjs`
- Modify: `tests/test_historical_strategy_screen.mjs`

**Interfaces:**
- Produces `summarizeRawScreenRows({ rows, horizonMs, alignmentToleranceMs, maxGapMs }) -> { pairs, expected_pairs, valid_rows, total_rows, max_gap_ms, reasons }`.

- [x] Write a failing test where a later market row cannot become the target of an earlier market’s signal, and a test where a missing book increments expected coverage but creates no pair.
- [x] Run `node --test tests/test_historical_strategy_screen.mjs` and confirm the export is absent.
- [x] Implement the smallest reducer with validated midpoints, same-market matching, bounded timing tolerance, and visible data-quality counters.
- [x] Re-run the focused test until it passes.

### Task 2: Streaming immutable-run report

**Files:**
- Create: `src/tools/polymarket_raw_strategy_screen_report.mjs`
- Modify: `tests/test_historical_strategy_screen.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `generateRawStrategyScreenReport({ rawPath, outPath, ... }) -> report`.

- [x] Write a failing test that invokes the command against a fixture JSONL and asserts a sub-seven-day run is `DATA_INSUFFICIENT` with a duration reason.
- [x] Run the focused test and confirm failure before the CLI exists.
- [x] Implement line-by-line parsing, SHA-256 input identity, immutable `wx` output, and the no-eligibility report.
- [x] Re-run focused tests and syntax checks until they pass.

### Task 3: Read-only VPS assessment

**Files:**
- Create: `docs/strategy_research/RAW_SCREEN_RUN_20260825T023600Z.md`

- [ ] Copy no raw data or credentials locally; invoke the new reporter on the VPS source path only after its run is terminal.
- [ ] Record observed duration, valid ratio, largest gap, and fail-closed verdict with the raw file hash.
- [ ] Verify that the report is not supplied to any live command.
