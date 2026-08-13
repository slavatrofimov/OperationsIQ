"""Shared pytest fixtures / helpers for the tsmp compute-core tests."""
import numpy as np
import pytest


@pytest.fixture
def rng():
    return np.random.default_rng(20250701)
