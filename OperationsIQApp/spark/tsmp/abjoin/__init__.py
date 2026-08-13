"""AB-join matrix profile (two-series comparison, design spec §7.4.1).

The self-join primitives in :mod:`tsmp.momp` answer "where does this window repeat
inside *one* series?". The **AB-join** answers "where does series A's shape appear in a
*different* series B?" — the substrate for the two highest-value multi-series recipes:

* **Compare two periods / machines** (AB motif): the pair ``(i in A, j in B)`` whose
  subsequences are most alike — before/after maintenance, or machine-vs-machine.
* **Novelty detection** (AB discord): the window in B that is *least* like anything in A —
  what changed / emerged relative to the baseline A.

Both reduce to the AB matrix profile ``P_AB[i] = min_j dist(A[i:i+m], B[j:j+m])``, which is
a stack of MASS distance profiles (:func:`tsmp.common.mass.mass`) — no exclusion zone is
needed because A and B are distinct series (there is no trivial self-match).
"""
from tsmp.abjoin.abjoin import (
    ABMatrixProfile,
    ABMotif,
    ABDiscord,
    ab_matrix_profile,
    ab_motifs,
    ab_discords,
)

__all__ = [
    "ABMatrixProfile",
    "ABMotif",
    "ABDiscord",
    "ab_matrix_profile",
    "ab_motifs",
    "ab_discords",
]
