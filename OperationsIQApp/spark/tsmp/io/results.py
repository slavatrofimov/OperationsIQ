"""Format compute-core outputs into KQL result-table rows (design spec §5.1).

Each function returns a list of plain dicts whose keys match the columns declared in
``kql/result_schema.kql``. ``ingestedAt`` is intentionally omitted — it is stamped by
the ingestion path (or defaults on the KQL side) so formatting stays pure and testable.
Non-finite matrix-profile entries (e.g. within the exclusion zone at the head/tail) are
emitted as ``None`` so they round-trip as KQL nulls rather than invalid reals.
"""
from __future__ import annotations

import math
from typing import Iterable

import numpy as np

from tsmp.momp.mpx import MatrixProfile
from tsmp.momp.momp import MompResult
from tsmp.damp.damp import DiscordResult
from tsmp.abjoin.abjoin import ABMatrixProfile, ABMotif, ABDiscord
from tsmp.mstamp.mstamp import MDimMotif, MDimDiscord
from tsmp.ostinato.ostinato import ConsensusMotif

__all__ = [
    "mp_result_rows",
    "motif_pair_rows",
    "motif_occurrence_rows",
    "discord_rows",
    "arc_curve_rows",
    "segment_rows",
    "chain_rows",
    "ab_mp_result_rows",
    "ab_motif_pair_rows",
    "ab_discord_rows",
    "mdim_motif_pair_rows",
    "mdim_dimension_rows",
    "mdim_discord_rows",
    "consensus_member_rows",
]


def _finite_or_none(x: float) -> float | None:
    return float(x) if math.isfinite(x) else None


def mp_result_rows(job_id: str, profile: MatrixProfile, series_id: int | None = None) -> list[dict]:
    """One row per subsequence index for the ``mp_result`` table.

    ``series_id`` tags the profile with which series it belongs to for multi-series
    (AB-join) jobs; it is omitted for single-series jobs so their rows keep the original
    shape (the ``seriesId`` column then ingests as null).
    """
    mp = np.asarray(profile.mp, dtype=np.float64)
    mpi = np.asarray(profile.mpi, dtype=np.int64)
    extra = {} if series_id is None else {"seriesId": int(series_id)}
    rows: list[dict] = []
    for idx in range(mp.shape[0]):
        rows.append(
            {
                "jobId": job_id,
                **extra,
                "idx": int(idx),
                "mp": _finite_or_none(mp[idx]),
                "mpi": int(mpi[idx]),
            }
        )
    return rows


def motif_pair_rows(
    job_id: str,
    pairs: Iterable[tuple[int, int, float]] | MompResult,
    sub_len: int | None = None,
) -> list[dict]:
    """Rows for the ``motif_pairs`` table.

    Accepts either a :class:`MompResult` (single top motif) or an iterable of
    ``(idxA, idxB, dist)`` tuples already ordered best-first.
    """
    if isinstance(pairs, MompResult):
        a, b = pairs.pair
        items = [(a, b, pairs.distance)]
        sub_len = sub_len if sub_len is not None else pairs.m
    else:
        items = [(int(a), int(b), float(d)) for a, b, d in pairs]
    if sub_len is None:
        raise ValueError("sub_len is required when pairs is not a MompResult")

    rows: list[dict] = []
    for rank, (a, b, dist) in enumerate(items, start=1):
        lo, hi = sorted((int(a), int(b)))
        rows.append(
            {
                "jobId": job_id,
                "rank": rank,
                "idxA": lo,
                "idxB": hi,
                "dist": float(dist),
                "subLen": int(sub_len),
            }
        )
    return rows


def motif_occurrence_rows(
    job_id: str,
    rank: int,
    matches: Iterable[tuple[int, float]],
    sub_len: int,
    series_id: int | None = None,
) -> list[dict]:
    """Rows for the ``motif_occurrences`` table: every stretch that matches a motif's shape.

    ``rank`` ties the rows back to the ``motif_pairs`` row of the same rank; ``occurrence`` is a
    0-based order within the motif (by index). ``series_id`` tags which series each occurrence
    lives in for AB-join jobs (0 = A, 1 = B) and is omitted (ingests as null) for single-series
    and multidimensional jobs, whose occurrences share one clock. ``dist`` is the occurrence's
    z-normalized distance to the motif shape (0 for the seed endpoint).
    """
    extra = {} if series_id is None else {"seriesId": int(series_id)}
    rows: list[dict] = []
    for occ, (idx, dist) in enumerate(matches):
        rows.append(
            {
                "jobId": job_id,
                "rank": int(rank),
                "occurrence": int(occ),
                **extra,
                "idx": int(idx),
                "dist": _finite_or_none(float(dist)),
                "subLen": int(sub_len),
            }
        )
    return rows


