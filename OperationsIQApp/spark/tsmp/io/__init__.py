"""Data-plane IO for the compute core (design spec §5.1, §6.4, P3).

Split into three concerns:

* :mod:`tsmp.io.results` — convert in-memory ``MatrixProfile`` / ``MompResult`` /
  ``DiscordResult`` objects into KQL-ready row dicts for the ``mp_result``,
  ``motif_pairs`` and ``discords`` tables.
* :mod:`tsmp.io.kql` — pure KQL *query-string builders* for bulk series reads, window
  slices, and interactive result retrieval. No cluster needed to build (or test) them.
* :mod:`tsmp.io.kusto` — a thin execution client that lazily imports the
  ``azure-kusto-*`` SDK, so importing :mod:`tsmp` never requires it.
"""

from tsmp.io.results import mp_result_rows, motif_pair_rows, discord_rows
from tsmp.io import kql

__all__ = ["mp_result_rows", "motif_pair_rows", "discord_rows", "kql"]
