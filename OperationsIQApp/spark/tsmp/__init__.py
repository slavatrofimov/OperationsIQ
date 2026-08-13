"""tsmp — Time-Series Matrix Profile compute core.

Single-node, NumPy/SciPy reference implementation of the primitives that power the
Fabric Motif & Discord Explorer:

* ``common``  — moving statistics, PAA downsampling, MASS distance profiles.
* ``momp``    — exact Matrix Profile (MPX) and MOMP motif discovery (anytime).
* ``damp``    — discord / anomaly discovery (exact + DAMP early-abandon).
* ``datagen`` — synthetic series with planted motifs / discords for testing.

This package is deliberately framework-free (no PySpark import) so it can be unit
tested and validated against STUMPY on a laptop. The P2 phase wraps these functions
in Spark for distributed execution; the public function signatures are designed so
that wrapping requires no change to the numerical core.
"""

from tsmp.common.paa import paa
from tsmp.common.stats import moving_mean_std, muinvn
from tsmp.common.mass import mass
from tsmp.momp.mpx import mpx, matrix_profile, mpx_lr, LRMatrixProfile
from tsmp.momp.momp import momp, momp_anytime, MompResult
from tsmp.damp.damp import discords, damp, DiscordResult
from tsmp.segment.fluss import corrected_arc_curve, find_regimes, RegimeBoundary
from tsmp.chains.chains import unanchored_chain, top_k_chains, chain_drift, Chain
from tsmp.abjoin.abjoin import (
    ab_matrix_profile,
    ab_motifs,
    ab_discords,
    ABMatrixProfile,
    ABMotif,
    ABDiscord,
)
from tsmp.mstamp.mstamp import (
    mstamp,
    mstamp_motifs,
    mstamp_discords,
    participating_dims,
    MStampProfile,
    MDimMotif,
    MDimDiscord,
)
from tsmp.ostinato.ostinato import (
    ostinato,
    ConsensusMotif,
    ConsensusMember,
)

__all__ = [
    "paa",
    "moving_mean_std",
    "muinvn",
    "mass",
    "mpx",
    "matrix_profile",
    "mpx_lr",
    "LRMatrixProfile",
    "momp",
    "momp_anytime",
    "MompResult",
    "discords",
    "damp",
    "DiscordResult",
    "corrected_arc_curve",
    "find_regimes",
    "RegimeBoundary",
    "unanchored_chain",
    "top_k_chains",
    "chain_drift",
    "Chain",
    "ab_matrix_profile",
    "ab_motifs",
    "ab_discords",
    "ABMatrixProfile",
    "ABMotif",
    "ABDiscord",
    "mstamp",
    "mstamp_motifs",
    "mstamp_discords",
    "participating_dims",
    "MStampProfile",
    "MDimMotif",
    "MDimDiscord",
    "ostinato",
    "ConsensusMotif",
    "ConsensusMember",
]
