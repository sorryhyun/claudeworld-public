"""
Item template validation against world catalogs.

Validates that item templates only reference stats, slots, and time domains
that exist in the world's configuration.
"""

import logging
from typing import Any

logger = logging.getLogger("ItemValidator")


class ItemValidator:
    """Validates item templates against world catalogs."""

    @staticmethod
    def validate_stat_references(
        item_template: dict[str, Any],
        stat_definitions: dict[str, Any],
    ) -> list[str]:
        """
        Check all stat references in item template exist in world stats.

        Args:
            item_template: The item template dict
            stat_definitions: Stats from stats.yaml

        Returns:
            List of invalid stat names found
        """
        valid_stats = set(stat_definitions.keys())
        invalid_refs = []

        # Check equippable.passive_effects
        equippable = item_template.get("equippable", {})
        for stat_name in equippable.get("passive_effects", {}).keys():
            if stat_name not in valid_stats:
                invalid_refs.append(f"equippable.passive_effects.{stat_name}")

        # Check usable.affordances
        usable = item_template.get("usable", {})
        for i, affordance in enumerate(usable.get("affordances", [])):
            prefix = f"usable.affordances[{i}]"

            # Check requirements.stats
            for stat_name in affordance.get("requirements", {}).get("stats", {}).keys():
                if stat_name not in valid_stats:
                    invalid_refs.append(f"{prefix}.requirements.stats.{stat_name}")

            # Check cost.stat_changes
            for change in affordance.get("cost", {}).get("stat_changes", []):
                if change.get("stat") not in valid_stats:
                    invalid_refs.append(f"{prefix}.cost.stat_changes.{change.get('stat')}")

            # Check effects.stat_changes
            for change in affordance.get("effects", {}).get("stat_changes", []):
                if change.get("stat") not in valid_stats:
                    invalid_refs.append(f"{prefix}.effects.stat_changes.{change.get('stat')}")

        return invalid_refs

    @staticmethod
    def validate_slot_reference(
        slot: str,
        slot_catalog: dict[str, Any],
    ) -> bool:
        """
        Check if equipment slot exists in world slot catalog.

        Args:
            slot: The slot name to validate
            slot_catalog: Equipment slots from world config

        Returns:
            True if slot exists or catalog is empty (no validation)
        """
        if not slot_catalog:
            # No slot catalog defined - skip validation
            return True
        return slot in slot_catalog

    @staticmethod
    def validate_time_domain(
        domain: str,
        time_domains: dict[str, Any],
    ) -> bool:
        """
        Check if time domain exists in world config.

        Args:
            domain: The time domain name to validate
            time_domains: Time domains from world config

        Returns:
            True if domain exists or catalog is empty (no validation)
        """
        if not time_domains:
            # No time domains defined - skip validation
            return True
        return domain in time_domains

    @staticmethod
    def validate_recharge_event(
        event: str,
        recharge_events: dict[str, Any],
    ) -> bool:
        """
        Check if recharge event exists in world config.

        Args:
            event: The recharge event name to validate
            recharge_events: Recharge events from world config

        Returns:
            True if event exists or catalog is empty (no validation)
        """
        if not recharge_events:
            return True
        return event in recharge_events

    @classmethod
    def validate_item_template(
        cls,
        item_template: dict[str, Any],
        stat_definitions: dict[str, Any] | None = None,
        slot_catalog: dict[str, Any] | None = None,
        time_domains: dict[str, Any] | None = None,
        recharge_events: dict[str, Any] | None = None,
    ) -> dict[str, list[str]]:
        """
        Comprehensive validation of an item template.

        Returns:
            Dict with keys 'errors' and 'warnings', each containing list of messages
        """
        errors = []
        warnings = []

        # Validate stat references
        if stat_definitions:
            invalid_stats = cls.validate_stat_references(item_template, stat_definitions)
            for ref in invalid_stats:
                errors.append(f"Invalid stat reference: {ref}")

        # Validate slot reference
        equippable = item_template.get("equippable", {})
        if equippable.get("slot"):
            if slot_catalog and not cls.validate_slot_reference(equippable["slot"], slot_catalog):
                errors.append(f"Invalid equipment slot: {equippable['slot']}")

        # Validate time domains and recharge events in affordances
        usable = item_template.get("usable", {})
        for i, affordance in enumerate(usable.get("affordances", [])):
            # Check cooldown domain
            cooldown = affordance.get("cooldown", {})
            if cooldown.get("domain"):
                if time_domains and not cls.validate_time_domain(cooldown["domain"], time_domains):
                    warnings.append(f"Unknown time domain in affordance[{i}]: {cooldown['domain']}")

            # Check recharge event
            charges = affordance.get("charges", {})
            recharge = charges.get("recharge", {})
            if recharge.get("event"):
                if recharge_events and not cls.validate_recharge_event(recharge["event"], recharge_events):
                    warnings.append(f"Unknown recharge event in affordance[{i}]: {recharge['event']}")

        return {"errors": errors, "warnings": warnings}
