"""
Router for serving readme/documentation content.
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse

router = APIRouter()

# Root directory of the project (where readme files are located)
PROJECT_ROOT = Path(__file__).parent.parent.parent


@router.get("/readme", response_class=PlainTextResponse)
async def get_readme(
    lang: str = Query(default="en", regex="^(en|ko|jp)$", description="Language code (en, ko, or jp)"),
) -> str:
    """
    Get the readme content for the specified language.

    Returns the raw markdown content of en_readme.md, ko_readme.md, or jp_readme.md.
    """
    lang_to_file = {
        "ko": "ko_readme.md",
        "jp": "jp_readme.md",
        "en": "en_readme.md",
    }
    filename = lang_to_file.get(lang, "en_readme.md")
    readme_path = PROJECT_ROOT / filename

    if not readme_path.exists():
        raise HTTPException(status_code=404, detail=f"Readme file not found: {filename}")

    try:
        content = readme_path.read_text(encoding="utf-8")
        return content
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read readme file: {str(e)}")
