"""Optional real-PySpark integration test.

Skipped automatically when PySpark (or a working JVM) is unavailable, so the core suite
never depends on a Spark runtime. When Spark *is* available this exercises the actual
``SparkContext`` map/reduce path and asserts it equals the single-node result.
"""
import numpy as np
import pytest

pyspark = pytest.importorskip("pyspark")

from tsmp.momp.mpx import mpx
from tsmp.damp.damp import discords
from tsmp import datagen


@pytest.fixture(scope="module")
def spark_context():
    import os
    import sys

    # The executor must launch the *same* interpreter that has numpy/scipy/tsmp,
    # and bind to loopback so the worker can connect back on locked-down hosts.
    os.environ["PYSPARK_PYTHON"] = sys.executable
    os.environ["PYSPARK_DRIVER_PYTHON"] = sys.executable
    os.environ.setdefault("SPARK_LOCAL_IP", "127.0.0.1")

    from pyspark import SparkConf, SparkContext

    conf = (
        SparkConf()
        .setMaster("local[2]")
        .setAppName("tsmp-parallel-itest")
        .set("spark.ui.enabled", "false")
        .set("spark.driver.host", "127.0.0.1")
        .set("spark.driver.bindAddress", "127.0.0.1")
        .set("spark.sql.shuffle.partitions", "4")
    )
    try:
        sc = SparkContext(conf=conf)
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"could not start local Spark: {exc}")
    sc.setLogLevel("ERROR")

    # Smoke-test the worker<->driver socket. Some locked-down hosts (e.g. Windows
    # with a firewall blocking loopback) start the context fine but cannot run a
    # task ("Python worker failed to connect back"). Skip cleanly there — the
    # decomposition itself is proven exact by the serial-mapper parity tests.
    try:
        assert sc.parallelize([1, 2, 3], 2).map(lambda x: x * 2).collect() == [2, 4, 6]
    except Exception as exc:  # pragma: no cover - environment dependent
        sc.stop()
        pytest.skip(f"local Spark cannot execute tasks in this environment: {exc}")

    yield sc
    sc.stop()


def test_spark_matrix_profile_matches_serial(spark_context):
    from tsmp.parallel.spark import spark_matrix_profile

    t = datagen.random_walk(400, seed=31)
    m = 28
    ref = mpx(t, m)
    par = spark_matrix_profile(spark_context, t, m, n_partitions=4)
    np.testing.assert_allclose(par.mp, ref.mp, atol=1e-9, rtol=0)
    np.testing.assert_array_equal(par.mpi, ref.mpi)


def test_spark_discords_match_serial(spark_context):
    from tsmp.parallel.spark import spark_discords

    t = datagen.random_walk(400, seed=32)
    m = 26
    ref = discords(t, m, k=2)
    par = spark_discords(spark_context, t, m, k=2, n_partitions=4)
    assert [d.index for d in par] == [d.index for d in ref]


def test_spark_nn_scan_matches_serial(spark_context):
    from tsmp.parallel.spark import spark_nn_scan

    t = datagen.random_walk(350, seed=33)
    m = 24
    ref = mpx(t, m)
    idxs = [0, 40, 120, 200, len(t) - m]
    scan = spark_nn_scan(spark_context, t, m, idxs, n_partitions=4)
    for i in idxs:
        d, _ = scan[i]
        assert d == pytest.approx(float(ref.mp[i]), abs=1e-6)
