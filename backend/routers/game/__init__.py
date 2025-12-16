"""
Game routes for TRPG gameplay.

This module combines all game-related routers:
- worlds: World management (create, list, get, delete, enter, reset, import)
- actions: Player actions (submit action, triggers turn)
- locations: Location management (list, travel, update label)
- state: Game state queries (stats, inventory, turn count)
- polling: Poll for updates (messages, state changes)
"""

from fastapi import APIRouter

from . import actions, locations, polling, state, worlds

router = APIRouter(prefix="/worlds", tags=["Game"])

# Include world routes at root level (no additional prefix)
router.include_router(worlds.router)

# Include sub-routers for nested routes
router.include_router(actions.router)
router.include_router(locations.router)
router.include_router(state.router)
router.include_router(polling.router)
