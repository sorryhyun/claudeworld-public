"""
Conftest for integration tests.

Automatically applies the 'integration' marker to all tests in this directory.
"""

import pytest

# Apply 'integration' marker to all tests in this directory
pytestmark = pytest.mark.integration
