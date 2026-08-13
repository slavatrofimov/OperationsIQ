# `spark/` — Time-Series Matrix Profile compute core

This directory holds the **compute plane** of the Fabric Motif & Discord Explorer. It
is a framework-free NumPy/SciPy reference implementation (`tsmp`) of the Matrix Profile
primitives plus the **MOMP** (motif) and **DAMP** (discord) algorithms, validated for
accuracy against [STUMPY](https://github.com/TDAmeritrade/stumpy) as an independent
oracle.

Phase mapping (see `../docs/design-spec.md`, §11):

- **P1 — the `tsmp` core.** Single-node, exact, tested numerical core. No PySpark
  import on the hot path, so it runs and unit-tests on a laptop.
- **P2 — `tsmp.parallel`.** Splits the same numerics into independent `map`/`reduce`
  tasks and adds thin PySpark wrappers. The decomposition is validated to reproduce the
  single-node results *exactly*, so parallelization never changes the answer.
- **P3 — data plane (`tsmp.overview`, `tsmp.io`, `../eventhouse/schema/`).** Multi-resolution overview
  downsampling for fast charting, pure formatters that turn results into KQL rows, pure
  KQL query-string builders for interactive retrieval, and a lazily-imported Kusto
  read/ingest client. See the [P3 section](#p3--data-plane-tsmpoverview-tsmpio-kql).

## Package layout

```
tsmp/
  common/
    stats.py     moving_mean_std, muinvn (inverse L2 norm), exclusion_zone (ceil(m/4))
    paa.py       piecewise aggregate approximation (faithful port of the reference)
    mass.py      MASS distance profile + FFT sliding dot product (scipy)
  momp/
    mpx.py       exact Matrix Profile (vectorized MPX) + reusable diagonal-block pieces
    momp.py      MOMP anytime motif discovery (lower-bound + refine + prune)
  damp/
    damp.py      discords (exact top-k) + damp (early-abandon, same exact answer)
  parallel/
    decompose.py pure map/reduce primitives (diagonal-block MP, NN scan, discords)
    spark.py     thin PySpark wrappers (lazy import; identical numerics)
  overview/
    downsample.py multi-resolution min/max/avg envelopes for fast charting
  io/
    results.py   MatrixProfile/MompResult/DiscordResult -> KQL result rows
    kql.py        pure KQL query-string builders (bulk read, window slice, range/zoom)
    kusto.py      lazy azure-kusto read/ingest client (Spark's data-plane entry point)
  datagen.py     random_walk / planted_motif / planted_discord synthetic fixtures
benchmark.py     serial vs. multi-core speedup + correctness harness
tests/           parity tests vs STUMPY, planted-pattern recovery, parallel parity
```

## Key correctness notes

- **MPX** computes the exact z-normalized MP in the correlation domain; MP values match
  STUMPY to ~1e-5. It is the ground truth every other routine is checked against.
- **MOMP** is *exact*. It prunes work at coarse resolution using a **provable lower
  bound**: each length-`m` window is z-normalized by *its own full-window* mean/std,
  reduced by PAA to `w = m // dd` segments, and distances are scaled by `sqrt(dd)`.
  Normalizing with full-window statistics (rather than the shrunken std of a naively
  downsampled series) is what keeps the classic PAA bound valid for z-normalized
  distance — using the downsampled series' own std inflates distances and silently
  prunes the true motif. At `dd == 1` every surviving candidate is evaluated exactly, so
  the reported motif is guaranteed exact regardless of the pruning schedule. `momp_anytime`
  streams the improving best-so-far after each level for the UI convergence meter.
- **DAMP** returns the *same exact* top-k discords as the full-MP `discords`, but uses
  an expanding-window nearest-neighbor search with **early abandoning**: a candidate is
  dropped as soon as a neighbor closer than the current best discord distance is found.

## P2 — parallelization (`tsmp.parallel`)

The MPX self-join loop runs over **diagonals** `k` that are mutually independent and
combine by an element-wise argmax on correlation. `tsmp.parallel.decompose` splits `k`
into disjoint, work-balanced blocks, computes a partial correlation profile per block,
and reduces them in deterministic block order — reproducing `mpx` *bit-for-bit* for any
block count (verified in `tests/test_parallel.py`). A second axis, the independent
per-query nearest-neighbor scan (`parallel_nn_scan`), powers the MOMP exact pass and
DAMP verification.

Every primitive takes a `mapper` argument (defaults to the builtin `map`), so the exact
same code runs serially, on a thread pool, or on Spark:

```python
from tsmp.parallel.spark import spark_matrix_profile, spark_discords
mp = spark_matrix_profile(sc, series, m=200)      # distributed, exact
tops = spark_discords(sc, series, m=200, k=3)
```

`tsmp.parallel.spark` imports PySpark lazily, so importing `tsmp` never needs a JVM.
An adaptive `should_distribute(n, m)` switch keeps small jobs on the driver (where Spark
scheduling overhead would dominate) and fans out only large ones.

`benchmark.py` demonstrates real multi-core speedup using a process pool (no Spark
runtime needed) while asserting the parallel result equals the serial one. Example run
(4-core laptop, `m=200`): ~2.7x at `n=8000` on 2 workers and ~3–5x on 4 workers, with
the gain growing as the series length grows.

## P3 — data plane (`tsmp.overview`, `tsmp.io`, `../eventhouse/schema/`)

Results and raw series both live in the **KQL database / Eventhouse**, so the frontend
retrieves everything with the same fast range queries (design spec §4, §5.1). P3 is the
glue between the NumPy compute core and that store, kept deliberately **pure and
testable** — nothing here needs a live cluster to unit-test.

- **`tsmp.overview.downsample`** builds "OHLC-style" min/max/avg envelopes at
  geometrically coarsening zoom levels (`build_overview`), returned as `OverviewRow`s or
  KQL-ready dicts (`overview_rows`). The UI picks a `level` by zoom and fetches only the
  visible bucket range, so millions of points render at 60fps.
- **`tsmp.io.results`** turns a `MatrixProfile` / `MompResult` / `DiscordResult` into row
  dicts matching the `mp_result`, `motif_pairs` and `discords` tables. Non-finite MP
  entries become `None` (KQL nulls); discord `severity` is normalized to `0..1` for a
  ready-made color scale.
- **`tsmp.io.kql`** builds KQL **query strings only** (no I/O): bulk series read and
  window slice for the source table, and the interactive result reads
  (`mp_result_range_query`, `motif_pairs_query`, `discords_query`,
  `overview_level_query`). Identifiers are allowlist-validated and string literals are
  escaped, so a table/column name or tag value can never inject KQL.
- **`tsmp.io.kusto.KustoResultClient`** wraps the `azure-kusto-*` SDK behind a lazy
  import (`read`, `read_dataframe`, `ingest_rows`). Importing `tsmp` never pulls the SDK;
  Spark constructs the client only when it actually reads/writes.
- **`../eventhouse/schema/20_mp_result_tables.kql`** is the DDL for the result
  tables (`mp_result`, `motif_pairs`, `discords`, `overview`, `job_progress`) plus
  ingestion-batching policies tuned so results land within ~10s of a job finishing.

## P5 — job runner & orchestration (`tsmp.jobs`, `../orchestration/`)

The job-management module (design spec §8) turns a submitted `AnalysisJob` into KQL
result rows, asynchronously and resumably. It is split so that **all logic is pure and
unit-tested**, and only the two network shells (Spark read/write, Fabric REST) require a
live tenant.

- **`tsmp.jobs.runner`** is the per-job dispatch. `run_analysis(spec, series, sink,
  mapper)` maps a `JobSpec` (`FULL_MP | MOTIF_MOMP | DISCORD_DAMP | PAN_MP`) onto the
  compute core and returns an `AnalysisOutput` of KQL-ready row lists (`mp_result`,
  `motif_pairs`, `discords`, `overview`) plus a small `summary`. Best-so-far
  `ProgressEvent`s stream out through the `sink` callback for anytime UX. `PAN_MP` ranks
  candidate lengths by `dist/sqrt(m)` so the score is comparable across window sizes.
- **`tsmp.jobs.spark_entry`** is the cluster entry point (lazy imports): read the series
  slice from KQL → `run_analysis` with a Spark-backed `mapper` → post progress → ingest
  rows back to KQL. `_spec_from_dict` maps the camelCase job JSON the control plane sends.
- **`../orchestration/state_machine`** is the `QUEUED → RUNNING → SUCCEEDED|FAILED|
  CANCELLED` state machine as pure functions over a frozen `JobState`; illegal moves
  (skipping `RUNNING`, resurrecting a terminal job) raise `InvalidTransition`, and
  progress is monotonic + clamped.
- **`../orchestration/callbacks`** builds the GraphQL request bodies Spark POSTs back to
  the Rayfin Data API — `progress_callback` (streams best-so-far) and
  `completion_callback` (records KQL result pointers + summary, or the error).
- **`../orchestration/fabric_spark`** is the lazily-imported REST client that submits the
  Spark Job Definition run and polls it to a terminal state with a max-runtime guard
  (orphan protection). Not unit-tested — it needs a live Fabric workspace + Entra token.

The typical interactive query the UI issues on every pan/zoom:

```kusto
mp_result | where jobId == "<id>" and idx between (a .. b) | order by idx asc
```

## Setup & running the tests

From the repository root (Windows / PowerShell):

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -e "spark[test]"

cd spark
..\.venv\Scripts\python.exe -m pytest -q
```

The suite is small but computes STUMPY oracles on several fixtures, so a full run takes
a couple of minutes. All tests are deterministic (fixed seeds + fixed exclusion-zone /
tie-break rules).
