"""
Access control domain logic for world ownership and permissions.

This module centralizes access control checks to eliminate duplicate code
and provide a single source of truth for authorization logic.
"""

from fastapi import HTTPException

from domain.value_objects.enums import UserRole


class AccessControl:
    """Domain logic for access control and authorization."""

    @staticmethod
    def can_access_world(user_id: str, user_role: UserRole, world_owner_id: str) -> bool:
        """
        Check if a user can access a world.

        Args:
            user_id: The user's ID
            user_role: The user's role (admin or guest)
            world_owner_id: The owner ID of the world

        Returns:
            True if user can access the world, False otherwise

        Access is granted if:
        - User is an admin (can access all worlds), OR
        - User is the owner of the world
        """
        return user_role == UserRole.ADMIN or user_id == world_owner_id

    @staticmethod
    def raise_if_no_access(user_id: str, user_role: UserRole, world_owner_id: str) -> None:
        """
        Raise HTTPException if user cannot access the world.

        Args:
            user_id: The user's ID
            user_role: The user's role (admin or guest)
            world_owner_id: The owner ID of the world

        Raises:
            HTTPException: 403 Forbidden if user lacks access
        """
        if not AccessControl.can_access_world(user_id, user_role, world_owner_id):
            raise HTTPException(status_code=403, detail="Not your world")
