"""Headless Matrix Profile pattern-discovery entrypoint (optional Spark Job
Definition). The interactive SPA path submits tsmp inline via Livy, so this
standalone job is only for batch/scheduled runs.

Placeholder that documents the expected contract; wire it to the same tsmp
compute the SPA uses (see OperationsIQApp/spark/ and docs/spark-compute).
"""
import sys


def main(argv):
    print("Operations IQ pattern analysis job — configure inputs via commandLineArguments.")
    # TODO: read Eventhouse query params from argv, run tsmp, write results to the lakehouse.
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
