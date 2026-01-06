"""
Unit tests for onboarding input models.
"""

import pytest
from pydantic import ValidationError
from sdk.config.onboarding_tool_definitions import (
    CompleteOnboardingInput,
    DraftWorldInput,
    InventoryItem,
    PersistWorldInput,
    StatDefinition,
    StatSystem,
)


class TestStatDefinition:
    """Test StatDefinition model."""

    def test_valid_stat_definition(self):
        """Test creating a valid stat definition."""
        stat = StatDefinition(
            name="health",
            display="HP",
            min=0,
            max=100,
            default=100,
        )
        assert stat.name == "health"
        assert stat.display == "HP"
        assert stat.min == 0
        assert stat.max == 100
        assert stat.default == 100
        assert stat.color is None

    def test_stat_definition_with_color(self):
        """Test stat definition with optional color."""
        stat = StatDefinition(
            name="mana",
            display="MP",
            default=50,
            color="#0066ff",
        )
        assert stat.color == "#0066ff"

    def test_stat_definition_unlimited_max(self):
        """Test stat with no maximum limit (e.g., gold)."""
        stat = StatDefinition(
            name="gold",
            display="Gold",
            min=0,
            max=None,
            default=100,
        )
        assert stat.max is None

    def test_stat_definition_missing_required(self):
        """Test that required fields cause validation error."""
        with pytest.raises(ValidationError):
            StatDefinition(name="health", display="HP")  # missing default


class TestStatSystem:
    """Test StatSystem model."""

    def test_valid_stat_system(self):
        """Test creating a valid stat system."""
        system = StatSystem(
            stats=[
                StatDefinition(name="health", display="HP", default=100),
                StatDefinition(name="mana", display="MP", default=50),
            ]
        )
        assert len(system.stats) == 2
        assert system.derived == []

    def test_stat_system_with_derived(self):
        """Test stat system with derived stats."""
        system = StatSystem(
            stats=[StatDefinition(name="strength", display="STR", default=10)],
            derived=[{"name": "attack", "formula": "strength * 2"}],
        )
        assert len(system.derived) == 1

    def test_stat_system_requires_at_least_one_stat(self):
        """Test that at least one stat is required."""
        with pytest.raises(ValidationError):
            StatSystem(stats=[])


class TestInventoryItem:
    """Test InventoryItem model."""

    def test_valid_inventory_item(self):
        """Test creating a valid inventory item."""
        item = InventoryItem(
            item_id="rusty_sword",
            name="Rusty Sword",
        )
        assert item.item_id == "rusty_sword"
        assert item.name == "Rusty Sword"
        assert item.quantity == 1
        assert item.description is None
        assert item.properties == {}

    def test_inventory_item_with_properties(self):
        """Test inventory item with custom properties."""
        item = InventoryItem(
            item_id="health_potion",
            name="Health Potion",
            description="Restores 25 HP",
            quantity=3,
            properties={"heal_amount": 25, "consumable": True},
        )
        assert item.quantity == 3
        assert item.properties["heal_amount"] == 25


class TestDraftWorldInput:
    """Test DraftWorldInput model."""

    def test_valid_draft_world(self):
        """Test creating a valid draft world input."""
        draft = DraftWorldInput(
            genre="dark fantasy",
            theme="survival and redemption",
            lore_summary="A world where magic comes at a terrible cost, and the ancient empire has fallen.",
        )
        assert draft.genre == "dark fantasy"
        assert draft.theme == "survival and redemption"
        assert len(draft.lore_summary) >= 50

    def test_draft_world_strips_whitespace(self):
        """Test that whitespace is stripped from fields."""
        draft = DraftWorldInput(
            genre="  sci-fi  ",
            theme="  exploration  ",
            lore_summary="  A vast galaxy awaits exploration in this futuristic setting with advanced technology.  ",
        )
        assert draft.genre == "sci-fi"
        assert draft.theme == "exploration"

    def test_draft_world_rejects_short_summary(self):
        """Test that lore summary must be at least 50 characters."""
        with pytest.raises(ValidationError):
            DraftWorldInput(
                genre="fantasy",
                theme="adventure",
                lore_summary="Too short",  # Less than 50 chars
            )

    def test_draft_world_json_schema(self):
        """Test that JSON schema can be generated for SDK structured output."""
        schema = DraftWorldInput.model_json_schema()
        assert "properties" in schema
        assert "genre" in schema["properties"]
        assert "theme" in schema["properties"]
        assert "lore_summary" in schema["properties"]


class TestPersistWorldInput:
    """Test PersistWorldInput model.

    This consolidates full lore with stat system and player state.
    """

    def test_valid_persist_world(self):
        """Test creating a valid persist world input."""
        persist = PersistWorldInput(
            lore="A comprehensive world lore that spans multiple paragraphs. " * 10,
            stat_system=StatSystem(
                stats=[
                    StatDefinition(name="health", display="HP", default=100),
                    StatDefinition(name="mana", display="MP", default=50),
                ]
            ),
        )
        assert len(persist.lore) >= 100
        assert len(persist.stat_system.stats) == 2
        assert persist.initial_stats is None
        assert persist.world_notes is None

    def test_persist_world_with_all_fields(self):
        """Test persist world with all optional fields."""
        persist = PersistWorldInput(
            lore="A comprehensive world lore that spans multiple paragraphs. " * 10,
            stat_system=StatSystem(stats=[StatDefinition(name="health", display="HP", default=100)]),
            initial_stats={"health": 80},
            world_notes="This world emphasizes survival mechanics.",
        )
        assert persist.initial_stats["health"] == 80
        assert persist.world_notes is not None

    def test_persist_world_rejects_short_lore(self):
        """Test that lore must be at least 100 characters."""
        with pytest.raises(ValidationError):
            PersistWorldInput(
                lore="Too short",  # Less than 100 chars
                stat_system=StatSystem(stats=[StatDefinition(name="health", display="HP", default=100)]),
            )

    def test_persist_world_json_schema(self):
        """Test that JSON schema can be generated for SDK structured output."""
        schema = PersistWorldInput.model_json_schema()
        assert "properties" in schema
        assert "lore" in schema["properties"]
        assert "stat_system" in schema["properties"]


class TestCompleteOnboardingInput:
    """Test CompleteOnboardingInput model.

    Note: genre, theme, and lore are now handled by draft_world and persist_world tools.
    CompleteOnboardingInput only handles the final phase transition with player_name.
    """

    def test_valid_complete_input(self):
        """Test creating a valid complete input."""
        input_data = CompleteOnboardingInput(player_name="Hero")
        assert input_data.player_name == "Hero"

    def test_complete_input_strips_whitespace(self):
        """Test that whitespace is stripped from player_name."""
        input_data = CompleteOnboardingInput(player_name="  Captain  ")
        assert input_data.player_name == "Captain"

    def test_complete_input_rejects_empty_player_name(self):
        """Test that empty or whitespace-only player_name is rejected."""
        with pytest.raises(ValidationError):
            CompleteOnboardingInput(player_name="")

        with pytest.raises(ValidationError):
            CompleteOnboardingInput(player_name="   ")  # whitespace only

    def test_complete_input_missing_player_name(self):
        """Test that missing player_name causes validation error."""
        with pytest.raises(ValidationError):
            CompleteOnboardingInput()
