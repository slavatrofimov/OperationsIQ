"""Pure per-job analysis dispatch (design spec §6, §8).

Given a resolved :class:`JobSpec` and a raw 1-D series, :func:`run_analysis` runs the
right compute-core algorithm and returns an :class:`AnalysisOutput` whose fields are
lists of KQL-ready row dicts (one per result table) plus a small ``summary`` for the
control-plane ``ResultArtifact``.

Job types (design spec §5, §6.6):

* ``FULL_MP``      — exact matrix profile for the whole window (powers the MP lane).
* ``MOTIF_MOMP``   — top-k repeating patterns. On a cluster the motif is read from the
  distributed parallel matrix profile (scales to long windows); small/local windows use
  anytime MOMP for the headline motif (streaming best-so-far) and derive further pairs
  from the full profile when ``k>1``.
* ``DISCORD_DAMP`` — top-k anomalies via DAMP (exact).
* ``PAN_MP``       — "I'm not sure how long" — scans a range of lengths and ranks the
  best motif at each, so the user never has to pick ``m``. Because this computes a full
  matrix profile per candidate length, on a cluster each length's profile is fanned out
  across executors (same distributed path as ``MOTIF_MOMP``); small/local windows use the
  streaming driver MOMP once per length.

Everything is framework-free: the mapper argument (default builtin ``map``) is where a
Spark/thread mapper is injected by the runtime wrapper for parallelism.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional

import numpy as np

from tsmp.common.stats import exclusion_zone
from tsmp.momp.mpx import MatrixProfile
from tsmp.momp.momp import momp_anytime, MompResult
from tsmp.damp.damp import DiscordResult
from tsmp.parallel.decompose import (
    parallel_matrix_profile,
    parallel_lr_matrix_profile,
    parallel_discords,
    should_distribute,
)
from tsmp.io.results import (
    mp_result_rows,
    motif_pair_rows,
    motif_occurrence_rows,
    discord_rows,
    arc_curve_rows,
    segment_rows,
    chain_rows,
    ab_mp_result_rows,
    ab_motif_pair_rows,
    ab_discord_rows,
    mdim_motif_pair_rows,
    mdim_dimension_rows,
    mdim_discord_rows,
    consensus_member_rows,
    AB_SERIES_A,
    AB_SERIES_B,
)
from tsmp.abjoin.abjoin import ab_matrix_profile, ab_motifs, ab_discords
from tsmp.mstamp.mstamp import mstamp, mstamp_motifs, mstamp_discords
from tsmp.ostinato.ostinato import ostinato
from tsmp.overview.downsample import overview_rows
from tsmp.segment.fluss import corrected_arc_curve, find_regimes
from tsmp.chains.chains import top_k_chains, chain_drift
from tsmp.common.occurrences import occurrences_for_query, multidim_occurrences

__all__ = [
    "JobSpec",
    "AnalysisOutput",
    "ProgressEvent",
    "run_analysis",
    "motif_pairs_from_profile",
]

Mapper = Callable[[Callable, Iterable], Iterable]


@dataclass
class JobSpec:
    """A resolved analysis request (mirrors the control-plane ``AnalysisJob``)."""

    job_id: str
    type: str                       # MOTIF_MOMP | DISCORD_DAMP | FULL_MP | PAN_MP | SEGMENTATION | CHAIN | AB_MOTIF | AB_DISCORD
    m: Optional[int] = None         # subsequence length (None only for PAN_MP)
    k: int = 1                      # number of motifs / discords to return
    minlag: Optional[int] = None    # exclusion radius (defaults to exclusion_zone(m))
    include_profile: bool = False   # also emit mp_result (the MP lane) for motif/discord
    build_overview: bool = True     # emit multi-resolution overview envelopes
    # PAN_MP length scan (inclusive range); step defaults to a ~12-length geometric-ish scan.
    length_min: Optional[int] = None
    length_max: Optional[int] = None
    length_step: Optional[int] = None
    n_blocks: int = 4               # parallel block count handed to the decomposition
    # AB-join (two-series) novelty direction: "b" finds comparison-series B
    # windows with no close match in baseline A (the usual "what changed" question).
    ab_target: str = "b"
    # Multidimensional (mSTAMP): number of channels that must jointly participate in a
    # motif/discord. None = use all channels (every sensor must agree).
    n_dims: Optional[int] = None
    # Consensus (Ostinato): minimum number of the N series a window must appear in for the
    # consensus motif. None = strict all-N.
    min_count: Optional[int] = None
    # Cap on how many occurrences of each motif to enumerate for the motif_occurrences table
    # (the exact "show all occurrences" overlay). Bounds output for very repetitive windows.
    max_occurrences: int = 200

    def resolved_minlag(self, m: int) -> int:
        return self.minlag if self.minlag is not None else exclusion_zone(m)


@dataclass
class ProgressEvent:
    """A best-so-far snapshot streamed to the control plane during a run."""

    pct: float                      # 0..100 convergence estimate
    best: Optional[dict] = None     # {"pair": (a,b), "distance": d} or {"index": i, "nnDist": d}
    stage: str = ""                 # human-readable phase for the UI


ProgressSink = Callable[[ProgressEvent], None]


@dataclass
class AnalysisOutput:
    """KQL-ready result rows for a finished job, plus a small summary."""

    job_id: str
    mp_result: list[dict] = field(default_factory=list)
    motif_pairs: list[dict] = field(default_factory=list)
    motif_occurrences: list[dict] = field(default_factory=list)
    discords: list[dict] = field(default_factory=list)
    overview: list[dict] = field(default_factory=list)
    arc_curve: list[dict] = field(default_factory=list)
    segments: list[dict] = field(default_factory=list)
    chain_links: list[dict] = field(default_factory=list)
    md_dimensions: list[dict] = field(default_factory=list)
    consensus_members: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)


def motif_pairs_from_profile(
    profile: MatrixProfile, k: int, minlag: int
) -> list[tuple[int, int, float]]:
    """Extract the top-``k`` non-overlapping motif pairs from a full matrix profile.

    Candidates are the ``(i, mpi[i])`` nearest-neighbor pairs; we sort them by distance
    ascending and greedily accept a pair only if both of its endpoints are at least
    ``minlag`` away from every endpoint already accepted, so reported motifs don't
    overlap (the standard top-k motif exclusion rule).
    """
    mp = np.asarray(profile.mp, dtype=np.float64)
    mpi = np.asarray(profile.mpi, dtype=np.int64)
    order = np.argsort(mp, kind="stable")

    chosen: list[tuple[int, int, float]] = []
    used: list[int] = []
    for i in order:
        d = mp[i]
        j = int(mpi[i])
        if not np.isfinite(d) or j < 0:
            continue
        a, b = sorted((int(i), j))
        if any(abs(a - u) < minlag or abs(b - u) < minlag for u in used):
            continue
        chosen.append((a, b, float(d)))
        used.extend((a, b))
        if len(chosen) >= k:
            break
    return chosen


def _self_join_occurrences(
    job_id: str,
    series: np.ndarray,
    motifs: list[tuple[int, int, float, int]],
    max_occurrences: int,
) -> list[dict]:
    """``motif_occurrences`` rows for self-join / Pan-MP motifs (one clock, ``seriesId`` null).

    ``motifs`` is a list of ``(rank, idx_a, pair_dist, sub_len)`` — the seed endpoint, the
    motif's pair distance (used as the match yardstick), and its window length (which varies
    per rank for Pan-MP). Each motif's shape is matched against the whole series via MASS.
    """
    series = np.asarray(series, dtype=np.float64)
    rows: list[dict] = []
    for rank, idx_a, pair_dist, sub_len in motifs:
        if sub_len < 1 or idx_a < 0 or idx_a + sub_len > series.shape[0]:
            continue
        matches = occurrences_for_query(
            series[idx_a : idx_a + sub_len], series, pair_dist,
            seed_index=idx_a, max_results=max_occurrences,
        )
        rows.extend(motif_occurrence_rows(job_id, rank, matches, sub_len))
    return rows


def _mapper_kwargs(spec: JobSpec, mapper: Mapper) -> dict:
    return {"n_blocks": spec.n_blocks, "mapper": mapper}


def _run_full_mp(spec: JobSpec, series: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]) -> AnalysisOutput:
    m = _require_m(spec)
    minlag = spec.resolved_minlag(m)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="computing matrix profile"))
    profile = parallel_matrix_profile(series, m, minlag=minlag, **_mapper_kwargs(spec, mapper))
    out = AnalysisOutput(job_id=spec.job_id)
    out.mp_result = mp_result_rows(spec.job_id, profile)

    finite = np.isfinite(profile.mp)
    out.summary = {
        "type": spec.type,
        "m": m,
        "n": int(profile.mp.shape[0]),
        "mpMin": float(np.min(profile.mp[finite])) if finite.any() else None,
        "mpMax": float(np.max(profile.mp[finite])) if finite.any() else None,
    }
    _maybe_overview(spec, series, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


def _motif_from_profile(
    spec: JobSpec,
    series: np.ndarray,
    m: int,
    minlag: int,
    mapper: Mapper,
    sink: Optional[ProgressSink],
) -> AnalysisOutput:
    """Distributed exact motif path: extract the top-k motif(s) from the full profile.

    Computes the self-join matrix profile with the diagonal-block map/reduce
    (:func:`parallel_matrix_profile`), which fans the O(n^2) work across the injected
    Spark mapper, then reads the top-k non-overlapping motif pairs straight off it. The
    reported motifs are exact and full-resolution — identical to the driver-only anytime
    MOMP result — but the heavy compute runs on the executors, so long windows that would
    stall a single driver core now scale with the cluster.
    """
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="computing matrix profile"))
    profile = parallel_matrix_profile(series, m, minlag=minlag, **_mapper_kwargs(spec, mapper))
    pairs = motif_pairs_from_profile(profile, max(1, spec.k), minlag)
    out.motif_pairs = motif_pair_rows(spec.job_id, pairs, sub_len=m)
    out.motif_occurrences = _self_join_occurrences(
        spec.job_id, series,
        [(r + 1, p[0], p[2], m) for r, p in enumerate(pairs)],
        spec.max_occurrences,
    )
    if spec.include_profile:
        out.mp_result = mp_result_rows(spec.job_id, profile)
    top = pairs[0] if pairs else None
    out.summary = {
        "type": spec.type, "m": m, "k": spec.k,
        "topMotif": ({"idxA": top[0], "idxB": top[1], "dist": top[2]} if top else None),
    }
    _maybe_overview(spec, series, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


def _run_motif(spec: JobSpec, series: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]) -> AnalysisOutput:
    m = _require_m(spec)
    minlag = spec.resolved_minlag(m)
    out = AnalysisOutput(job_id=spec.job_id)

    # Distributed exact path: on a real cluster (a non-trivial mapper) and a window big
    # enough that the parallel speedup outweighs Spark scheduling overhead, compute the
    # motif from the diagonal-block parallel matrix profile so the O(n^2) work spreads
    # across executors. The driver-only anytime MOMP below is single-threaded and does
    # not scale to long (e.g. multi-week) windows.
    if mapper is not map and should_distribute(series.shape[0], m):
        return _motif_from_profile(spec, series, m, minlag, mapper, sink)

    # Anytime MOMP streams an improving best-so-far; pruned_fraction is the convergence
    # proxy shown on the UI meter. The final (exact) level gives the headline motif. This
    # serial path is used for small/interactive windows where streaming beats fan-out.
    last: Optional[MompResult] = None
    best_pair = None
    best_dist = float("inf")
    for level in momp_anytime(series, m):
        best_pair = level.pair
        best_dist = level.bsf
        if sink:
            best = {"pair": list(level.pair), "distance": level.bsf} if level.pair else None
            pct = 100.0 if level.exact else min(99.0, level.pruned_fraction * 100.0)
            sink(ProgressEvent(pct=pct, best=best, stage="refining motif" if not level.exact else "done"))
    assert best_pair is not None
    a, b = sorted(best_pair)

    if spec.k <= 1:
        out.motif_pairs = motif_pair_rows(spec.job_id, [(a, b, best_dist)], sub_len=m)
        out.motif_occurrences = _self_join_occurrences(
            spec.job_id, series, [(1, a, best_dist, m)], spec.max_occurrences,
        )
    else:
        # For k>1 the full profile is needed to rank additional non-overlapping pairs.
        profile = parallel_matrix_profile(series, m, minlag=minlag, **_mapper_kwargs(spec, mapper))
        pairs = motif_pairs_from_profile(profile, spec.k, minlag)
        # Guarantee the exact MOMP motif is rank 1 even if float ordering differs.
        if not pairs or (pairs[0][0], pairs[0][1]) != (a, b):
            pairs = [(a, b, best_dist)] + [p for p in pairs if (p[0], p[1]) != (a, b)]
            pairs = pairs[: spec.k]
        out.motif_pairs = motif_pair_rows(spec.job_id, pairs, sub_len=m)
        out.motif_occurrences = _self_join_occurrences(
            spec.job_id, series,
            [(r + 1, p[0], p[2], m) for r, p in enumerate(pairs)],
            spec.max_occurrences,
        )
        if spec.include_profile:
            out.mp_result = mp_result_rows(spec.job_id, profile)

    out.summary = {"type": spec.type, "m": m, "k": spec.k,
                   "topMotif": {"idxA": a, "idxB": b, "dist": best_dist}}
    _maybe_overview(spec, series, out)
    return out


def _run_discord(spec: JobSpec, series: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]) -> AnalysisOutput:
    m = _require_m(spec)
    minlag = spec.resolved_minlag(m)
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="scanning for anomalies"))
    ds: list[DiscordResult] = parallel_discords(
        series, m, k=spec.k, minlag=minlag, **_mapper_kwargs(spec, mapper)
    )
    out.discords = discord_rows(spec.job_id, ds)
    if spec.include_profile:
        profile = parallel_matrix_profile(series, m, minlag=minlag, **_mapper_kwargs(spec, mapper))
        out.mp_result = mp_result_rows(spec.job_id, profile)
    out.summary = {
        "type": spec.type, "m": m, "k": spec.k,
        "topDiscord": ({"index": ds[0].index, "nnDist": ds[0].nn_distance} if ds else None),
    }
    _maybe_overview(spec, series, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


def _pan_lengths(spec: JobSpec, n: int) -> list[int]:
    lo = spec.length_min if spec.length_min is not None else 8
    hi = spec.length_max if spec.length_max is not None else max(lo + 1, n // 4)
    lo = max(4, int(lo))
    hi = max(lo + 1, int(hi))
    if spec.length_step:
        return list(range(lo, hi + 1, int(spec.length_step)))
    # ~12 evenly spaced lengths across the range (deduped, sorted).
    return sorted({int(round(v)) for v in np.linspace(lo, hi, num=min(12, hi - lo + 1))})


def _run_pan(spec: JobSpec, series: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]) -> AnalysisOutput:
    n = series.shape[0]
    lengths = _pan_lengths(spec, n)
    out = AnalysisOutput(job_id=spec.job_id)
    results: list[tuple[int, int, int, float]] = []  # (m, a, b, dist)

    # The length scan is the slow lane: it computes a full O(n^2) matrix profile for every
    # candidate length (~12 of them), so it is inherently ~len(lengths)x the work of a single
    # known-length motif. On a real cluster we therefore fan *each* length's matrix profile out
    # across executors via the diagonal-block map/reduce (identical to the known-length motif
    # path) instead of running the single-threaded driver MOMP once per length. The driver-only
    # MOMP is kept for small/interactive windows and the serial/test path (mapper is builtin map),
    # where streaming beats fan-out. should_distribute is checked per length because the shortest
    # candidate windows can fall below the fan-out threshold.
    distribute = mapper is not map
    for i, m in enumerate(lengths):
        if m >= n:
            continue
        if distribute and should_distribute(n, m):
            minlag = spec.resolved_minlag(m)
            profile = parallel_matrix_profile(series, m, minlag=minlag, **_mapper_kwargs(spec, mapper))
            pairs = motif_pairs_from_profile(profile, 1, minlag)
            if not pairs:
                continue
            a, b, dist = pairs[0]
        else:
            res = None
            for level in momp_anytime(series, m):
                res = level
            if res is None or res.pair is None:
                continue
            a, b = sorted(res.pair)
            dist = res.bsf
        results.append((m, int(a), int(b), float(dist)))
        if sink:
            sink(ProgressEvent(
                pct=min(99.0, (i + 1) / len(lengths) * 100.0),
                best={"m": m, "pair": [int(a), int(b)], "distance": float(dist)},
                stage=f"scanning length {m}",
            ))

    # Rank lengths by a *length-normalized* motif distance. Raw z-normalized Euclidean
    # distance grows ~sqrt(m) with the window length, so comparing lengths on raw
    # distance is biased toward the shortest window. Dividing by sqrt(m) makes the
    # "strongest repeat" comparable across lengths (standard Pan-MP practice).
    results.sort(key=lambda r: r[3] / np.sqrt(r[0]))
    top = results[: max(1, spec.k)]
    # Emit one motif_pairs row per selected length (subLen varies per row).
    rows: list[dict] = []
    for rank, (m, a, b, dist) in enumerate(top, start=1):
        rows.append({"jobId": spec.job_id, "rank": rank, "idxA": a, "idxB": b,
                     "dist": float(dist), "subLen": int(m)})
    out.motif_pairs = rows
    out.motif_occurrences = _self_join_occurrences(
        spec.job_id, series,
        [(rank, a, dist, m) for rank, (m, a, b, dist) in enumerate(top, start=1)],
        spec.max_occurrences,
    )
    out.summary = {
        "type": spec.type,
        "scannedLengths": lengths,
        "bestLength": (top[0][0] if top else None),
        "topMotif": ({"m": top[0][0], "idxA": top[0][1], "idxB": top[0][2], "dist": top[0][3]} if top else None),
    }
    _maybe_overview(spec, series, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


def _run_segmentation(spec: JobSpec, series: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]) -> AnalysisOutput:
    """Semantic segmentation (FLUSS): split the window into operating regimes.

    Computes the self-join matrix-profile *index* (reusing the distributed diagonal-block
    path so long windows scale), derives the Corrected Arc Curve from it, and reports the
    ``k`` strongest regime boundaries. ``k`` is the number of change points to find
    (mapped from the sensitivity slider); the exclusion zone (subsequence length) both
    suppresses edge artifacts and keeps boundaries from clustering on one transition.
    """
    m = _require_m(spec)
    minlag = spec.resolved_minlag(m)
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="scanning for regime changes"))
    profile = parallel_matrix_profile(series, m, minlag=minlag, **_mapper_kwargs(spec, mapper))

    exclusion = m
    cac = corrected_arc_curve(profile.mpi, exclusion=exclusion)
    boundaries = find_regimes(profile.mpi, num_regimes=max(1, spec.k), exclusion=exclusion, cac=cac)

    out.arc_curve = arc_curve_rows(spec.job_id, cac)
    out.segments = segment_rows(spec.job_id, boundaries)
    if spec.include_profile:
        out.mp_result = mp_result_rows(spec.job_id, profile)
    out.summary = {
        "type": spec.type,
        "m": m,
        "numRegimes": len(boundaries) + 1,
        "boundaries": [{"idx": b.index, "cac": b.cac} for b in boundaries],
    }
    _maybe_overview(spec, series, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


def _run_chain(spec: JobSpec, series: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]) -> AnalysisOutput:
    """Time-Series Chains: follow a slowly-drifting pattern (degradation / wear).

    Computes the directional (left/right) matrix profile — the substrate for chains — and
    extracts the ``k`` longest evolving chains, then quantifies the head→tail drift of the
    top chain for the plain-language summary.
    """
    m = _require_m(spec)
    minlag = spec.resolved_minlag(m)
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="tracking evolving pattern"))
    lr = parallel_lr_matrix_profile(series, m, minlag=minlag, **_mapper_kwargs(spec, mapper))

    chains = top_k_chains(lr.il, lr.ir, k=max(1, spec.k))
    out.chain_links = chain_rows(spec.job_id, chains, sub_len=m)
    top = chains[0] if chains else None
    drift = chain_drift(series, top.indices, m) if top else None
    out.summary = {
        "type": spec.type,
        "m": m,
        "k": spec.k,
        "numChains": len(chains),
        "topChainLength": (top.length if top else 0),
        "drift": drift,
    }
    _maybe_overview(spec, series, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


_DISPATCH = {
    "FULL_MP": _run_full_mp,
    "MOTIF_MOMP": _run_motif,
    "DISCORD_DAMP": _run_discord,
    "PAN_MP": _run_pan,
    "SEGMENTATION": _run_segmentation,
    "CHAIN": _run_chain,
}


def _ab_overview(spec: JobSpec, a: np.ndarray, b: np.ndarray, out: AnalysisOutput) -> None:
    """Build overview envelopes for both AB-join series, tagged by seriesId (0=A, 1=B)."""
    if spec.build_overview:
        out.overview = (
            overview_rows(spec.job_id, a, series_id=0)
            + overview_rows(spec.job_id, b, series_id=1)
        )


def _run_ab_motif(
    spec: JobSpec, a: np.ndarray, b: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]
) -> AnalysisOutput:
    """AB-join motif: the top-``k`` most-similar pattern pairs between series A and B.

    Powers the "compare two periods / machines" recipe. Computes the bidirectional AB
    matrix profile (fanned across the injected ``mapper``) and reads the closest
    cross-series pairs off it. Because A and B are distinct series there is no self-match to
    exclude, so the headline pair is simply the global minimum of the A→B profile.
    """
    m = _require_m(spec)
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="comparing the two series"))
    profile = ab_matrix_profile(a, b, m, n_blocks=spec.n_blocks, mapper=mapper)
    motifs = ab_motifs(profile, k=max(1, spec.k))
    out.motif_pairs = ab_motif_pair_rows(spec.job_id, motifs, sub_len=m)
    # Occurrences of each motif's shape in BOTH series: matches in the baseline A (seriesId 0)
    # and the comparison B (seriesId 1), so the analyst sees everywhere the compared pattern
    # shows up, not only the single matched pair. The shape is taken from A's endpoint.
    occ_rows: list[dict] = []
    for rank, motif in enumerate(motifs, start=1):
        ia, ib, dist = int(motif.idx_a), int(motif.idx_b), float(motif.dist)
        if ia < 0 or ia + m > a.shape[0]:
            continue
        query = a[ia : ia + m]
        matches_a = occurrences_for_query(
            query, a, dist, seed_index=ia, max_results=spec.max_occurrences)
        occ_rows.extend(
            motif_occurrence_rows(spec.job_id, rank, matches_a, m, series_id=AB_SERIES_A))
        matches_b = occurrences_for_query(
            query, b, dist, seed_index=ib, max_results=spec.max_occurrences)
        occ_rows.extend(
            motif_occurrence_rows(spec.job_id, rank, matches_b, m, series_id=AB_SERIES_B))
    out.motif_occurrences = occ_rows
    if spec.include_profile:
        out.mp_result = ab_mp_result_rows(spec.job_id, profile)
    top = motifs[0] if motifs else None
    out.summary = {
        "type": spec.type, "m": m, "k": spec.k, "abMode": True,
        "topMotif": ({"idxA": top.idx_a, "idxB": top.idx_b, "dist": top.dist} if top else None),
    }
    _ab_overview(spec, a, b, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


def _run_ab_discord(
    spec: JobSpec, a: np.ndarray, b: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]
) -> AnalysisOutput:
    """AB-join novelty: the top-``k`` windows of B least like anything in the baseline A.

    Powers "what changed" / novelty detection. Ranks each window of the comparison series by
    its distance to the nearest window of the baseline (the B→A profile); the largest are the
    shapes that emerged relative to A. ``spec.ab_target`` picks the direction (default "b").
    """
    m = _require_m(spec)
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="scanning for novelty vs the baseline"))
    profile = ab_matrix_profile(a, b, m, n_blocks=spec.n_blocks, mapper=mapper)
    target = spec.ab_target if spec.ab_target in ("a", "b") else "b"
    ds = ab_discords(profile, k=max(1, spec.k), target=target)
    series_id = 1 if target == "b" else 0
    out.discords = ab_discord_rows(spec.job_id, ds, series_id=series_id)
    if spec.include_profile:
        out.mp_result = ab_mp_result_rows(spec.job_id, profile)
    top = ds[0] if ds else None
    out.summary = {
        "type": spec.type, "m": m, "k": spec.k, "abMode": True, "target": target,
        "topDiscord": ({"index": top.index, "nnDist": top.nn_distance} if top else None),
    }
    _ab_overview(spec, a, b, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


# AB-join handlers take a second series, so they are dispatched separately from the
# single-series handlers above (which share the (spec, series, mapper, sink) signature).
_AB_DISPATCH = {
    "AB_MOTIF": _run_ab_motif,
    "AB_DISCORD": _run_ab_discord,
}


# --------------------------------------------------------------- Multidimensional (mSTAMP)

def _mdim_overview(spec: JobSpec, series_2d: np.ndarray, out: AnalysisOutput) -> None:
    """Build one overview envelope per aligned channel, tagged by seriesId (0..d-1)."""
    if spec.build_overview:
        rows: list[dict] = []
        for dim in range(series_2d.shape[0]):
            rows.extend(overview_rows(spec.job_id, series_2d[dim], series_id=dim))
        out.overview = rows


def _run_mdim_motif(
    spec: JobSpec, series_2d: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]
) -> AnalysisOutput:
    """Multidimensional motif: the top-``k`` patterns that a subset of channels jointly repeat.

    Computes the mSTAMP multidimensional matrix profile (fanned across the injected ``mapper``)
    and reads the strongest ``spec.n_dims``-of-``d`` motifs off it. Each motif records which
    channels participate so the UI can highlight the span across exactly those sensor lanes.
    """
    m = _require_m(spec)
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="scanning the sensors together"))
    profile = mstamp(series_2d, m, n_blocks=spec.n_blocks, mapper=mapper)
    motifs = mstamp_motifs(profile, series_2d, k=max(1, spec.k), n_dims=spec.n_dims)
    out.motif_pairs = mdim_motif_pair_rows(spec.job_id, motifs, sub_len=m)
    out.md_dimensions = mdim_dimension_rows(spec.job_id, motifs, kind="MOTIF")
    # Occurrences where the motif's participating channels JOINTLY repeat the shape, scored by
    # the same mSTAMP k-dimensional (mean-over-dims) distance. One clock, so seriesId is null;
    # the UI draws each occurrence across the motif's participating sensor lanes (md_dimensions).
    occ_rows: list[dict] = []
    for rank, motif in enumerate(motifs, start=1):
        matches = multidim_occurrences(
            series_2d, int(motif.idx_a), m, motif.dims, float(motif.dist),
            max_results=spec.max_occurrences)
        occ_rows.extend(motif_occurrence_rows(spec.job_id, rank, matches, m))
    out.motif_occurrences = occ_rows
    top = motifs[0] if motifs else None
    out.summary = {
        "type": spec.type, "m": m, "k": spec.k, "multiDim": True,
        "numChannels": int(series_2d.shape[0]),
        "topMotif": (
            {"idxA": top.idx_a, "idxB": top.idx_b, "dist": top.dist,
             "nDims": top.n_dims, "dims": top.dims}
            if top else None
        ),
    }
    _mdim_overview(spec, series_2d, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


def _run_mdim_discord(
    spec: JobSpec, series_2d: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]
) -> AnalysisOutput:
    """Multidimensional novelty: windows unlike anything else across a subset of channels."""
    m = _require_m(spec)
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="scanning the sensors for novelty"))
    profile = mstamp(series_2d, m, n_blocks=spec.n_blocks, mapper=mapper)
    ds = mstamp_discords(profile, series_2d, k=max(1, spec.k), n_dims=spec.n_dims)
    out.discords = mdim_discord_rows(spec.job_id, ds)
    out.md_dimensions = mdim_dimension_rows(spec.job_id, ds, kind="DISCORD")
    top = ds[0] if ds else None
    out.summary = {
        "type": spec.type, "m": m, "k": spec.k, "multiDim": True,
        "numChannels": int(series_2d.shape[0]),
        "topDiscord": (
            {"index": top.index, "nnDist": top.nn_distance, "nDims": top.n_dims, "dims": top.dims}
            if top else None
        ),
    }
    _mdim_overview(spec, series_2d, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


def _run_mdim_segmentation(
    spec: JobSpec, series_2d: np.ndarray, mapper: Mapper, sink: Optional[ProgressSink]
) -> AnalysisOutput:
    """Multivariate segmentation (FLUSS over the multidimensional MP index).

    Runs mSTAMP, then feeds the all-channels nearest-neighbour index (row ``d-1`` of the
    multidimensional profile) into the same Corrected-Arc-Curve machinery used by the
    single-series segmentation, so regime boundaries reflect a change in the *joint*
    multi-sensor behaviour rather than any one channel.
    """
    m = _require_m(spec)
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="scanning for multi-sensor regime changes"))
    profile = mstamp(series_2d, m, n_blocks=spec.n_blocks, mapper=mapper)
    mpi = profile.mpi[series_2d.shape[0] - 1]  # all-channels nearest-neighbour index

    exclusion = m
    cac = corrected_arc_curve(mpi, exclusion=exclusion)
    boundaries = find_regimes(mpi, num_regimes=max(1, spec.k), exclusion=exclusion, cac=cac)

    out.arc_curve = arc_curve_rows(spec.job_id, cac)
    out.segments = segment_rows(spec.job_id, boundaries)
    out.summary = {
        "type": spec.type, "m": m, "multiDim": True,
        "numChannels": int(series_2d.shape[0]),
        "numRegimes": len(boundaries) + 1,
        "boundaries": [{"idx": b.index, "cac": b.cac} for b in boundaries],
    }
    _mdim_overview(spec, series_2d, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


# Multidimensional (mSTAMP) handlers take a 2-D (d channels x n samples) time-aligned matrix.
_MULTIDIM_DISPATCH = {
    "MULTIDIM_MOTIF": _run_mdim_motif,
    "MULTIDIM_DISCORD": _run_mdim_discord,
    "MULTIDIM_SEGMENTATION": _run_mdim_segmentation,
}


# --------------------------------------------------------------- Consensus (Ostinato)

def _consensus_overview(spec: JobSpec, series_list: list[np.ndarray], out: AnalysisOutput) -> None:
    """Build one overview envelope per fleet series, tagged by seriesId (0..N-1).

    Unlike multidimensional overviews these series need not be aligned or the same length —
    each is downsampled independently for its own lane.
    """
    if spec.build_overview:
        rows: list[dict] = []
        for s, series in enumerate(series_list):
            rows.extend(overview_rows(spec.job_id, series, series_id=s))
        out.overview = rows


def _run_consensus_motif(
    spec: JobSpec, series_list: list[np.ndarray], mapper: Mapper, sink: Optional[ProgressSink]
) -> AnalysisOutput:
    """Consensus motif: the single shape that best recurs across a fleet of ``N`` series.

    Runs Ostinato (fanned across the injected ``mapper``) to find the window whose radius —
    its ``min_count``-th smallest nearest-neighbour distance across the fleet — is smallest,
    then records where that shared shape occurs in each series. ``spec.min_count`` picks
    strict all-fleet consensus (default) or a ``>= m of N`` partial consensus.
    """
    m = _require_m(spec)
    out = AnalysisOutput(job_id=spec.job_id)
    if sink:
        sink(ProgressEvent(pct=5.0, stage="searching the fleet for a common shape"))
    motif = ostinato(series_list, m, min_count=spec.min_count, n_blocks=spec.n_blocks, mapper=mapper)
    if motif is not None:
        out.consensus_members = consensus_member_rows(spec.job_id, motif, rank=1)
    out.summary = {
        "type": spec.type, "m": m, "consensus": True,
        "numSeries": len(series_list),
        "minCount": motif.min_count if motif else spec.min_count,
        "topConsensus": (
            {"centralSeries": motif.central_series, "centralIndex": motif.central_index,
             "radius": motif.radius}
            if motif else None
        ),
    }
    _consensus_overview(spec, series_list, out)
    if sink:
        sink(ProgressEvent(pct=100.0, stage="done"))
    return out


# Consensus (Ostinato) handlers take a list of N (unaligned) series.
_CONSENSUS_DISPATCH = {
    "CONSENSUS_MOTIF": _run_consensus_motif,
}


def run_analysis(
    spec: JobSpec,
    series: np.ndarray,
    sink: Optional[ProgressSink] = None,
    mapper: Mapper = map,
    series_b: Optional[np.ndarray] = None,
    series_list: Optional[list[np.ndarray]] = None,
) -> AnalysisOutput:
    """Run the analysis described by ``spec`` and return KQL-ready rows.

    Single-series jobs use ``series`` only. AB-join jobs (``AB_MOTIF`` / ``AB_DISCORD``)
    additionally require ``series_b`` — the comparison series. Multidimensional (mSTAMP)
    jobs (``MULTIDIM_*``) require ``series_list`` — the ``d`` time-aligned channels of one
    asset (all read at the same bin width so their columns share a clock); they are stacked
    into a ``(d, n)`` matrix, truncated to the shortest channel so every column is aligned.
    Consensus (Ostinato) jobs (``CONSENSUS_MOTIF``) also take ``series_list`` — the ``N``
    fleet series, which need not be aligned or the same length.
    """
    if spec.type in _MULTIDIM_DISPATCH:
        if not series_list or len(series_list) < 2:
            raise ValueError(f"job type {spec.type} requires at least two aligned series (series_list)")
        channels = [np.asarray(s, dtype=np.float64) for s in series_list]
        if any(c.ndim != 1 for c in channels):
            raise ValueError("each series in series_list must be 1-D")
        n = min(c.shape[0] for c in channels)
        series_2d = np.vstack([c[:n] for c in channels])
        return _MULTIDIM_DISPATCH[spec.type](spec, series_2d, mapper, sink)

    if spec.type in _CONSENSUS_DISPATCH:
        if not series_list or len(series_list) < 2:
            raise ValueError(f"job type {spec.type} requires at least two series (series_list)")
        fleet = [np.asarray(s, dtype=np.float64) for s in series_list]
        if any(c.ndim != 1 for c in fleet):
            raise ValueError("each series in series_list must be 1-D")
        return _CONSENSUS_DISPATCH[spec.type](spec, fleet, mapper, sink)

    series = np.asarray(series, dtype=np.float64)
    if series.ndim != 1:
        raise ValueError("series must be 1-D")

    if spec.type in _AB_DISPATCH:
        if series_b is None:
            raise ValueError(f"job type {spec.type} requires a second series (series_b)")
        series_b = np.asarray(series_b, dtype=np.float64)
        if series_b.ndim != 1:
            raise ValueError("series_b must be 1-D")
        return _AB_DISPATCH[spec.type](spec, series, series_b, mapper, sink)

    try:
        handler = _DISPATCH[spec.type]
    except KeyError:
        raise ValueError(f"unknown job type: {spec.type!r}") from None
    return handler(spec, series, mapper, sink)


def _require_m(spec: JobSpec) -> int:
    if spec.m is None:
        raise ValueError(f"job type {spec.type} requires a subsequence length m")
    if spec.m < 4:
        raise ValueError("m must be >= 4")
    return int(spec.m)


def _maybe_overview(spec: JobSpec, series: np.ndarray, out: AnalysisOutput) -> None:
    if spec.build_overview:
        out.overview = overview_rows(spec.job_id, series)