def discord_rows(job_id: str, discords: list[DiscordResult]) -> list[dict]:
    """Rows for the ``discords`` table, with a normalized 0..1 ``severity`` scale.

    Severity scales each discord's nearest-neighbor distance relative to the strongest
    discord in the set, giving the UI a ready-made color intensity.
    """
    finite = [d.nn_distance for d in discords if math.isfinite(d.nn_distance)]
    top = max(finite) if finite else 0.0
    rows: list[dict] = []
    for rank, d in enumerate(discords, start=1):
        nn = _finite_or_none(d.nn_distance)
        severity = float(d.nn_distance / top) if (top > 0 and nn is not None) else None
        rows.append(
            {
                "jobId": job_id,
                "rank": rank,
                "idx": int(d.index),
                "nnDist": nn,
                "severity": severity,
            }
        )
    return rows


def arc_curve_rows(job_id: str, cac: np.ndarray) -> list[dict]:
    """One row per index for the ``arc_curve`` table (the segmentation CAC line).

    Low ``cac`` marks a likely regime boundary. Non-finite values round-trip as nulls.
    """
    cac = np.asarray(cac, dtype=np.float64)
    return [
        {"jobId": job_id, "idx": int(idx), "cac": _finite_or_none(cac[idx])}
        for idx in range(cac.shape[0])
    ]


def segment_rows(job_id: str, boundaries: Iterable) -> list[dict]:
    """Rows for the ``segments`` table: detected regime change points, best (lowest CAC)
    first. Accepts an iterable of :class:`~tsmp.segment.fluss.RegimeBoundary`."""
    rows: list[dict] = []
    for rank, b in enumerate(boundaries, start=1):
        rows.append(
            {
                "jobId": job_id,
                "rank": rank,
                "boundaryIdx": int(b.index),
                "cac": _finite_or_none(float(b.cac)),
            }
        )
    return rows


def chain_rows(job_id: str, chains: Iterable, sub_len: int) -> list[dict]:
    """Rows for the ``chain_links`` table: one row per chain member.

    ``chainRank`` orders chains (rank 1 = longest) and ``linkOrder`` orders members
    within a chain from head (earliest) to tail (latest). Accepts an iterable of
    :class:`~tsmp.chains.chains.Chain`.
    """
    rows: list[dict] = []
    for chain_rank, chain in enumerate(chains, start=1):
        for link_order, idx in enumerate(chain.indices):
            rows.append(
                {
                    "jobId": job_id,
                    "chainRank": chain_rank,
                    "linkOrder": link_order,
                    "idx": int(idx),
                    "subLen": int(sub_len),
                }
            )
    return rows


# --------------------------------------------------------------------------- AB-join

# Series-id convention for two-series (AB-join) results: 0 = series A (baseline /
# "before"), 1 = series B (comparison / "after"). The self-join tables carry these on the
# added seriesId / seriesA / seriesB columns; single-series jobs leave them null.
AB_SERIES_A = 0
AB_SERIES_B = 1


def ab_mp_result_rows(job_id: str, profile: ABMatrixProfile) -> list[dict]:
    """``mp_result`` rows for both directions of an AB-join profile.

    Emits the A→B profile tagged ``seriesId = 0`` (each ``mp``/``mpi`` is A-window ``idx``'s
    distance to, and index of, its nearest neighbour **in B**) and the B→A profile tagged
    ``seriesId = 1``. This lets the UI draw a matrix-profile lane under either series.
    """
    a_profile = MatrixProfile(mp=profile.pab, mpi=profile.ipab, m=profile.m, minlag=0)
    b_profile = MatrixProfile(mp=profile.pba, mpi=profile.ipba, m=profile.m, minlag=0)
    return (
        mp_result_rows(job_id, a_profile, series_id=AB_SERIES_A)
        + mp_result_rows(job_id, b_profile, series_id=AB_SERIES_B)
    )


def ab_motif_pair_rows(job_id: str, motifs: Iterable[ABMotif], sub_len: int) -> list[dict]:
    """Rows for the ``motif_pairs`` table from AB motifs (best-first).

    ``idxA`` is the start in series A and ``idxB`` the start in series B; the ``seriesA`` /
    ``seriesB`` columns record which series each endpoint indexes so the UI can highlight the
    matched span on the correct lane (unlike a self-join, the two indices are NOT sorted —
    they live in different series).
    """
    rows: list[dict] = []
    for rank, motif in enumerate(motifs, start=1):
        rows.append(
            {
                "jobId": job_id,
                "rank": rank,
                "idxA": int(motif.idx_a),
                "idxB": int(motif.idx_b),
                "seriesA": AB_SERIES_A,
                "seriesB": AB_SERIES_B,
                "dist": float(motif.dist),
                "subLen": int(sub_len),
            }
        )
    return rows


