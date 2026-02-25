"""
Facades for coordinating FS-first operations with optional DB caching.

These facades own the FS↔DB sync boundary and ensure consistent data flow.
"""

from .player_facade import PlayerFacade

__all__ = ["PlayerFacade"]
