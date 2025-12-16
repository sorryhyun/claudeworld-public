"""
Facades for coordinating FS-first operations with optional DB caching.

These facades own the FS↔DB sync boundary and ensure consistent data flow.
"""

from .player_facade import PlayerFacade
from .world_facade import WorldFacade

__all__ = ["PlayerFacade", "WorldFacade"]
