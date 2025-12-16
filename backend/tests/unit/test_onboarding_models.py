"""
Unit tests for onboarding input models.
"""

import pytest
from pydantic import ValidationError
from sdk.config.onboarding_inputs import (
    CompleteOnboardingInput,
    InitialLocation,
    InventoryItem,
    StatDefinition,
    StatSystem,
    WorldSeed,
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


class TestInitialLocation:
    """Test InitialLocation model."""

    def test_valid_initial_location(self):
        """Test creating a valid initial location."""
        loc = InitialLocation(
            name="abandoned_watchtower",
            display_name="Abandoned Watchtower",
            description="A crumbling stone tower overlooking the valley.",
        )
        assert loc.name == "abandoned_watchtower"
        assert loc.display_name == "Abandoned Watchtower"
        assert loc.position_x == 0
        assert loc.position_y == 0
        assert loc.adjacent_hints == []

    def test_initial_location_with_position(self):
        """Test location with custom position."""
        loc = InitialLocation(
            name="forest_clearing",
            display_name="Forest Clearing",
            description="A peaceful clearing.",
            position_x=5,
            position_y=-3,
        )
        assert loc.position_x == 5
        assert loc.position_y == -3

    def test_initial_location_with_adjacent_hints(self):
        """Test location with adjacent location hints."""
        loc = InitialLocation(
            name="village_square",
            display_name="Village Square",
            description="The heart of the village.",
            adjacent_hints=["tavern", "blacksmith", "town_hall"],
        )
        assert len(loc.adjacent_hints) == 3


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


class TestWorldSeed:
    """Test WorldSeed model."""

    def test_valid_world_seed(self):
        """Test creating a valid world seed."""
        seed = WorldSeed(
            stat_system=StatSystem(
                stats=[
                    StatDefinition(name="health", display="HP", default=100),
                    StatDefinition(name="mana", display="MP", default=50),
                ]
            ),
            initial_location=InitialLocation(
                name="starting_village",
                display_name="Starting Village",
                description="A peaceful village where your adventure begins.",
            ),
        )
        assert len(seed.stat_system.stats) == 2
        assert seed.initial_location.name == "starting_village"
        assert seed.initial_stats is None
        assert seed.initial_inventory == []
        assert seed.world_notes is None

    def test_world_seed_with_all_fields(self):
        """Test world seed with all optional fields."""
        seed = WorldSeed(
            stat_system=StatSystem(stats=[StatDefinition(name="health", display="HP", default=100)]),
            initial_location=InitialLocation(
                name="dark_cave",
                display_name="Dark Cave",
                description="A foreboding cave entrance.",
            ),
            initial_stats={"health": 80},
            initial_inventory=[InventoryItem(item_id="torch", name="Torch", quantity=2)],
            world_notes="This world emphasizes survival mechanics.",
        )
        assert seed.initial_stats["health"] == 80
        assert len(seed.initial_inventory) == 1
        assert seed.world_notes is not None

    def test_world_seed_json_schema(self):
        """Test that JSON schema can be generated for SDK structured output."""
        schema = WorldSeed.model_json_schema()
        assert "properties" in schema
        assert "stat_system" in schema["properties"]
        assert "initial_location" in schema["properties"]


class TestCompleteOnboardingInput:
    """Test CompleteOnboardingInput model."""

    # Lore must be at least 100 characters
    VALID_LORE = (
        "The world has fallen into darkness. Ancient evils stir in forgotten places. "
        "Heroes must rise to face the growing threat before all is lost to shadow."
    )

    def test_valid_complete_input(self):
        """Test creating a valid complete input."""
        input_data = CompleteOnboardingInput(
            genre="dark fantasy",
            theme="survival and redemption",
            lore=self.VALID_LORE,
            player_name="Hero",
        )
        assert input_data.genre == "dark fantasy"
        assert input_data.theme == "survival and redemption"
        assert input_data.lore.startswith("The world")
        assert input_data.player_name == "Hero"

    def test_complete_input_strips_whitespace(self):
        """Test that whitespace is stripped from fields."""
        input_data = CompleteOnboardingInput(
            genre="  sci-fi  ",
            theme="  exploration  ",
            lore=f"  {self.VALID_LORE}  ",
            player_name="  Captain  ",
        )
        assert input_data.genre == "sci-fi"
        assert input_data.theme == "exploration"
        assert input_data.lore == self.VALID_LORE
        assert input_data.player_name == "Captain"

    def test_complete_input_rejects_empty_strings(self):
        """Test that empty or whitespace-only strings are rejected."""
        with pytest.raises(ValidationError):
            CompleteOnboardingInput(
                genre="",
                theme="valid theme",
                lore=self.VALID_LORE,
                player_name="Hero",
            )

        with pytest.raises(ValidationError):
            CompleteOnboardingInput(
                genre="valid genre",
                theme="   ",  # whitespace only
                lore=self.VALID_LORE,
                player_name="Hero",
            )

    def test_complete_input_missing_required(self):
        """Test that missing required fields cause validation error."""
        with pytest.raises(ValidationError):
            CompleteOnboardingInput(genre="fantasy", theme="adventure", player_name="Hero")  # missing lore

    def test_complete_input_lore_too_short(self):
        """Test that lore with less than 100 characters is rejected."""
        with pytest.raises(ValidationError):
            CompleteOnboardingInput(
                genre="fantasy",
                theme="adventure",
                lore="Too short",
                player_name="Hero",
            )