def ab_discord_rows(
    job_id: str,
    discords: list[ABDiscord],
    series_id: int = AB_SERIES_B,
) -> list[dict]:
    """Rows for the ``discords`` table from AB novelties, best (most novel) first.

    ``severity`` is the nearest-neighbour distance scaled to 0..1 against the most novel
    result (as for self-join discords). ``seriesId`` marks which series the novelty lives in
    (default 1 = the comparison series B).
    """
    finite = [d.nn_distance for d in discords if math.isfinite(d.nn_distance)]
    top = max(finite) if finite else 0.0
    rows: list[dict] = []
    for rank, d in enumerate(discords, start=1):
        nn = _finite_or_none(d.nn_distance)
        severity = float(d.nn_distance / top) if (top > 0 and nn is not None) else None
        rows.append(
            {
                "jobId": job_id,
                "rank": rank,
                "seriesId": int(series_id),
                "idx": int(d.index),
                "nnDist": nn,
                "severity": severity,
            }
        )
    return rows


# ----------------------------------------------------------- Multidimensional (mSTAMP)

# A multidimensional (mSTAMP) result spans several time-aligned channels of ONE asset. The
# motif / discord itself lands in the usual `motif_pairs` / `discords` tables (both indices
# live on the shared clock); the `dims` string on a motif pair lists the participating
# channel indices best-first, and the `md_dimensions` table records per-channel participation
# for both motifs and discords (so the UI can dim non-participating sensor lanes).


def mdim_motif_pair_rows(job_id: str, motifs: Iterable[MDimMotif], sub_len: int) -> list[dict]:
    """Rows for the ``motif_pairs`` table from multidimensional motifs (best-first).

    ``idxA`` / ``idxB`` are the matched window starts on the common clock; ``dims`` is the
    comma-separated list of participating channel indices (best-agreeing first) and ``numDims``
    their count, so the UI can highlight the motif span across exactly those sensor lanes.
    """
    rows: list[dict] = []
    for rank, motif in enumerate(motifs, start=1):
        lo, hi = sorted((int(motif.idx_a), int(motif.idx_b)))
        rows.append(
            {
                "jobId": job_id,
                "rank": rank,
                "idxA": lo,
                "idxB": hi,
                "dist": float(motif.dist),
                "subLen": int(sub_len),
                "numDims": int(motif.n_dims),
                "dims": ",".join(str(int(d)) for d in motif.dims),
            }
        )
    return rows


def mdim_dimension_rows(job_id: str, items: Iterable, kind: str) -> list[dict]:
    """Per-channel participation rows (``md_dimensions``) for multidimensional results.

    ``kind`` is ``"MOTIF"`` or ``"DISCORD"``. One row per channel that participated in each
    result, tagged with the channel index (``seriesId``), its per-dimension z-normalized
    distance for the matched pair, and ``included = true``.
    """
    rows: list[dict] = []
    for rank, item in enumerate(items, start=1):
        dims = list(getattr(item, "dims", []) or [])
        dim_dists = list(getattr(item, "dim_dists", []) or [])
        for pos, dim in enumerate(dims):
            dist = dim_dists[pos] if pos < len(dim_dists) else None
            rows.append(
                {
                    "jobId": job_id,
                    "rank": rank,
                    "resultKind": kind,
                    "seriesId": int(dim),
                    "dist": _finite_or_none(float(dist)) if dist is not None else None,
                    "included": True,
                }
            )
    return rows


def mdim_discord_rows(job_id: str, discords: Iterable[MDimDiscord]) -> list[dict]:
    """Rows for the ``discords`` table from multidimensional novelties (most novel first).

    ``severity`` scales the multidimensional nearest-neighbour distance to 0..1 against the
    most novel result (as for single-series discords). ``numDims`` records how many channels
    define the novelty; per-channel detail lives in ``md_dimensions``.
    """
    discords = list(discords)
    finite = [d.nn_distance for d in discords if math.isfinite(d.nn_distance)]
    top = max(finite) if finite else 0.0
    rows: list[dict] = []
    for rank, d in enumerate(discords, start=1):
        nn = _finite_or_none(d.nn_distance)
        severity = float(d.nn_distance / top) if (top > 0 and nn is not None) else None
        rows.append(
            {
                "jobId": job_id,
                "rank": rank,
                "idx": int(d.index),
                "nnDist": nn,
                "severity": severity,
                "numDims": int(d.n_dims),
            }
        )
    return rows


def consensus_member_rows(job_id: str, motif: ConsensusMotif, rank: int = 1) -> list[dict]:
    """Rows for the ``consensus_members`` table from a fleet consensus motif.

    One row per series: where the shared shape occurs in it (``idx``), its z-normalized
    distance from the central shape (0 for the central series), and ``isCentral`` on the
    reference series. ``seriesId`` (0..N-1) maps to the caller's ordered signal list.
    """
    rows: list[dict] = []
    for member in motif.members:
        rows.append(
            {
                "jobId": job_id,
                "rank": int(rank),
                "seriesId": int(member.series_id),
                "idx": int(member.index),
                "dist": _finite_or_none(float(member.distance)),
                "isCentral": bool(member.is_central),
            }
        )
    return rows
