"""Semantic segmentation (FLUSS/FLOSS) — operating-regime change detection."""

from tsmp.segment.fluss import (
    arc_counts,
    corrected_arc_curve,
    find_regimes,
    RegimeBoundary,
)

__all__ = [
    "arc_counts",
    "corrected_arc_curve",
    "find_regimes",
    "RegimeBoundary",
]
