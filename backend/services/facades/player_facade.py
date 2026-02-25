"""
Player state facade - FS-first player state management.

This facade owns the FS↔DB sync boundary for player state:
- FS (player.yaml) is the authoritative source
- DB (PlayerState) is an optional cache for fast reads/polling

All mutations go through this facade to ensure consistency.
"""

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from domain.entities.world_models import PlayerState as FSPlayerState
from domain.services.player_rules import (
    InventoryItem,
    apply_stat_changes,
    merge_inventory_item,
    remove_inventory_item,
)
from domain.services.player_state_serializer import PlayerStateSerializer

from services.player_service import PlayerService

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("PlayerFacade")


@dataclass
class StatChangeResult:
    """Result of a stat change operation."""

    old_stats: Dict[str, int]
    new_stats: Dict[str, int]
    changes_applied: Dict[str, int]


@dataclass
class InventoryChangeResult:
    """Result of an inventory change operation."""

    success: bool
    inventory: List[Dict[str, Any]]
    message: str


@dataclass
class TimeAdvanceResult:
    """Result of a time advancement operation."""

    old_time: Dict[str, int]
    new_time: Dict[str, int]
    minutes_advanced: int


class PlayerFacade:
    """
    FS-first player state management facade.

    Usage (FS-only):
        facade = PlayerFacade(world_name)
        result = facade.update_stats({"health": -10, "experience": 50})

    Usage (with DB sync for polling):
        facade = PlayerFacade(world_name, db=db_session, world_id=123)
        result = await facade.update_stats({"health": -10})  # Syncs to DB
    """

    def __init__(
        self,
        world_name: str,
        db: Optional["AsyncSession"] = None,
        world_id: Optional[int] = None,
    ):
        """
        Initialize the facade for a specific world.

        Args:
            world_name: Name of the world (maps to worlds/{world_name}/)
            db: Optional DB session for cache sync
            world_id: Optional world ID for DB operations (required if db provided)
        """
        self.world_name = world_name
        self.db = db
        self.world_id = world_id

    def _load_state(self) -> Optional[FSPlayerState]:
        """Load current player state from FS."""
        return PlayerService.load_player_state(self.world_name)

    def _save_state(self, state: FSPlayerState) -> None:
        """Save player state to FS."""
        PlayerService.save_player_state(self.world_name, state)

    def _load_stat_definitions(self) -> Dict[str, Any]:
        """Load stat definitions from FS."""
        return PlayerService.load_stat_definitions(self.world_name)

    async def _sync_to_db(self, state: FSPlayerState) -> None:
        """
        Sync FS state to DB cache (for polling reads).

        This is a fire-and-forget operation - DB is just a cache.
        """
        if not self.db or not self.world_id:
            return

        try:
            from infrastructure.database import models
            from infrastructure.database.connection import serialized_write
            from sqlalchemy.future import select

            result = await self.db.execute(
                select(models.PlayerState).where(models.PlayerState.world_id == self.world_id)
            )
            db_state = result.scalar_one_or_none()

            if db_state:
                db_state.stats = PlayerStateSerializer.serialize_stats(state.stats)
                db_state.inventory = PlayerStateSerializer.serialize_inventory(state.inventory)
                async with serialized_write():
                    await self.db.commit()
                logger.debug(f"📥 Synced player state to DB cache for world {self.world_id}")
        except Exception as e:
            logger.warning(f"Failed to sync player state to DB: {e}")

    # =========================================================================
    # Stats Operations (FS-first)
    # =========================================================================

    async def update_stats(self, changes: Dict[str, int]) -> Optional[StatChangeResult]:
        """
        Update player stats (FS-first, then DB cache).

        Args:
            changes: Dict of stat_name -> delta (positive or negative)

        Returns:
            StatChangeResult with old/new values, or None if state not found
        """
        state = self._load_state()
        if not state:
            logger.warning(f"Player state not found for world: {self.world_name}")
            return None

        old_stats = state.stats.copy()
        stat_defs = self._load_stat_definitions()

        # Apply changes with clamping (using domain rules)
        new_stats = apply_stat_changes(state.stats, changes, stat_defs)
        state.stats = new_stats

        # Save to FS (authoritative)
        self._save_state(state)
        logger.info(f"📊 Updated stats for {self.world_name}: {changes}")

        # Sync to DB cache
        await self._sync_to_db(state)

        return StatChangeResult(
            old_stats=old_stats,
            new_stats=new_stats,
            changes_applied=changes,
        )

    def get_stats(self) -> Dict[str, int]:
        """Get current player stats from FS."""
        state = self._load_state()
        return state.stats if state else {}

    # =========================================================================
    # Inventory Operations (FS-first)
    # =========================================================================

    async def add_item(
        self,
        item_id: str,
        name: str,
        quantity: int = 1,
        description: Optional[str] = None,
        properties: Optional[Dict[str, Any]] = None,
    ) -> Optional[InventoryChangeResult]:
        """
        Add an item to inventory (FS-first, then DB cache).

        If item with same ID exists, quantity is added to existing.

        Args:
            item_id: Unique item identifier
            name: Display name
            quantity: Amount to add (default 1)
            description: Optional item description
            properties: Optional item properties dict

        Returns:
            InventoryChangeResult, or None if state not found
        """
        state = self._load_state()
        if not state:
            logger.warning(f"Player state not found for world: {self.world_name}")
            return None

        # Create domain item and merge (using domain rules)
        item = InventoryItem(
            id=item_id,
            name=name,
            quantity=quantity,
            description=description,
            properties=properties,
        )
        new_inventory = merge_inventory_item(state.inventory, item)
        state.inventory = new_inventory

        # Save to FS (authoritative)
        self._save_state(state)
        logger.info(f"📦 Added item to {self.world_name}: {name} x{quantity}")

        # Sync to DB cache
        await self._sync_to_db(state)

        return InventoryChangeResult(
            success=True,
            inventory=new_inventory,
            message=f"Added {name} x{quantity}",
        )

    async def remove_item(
        self,
        item_id: str,
        quantity: int = 1,
    ) -> Optional[InventoryChangeResult]:
        """
        Remove an item from inventory (FS-first, then DB cache).

        Args:
            item_id: Item ID to remove
            quantity: Amount to remove (default 1)

        Returns:
            InventoryChangeResult with success status, or None if state not found
        """
        state = self._load_state()
        if not state:
            logger.warning(f"Player state not found for world: {self.world_name}")
            return None

        # Remove item (using domain rules)
        new_inventory, success, remaining = remove_inventory_item(state.inventory, item_id, quantity)

        if not success:
            return InventoryChangeResult(
                success=False,
                inventory=state.inventory,
                message=f"Cannot remove {quantity} of item {item_id} (only {remaining} available)",
            )

        state.inventory = new_inventory

        # Save to FS (authoritative)
        self._save_state(state)
        logger.info(f"📦 Removed item from {self.world_name}: {item_id} x{quantity}")

        # Sync to DB cache
        await self._sync_to_db(state)

        return InventoryChangeResult(
            success=True,
            inventory=new_inventory,
            message=f"Removed {item_id} x{quantity}",
        )

    def get_inventory(self, resolved: bool = True) -> List[Dict[str, Any]]:
        """Get current inventory from FS.

        Args:
            resolved: If True, resolve item references to full data.
                     If False, return raw references from player.yaml.

        Returns:
            List of inventory items
        """
        if resolved:
            return PlayerService.get_resolved_inventory(self.world_name)
        else:
            state = self._load_state()
            return state.inventory if state else []

    # =========================================================================
    # Time Operations (FS-first)
    # =========================================================================

    async def advance_time(self, minutes: int) -> Optional[TimeAdvanceResult]:
        """
        Advance in-game time (FS-first, then DB cache).

        Handles day rollover at 24:00 (1440 minutes).

        Args:
            minutes: Number of minutes to advance

        Returns:
            TimeAdvanceResult with old/new time, or None if state not found
        """
        if minutes <= 0:
            return None

        state = self._load_state()
        if not state:
            logger.warning(f"Player state not found for world: {self.world_name}")
            return None

        old_time = state.game_time.copy()

        # Calculate new time
        total_minutes = state.game_time["hour"] * 60 + state.game_time["minute"] + minutes
        days_passed = total_minutes // 1440  # 1440 minutes per day
        remaining_minutes = total_minutes % 1440

        new_hour = remaining_minutes // 60
        new_minute = remaining_minutes % 60
        new_day = state.game_time["day"] + days_passed

        state.game_time = {
            "hour": new_hour,
            "minute": new_minute,
            "day": new_day,
        }

        # Save to FS (authoritative)
        self._save_state(state)
        logger.info(
            f"⏰ Advanced time for {self.world_name}: +{minutes}min -> {new_hour:02d}:{new_minute:02d} Day {new_day}"
        )

        # Sync to DB cache
        await self._sync_to_db(state)

        return TimeAdvanceResult(
            old_time=old_time,
            new_time=state.game_time,
            minutes_advanced=minutes,
        )

    def get_game_time(self) -> Dict[str, int]:
        """Get current game time from FS."""
        state = self._load_state()
        return state.game_time if state else {"hour": 8, "minute": 0, "day": 1}

    # =========================================================================
    # Combined Operations
    # =========================================================================

    async def apply_stat_calc_result(
        self,
        stat_changes: List[Dict[str, Any]],
        inventory_changes: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Apply results from Stat Calculator sub-agent (FS-first, then DB cache).

        This is the main entry point for mechanics_tools.py.

        Args:
            stat_changes: List of {"stat_name": str, "delta": int, "new_value": int}
            inventory_changes: List of {"action": "add"|"remove", "item_id": str, "name": str, ...}

        Returns:
            Dict with "stats_result" and "inventory_results" keys
        """
        results: Dict[str, Any] = {
            "stats_result": None,
            "inventory_results": [],
        }

        # Apply stat changes
        if stat_changes:
            changes = {sc["stat_name"]: sc["delta"] for sc in stat_changes}
            results["stats_result"] = await self.update_stats(changes)

        # Apply inventory changes
        for inv_change in inventory_changes:
            action = inv_change.get("action", "add")
            item_id = inv_change.get("item_id", "")
            name = inv_change.get("name", "")

            if not item_id:
                logger.warning(f"Skipping inventory change: missing item_id in {inv_change}")
                continue

            if action == "add":
                if not name:
                    logger.warning(f"Skipping add: missing name for item_id={item_id}")
                    continue
                result = await self.add_item(
                    item_id=item_id,
                    name=name,
                    quantity=inv_change.get("quantity", 1),
                    description=inv_change.get("description"),
                    properties=inv_change.get("properties"),
                )
            elif action == "remove":
                result = await self.remove_item(
                    item_id=item_id,
                    quantity=inv_change.get("quantity", 1),
                )
            else:
                logger.warning(f"Unknown inventory action: {action}")
                continue

            if result:
                results["inventory_results"].append(result)

        return results

