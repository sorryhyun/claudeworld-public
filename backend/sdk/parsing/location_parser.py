"""
Location parsing utilities for extracting location info from Task prompts.

This module provides functions to parse location information from various
prompt formats used when invoking the location_designer sub-agent.
"""

from __future__ import annotations

import hashlib
import re


def parse_location_from_task_prompt(prompt: str) -> dict | None:
    """
    Parse location info from a location_designer Task prompt.

    Handles various prompt formats including:
    - "Create 연남동 골목길 (Yeonnam-dong Alley), ..."
    - "Design a new location: [name]"
    - "name: [value], display_name: [value], position: (x, y)"
    - Adjacent to: [location_name]

    Args:
        prompt: The Task prompt string to parse

    Returns:
        Dict with keys: name, display_name, description, position, adjacent_to
        Or None if parsing fails
    """
    if not prompt:
        return None

    # Try to extract key-value pairs from the prompt
    result: dict = {}

    # Pattern 1: "Create X (English Name), ..." - common format for Korean locations
    # Matches: "Create 연남동 골목길 (Yeonnam-dong Alley),"
    create_match = re.search(
        r"Create\s+([^\(,]+?)\s*\(([^)]+)\)",
        prompt,
        re.IGNORECASE,
    )
    if create_match:
        korean_name = create_match.group(1).strip()
        english_name = create_match.group(2).strip()
        # Use English name for slug, Korean+English for display
        result["name"] = re.sub(r"[^a-zA-Z0-9]+", "_", english_name).lower().strip("_")
        result["display_name"] = f"{korean_name} ({english_name})"

    # Pattern 2: "Create X," without parenthetical English name
    if "name" not in result:
        create_simple = re.search(r"Create\s+([^,\n]+)", prompt, re.IGNORECASE)
        if create_simple:
            name_val = create_simple.group(1).strip()
            # Generate slug from the name (handle Korean by using transliteration or simple hash)
            ascii_part = re.sub(r"[^a-zA-Z0-9\s]", "", name_val)
            if ascii_part.strip():
                result["name"] = re.sub(r"\s+", "_", ascii_part.strip()).lower()
            else:
                # For pure Korean, create a slug from hash
                result["name"] = f"location_{hashlib.md5(name_val.encode()).hexdigest()[:8]}"
            result["display_name"] = name_val

    # Pattern 3: Explicit name field (most reliable for structured prompts)
    # Matches: name: dark_forest or "name": "dark_forest"
    if "name" not in result:
        name_match = re.search(
            r'["\']?name["\']?\s*[:=]\s*["\']?([a-zA-Z_][a-zA-Z0-9_]*)["\']?',
            prompt,
            re.IGNORECASE,
        )
        if name_match:
            result["name"] = name_match.group(1).strip().lower()

    # Pattern 4: display_name field
    display_patterns = [
        r'["\']?display_name["\']?\s*[:=]\s*["\']?([^"\'\n,]+)["\']?',
        r'Display Name\s*[:=]\s*["\']?([^"\'\n,]+)["\']?',
    ]
    for pattern in display_patterns:
        match = re.search(pattern, prompt, re.IGNORECASE)
        if match:
            result["display_name"] = match.group(1).strip()
            break

    # If no explicit name but we have display_name, derive name from it
    if "name" not in result and "display_name" in result:
        ascii_part = re.sub(r"[^a-zA-Z0-9\s]", "", result["display_name"])
        if ascii_part.strip():
            result["name"] = re.sub(r"\s+", "_", ascii_part.strip()).lower()
        else:
            result["name"] = f"location_{hashlib.md5(result['display_name'].encode()).hexdigest()[:8]}"

    # Pattern 5: Fallback - "location: X" or "Design location: X"
    if "name" not in result:
        loc_patterns = [
            r"Design.*location\s*[:=]\s*['\"]?([^\n'\",]+)['\"]?",
            r"location\s*[:=]\s*['\"]?([^\n'\",]+)['\"]?",
        ]
        for pattern in loc_patterns:
            match = re.search(pattern, prompt, re.IGNORECASE)
            if match:
                name_val = match.group(1).strip()
                ascii_part = re.sub(r"[^a-zA-Z0-9\s]", "", name_val)
                if ascii_part.strip():
                    result["name"] = re.sub(r"\s+", "_", ascii_part.strip()).lower()
                else:
                    result["name"] = f"location_{hashlib.md5(name_val.encode()).hexdigest()[:8]}"
                if "display_name" not in result:
                    result["display_name"] = name_val
                break

    # If we have name but no display_name, derive from name
    if "name" in result and "display_name" not in result:
        result["display_name"] = result["name"].replace("_", " ").title()

    # Look for position patterns (explicit coordinates)
    pos_patterns = [
        r"position\s*[:=]\s*\(?(\d+)[,\s]+(\d+)\)?",
        r"\((\d+)[,\s]+(\d+)\)",
    ]
    for pattern in pos_patterns:
        match = re.search(pattern, prompt, re.IGNORECASE)
        if match:
            result["position"] = (int(match.group(1)), int(match.group(2)))
            break

    # Default position if not found
    if "position" not in result:
        result["position"] = (0, 0)

    # Look for adjacent_to patterns - support Korean and English names
    adj_patterns = [
        r"[Aa]djacent\s+to\s*[:=]?\s*([^\n,]+?)(?:\n|Position|$)",
        r"adjacent[_\s]?to\s*[:=]\s*['\"]?([^'\"\n,]+)['\"]?",
        r"connected[_\s]?to\s*[:=]\s*['\"]?([^'\"\n,]+)['\"]?",
        r"near\s*[:=]\s*['\"]?([^'\"\n,]+)['\"]?",
    ]
    for pattern in adj_patterns:
        match = re.search(pattern, prompt, re.IGNORECASE)
        if match:
            adj_name = match.group(1).strip()
            # Generate slug for adjacent location
            ascii_part = re.sub(r"[^a-zA-Z0-9\s]", "", adj_name)
            if ascii_part.strip():
                adj_slug = re.sub(r"\s+", "_", ascii_part.strip()).lower()
            else:
                adj_slug = f"location_{hashlib.md5(adj_name.encode()).hexdigest()[:8]}"
            result["adjacent_to"] = [adj_slug]
            break

    # Validate we have at least name and display_name
    if "name" in result and "display_name" in result:
        return result

    return None
