#!/usr/bin/env python3
"""
Generate ClaudeWorld application icon (.ico) and favicon (.svg).

Creates a simple, distinctive globe icon with a warm coral color scheme.
Produces:
  - assets/icon.ico  (multi-size Windows icon: 16, 32, 48, 64, 128, 256)
  - frontend/public/favicon.svg (scalable favicon for web)
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

# ClaudeWorld brand colors
BG_COLOR = (232, 114, 92)  # Warm coral (#E8725C)
FG_COLOR = (255, 255, 255)  # White
ACCENT_COLOR = (200, 85, 65)  # Darker coral for depth


def draw_globe_icon(size: int) -> Image.Image:
    """Draw a globe icon at the given size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = max(1, size // 16)
    cx, cy = size // 2, size // 2
    radius = size // 2 - margin

    # Background circle
    draw.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        fill=BG_COLOR,
    )

    # Globe lines (meridians and parallels) - only draw if size >= 32
    if size >= 32:
        line_width = max(1, size // 32)

        # Equator (horizontal line through center)
        draw.arc(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            start=0,
            end=360,
            fill=FG_COLOR,
            width=line_width,
        )

        # Horizontal parallels
        for offset_ratio in [0.35, 0.7]:
            offset = int(radius * offset_ratio)
            # Upper parallel
            half_w = int(math.sqrt(max(0, radius**2 - offset**2)))
            if half_w > 2:
                draw.arc(
                    [cx - half_w, cy - offset - half_w // 3, cx + half_w, cy - offset + half_w // 3],
                    start=0,
                    end=360,
                    fill=(*FG_COLOR, 180),
                    width=line_width,
                )
                # Lower parallel
                draw.arc(
                    [cx - half_w, cy + offset - half_w // 3, cx + half_w, cy + offset + half_w // 3],
                    start=0,
                    end=360,
                    fill=(*FG_COLOR, 180),
                    width=line_width,
                )

        # Central meridian (vertical ellipse)
        meridian_w = radius // 3
        draw.arc(
            [cx - meridian_w, cy - radius, cx + meridian_w, cy + radius],
            start=0,
            end=360,
            fill=(*FG_COLOR, 200),
            width=line_width,
        )

        # Side meridian
        if size >= 48:
            meridian_w2 = int(radius * 0.7)
            draw.arc(
                [cx - meridian_w2, cy - radius, cx + meridian_w2, cy + radius],
                start=0,
                end=360,
                fill=(*FG_COLOR, 140),
                width=line_width,
            )

        # Outer ring (globe border)
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            outline=FG_COLOR,
            width=max(1, size // 20),
        )
    else:
        # For very small sizes, just draw a simple circle with cross
        line_width = max(1, size // 16)
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            outline=FG_COLOR,
            width=line_width,
        )
        # Vertical line
        draw.line(
            [(cx, cy - radius + line_width), (cx, cy + radius - line_width)],
            fill=(*FG_COLOR, 180),
            width=line_width,
        )
        # Horizontal line
        draw.line(
            [(cx - radius + line_width, cy), (cx + radius - line_width, cy)],
            fill=(*FG_COLOR, 180),
            width=line_width,
        )

    return img


def generate_ico(output_path: Path):
    """Generate multi-size .ico file."""
    sizes = [16, 32, 48, 64, 128, 256]
    images = [draw_globe_icon(s) for s in sizes]

    # Save as ICO with all sizes
    images[0].save(
        output_path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=images[1:],
    )
    print(f"Generated: {output_path} ({len(sizes)} sizes: {sizes})")


def generate_favicon_svg(output_path: Path):
    """Generate SVG favicon for the web frontend."""
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <circle cx="128" cy="128" r="120" fill="#E8725C"/>
  <!-- Globe border -->
  <circle cx="128" cy="128" r="110" fill="none" stroke="white" stroke-width="8"/>
  <!-- Equator -->
  <line x1="18" y1="128" x2="238" y2="128" stroke="white" stroke-width="5" opacity="0.8"/>
  <!-- Parallels -->
  <ellipse cx="128" cy="78" rx="90" ry="12" fill="none" stroke="white" stroke-width="4" opacity="0.6"/>
  <ellipse cx="128" cy="178" rx="90" ry="12" fill="none" stroke="white" stroke-width="4" opacity="0.6"/>
  <!-- Meridians -->
  <ellipse cx="128" cy="128" rx="36" ry="110" fill="none" stroke="white" stroke-width="5" opacity="0.7"/>
  <ellipse cx="128" cy="128" rx="80" ry="110" fill="none" stroke="white" stroke-width="4" opacity="0.5"/>
</svg>"""
    output_path.write_text(svg.strip())
    print(f"Generated: {output_path}")


def main():
    project_root = Path(__file__).parent.parent

    # Create assets directory
    assets_dir = project_root / "assets"
    assets_dir.mkdir(exist_ok=True)

    # Generate .ico
    generate_ico(assets_dir / "icon.ico")

    # Generate SVG favicon
    generate_favicon_svg(project_root / "frontend" / "public" / "favicon.svg")


if __name__ == "__main__":
    main()
