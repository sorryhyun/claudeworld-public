"""
Localization domain logic for language-specific messages.

This module centralizes i18n/l10n message generation to provide
a single source of truth for language-specific content.

Message templates are loaded from sdk/config/localization.yaml (hot-reloaded).
"""

from i18n.korean import format_with_particles

from domain.value_objects.enums import Language

# Map Language enum to YAML keys
_LANG_MAP = {
    Language.ENGLISH: "en",
    Language.KOREAN: "ko",
    Language.JAPANESE: "jp",
}


def _get_message(section: str, key: str, language: Language, **kwargs) -> str:
    """
    Get a localized message from the YAML config.

    Args:
        section: Top-level section in localization.yaml (e.g., "onboarding", "game")
        key: Message key within the section (e.g., "trigger", "arrival")
        language: Target language
        **kwargs: Variables for template substitution

    Returns:
        Localized message with variables substituted
    """
    from sdk.loaders import get_localization_config

    config = get_localization_config()
    lang_key = _LANG_MAP.get(language, "en")

    # Get message template, fall back to English
    section_config = config.get(section, {})
    message_config = section_config.get(key, {})
    template = message_config.get(lang_key) or message_config.get("en", "")

    # Apply Korean particle formatting if Korean, otherwise simple format
    if language == Language.KOREAN and kwargs:
        return format_with_particles(template, **kwargs)
    elif kwargs:
        return template.format(**kwargs)
    return template


class Localization:
    """Domain logic for localized message generation."""

    @staticmethod
    def get_onboarding_message(language: Language) -> str:
        """
        Get the onboarding trigger message for the given language.

        Args:
            language: Target language for the message

        Returns:
            Localized onboarding message
        """
        return _get_message("onboarding", "trigger", language)

    @staticmethod
    def get_arrival_message(user_name: str, location_name: str, language: Language) -> str:
        """
        Get the arrival message for entering a location.

        Args:
            user_name: Name of the user/player
            location_name: Name of the location being entered
            language: Target language for the message

        Returns:
            Localized arrival message with user and location names
        """
        return _get_message(
            "game",
            "arrival",
            language,
            user_name=user_name,
            location_name=location_name,
        )
