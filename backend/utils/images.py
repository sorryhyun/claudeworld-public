"""
Image compression utilities for reducing API payload size.

This module converts images to WebP format for better compression
before storing them in the database and sending them to the Claude API.
"""

import base64
import io
import os
from typing import Tuple

from PIL import Image


class ImageCompressionConfig:
    """Configuration for image compression settings."""

    # WebP quality (1-100)
    WEBP_QUALITY = int(os.getenv("IMAGE_WEBP_QUALITY", "85"))  # Default: 85

    # Convert all images to WebP for best compression
    # WebP provides 25-35% better compression than JPEG/PNG and supports transparency
    CONVERT_TO_WEBP = os.getenv("IMAGE_CONVERT_TO_WEBP", "true").lower() == "true"


def compress_image_base64(
    base64_data: str,
    media_type: str,
    webp_quality: int = ImageCompressionConfig.WEBP_QUALITY,
) -> Tuple[str, str]:
    """
    Convert a base64-encoded image to WebP format for compression.

    Args:
        base64_data: Base64-encoded image data (without data URL prefix)
        media_type: MIME type of the image (e.g., 'image/png', 'image/jpeg')
        webp_quality: WebP compression quality (1-100)

    Returns:
        Tuple of (compressed_base64_data, media_type)
        Media type will be 'image/webp' if conversion is enabled

    Raises:
        ValueError: If the image data is invalid or cannot be processed
    """
    # If WebP conversion is disabled, return original
    if not ImageCompressionConfig.CONVERT_TO_WEBP:
        return base64_data, media_type

    try:
        # Decode base64 to bytes
        image_bytes = base64.b64decode(base64_data)

        # Open image with Pillow
        image = Image.open(io.BytesIO(image_bytes))

        # Convert to WebP
        compress_kwargs = {"quality": webp_quality, "method": 6}  # method=6 for better compression

        # For images with transparency, handle palette mode
        if image.mode == "P":
            image = image.convert("RGBA")

        # Save as WebP
        output_buffer = io.BytesIO()
        image.save(output_buffer, format="WEBP", **compress_kwargs)
        compressed_bytes = output_buffer.getvalue()

        # Encode back to base64
        compressed_base64 = base64.b64encode(compressed_bytes).decode("utf-8")

        return compressed_base64, "image/webp"

    except Exception as e:
        # If compression fails, log error and return original
        # This ensures the app doesn't break if there's an issue
        print(f"Image compression failed: {e}")
        return base64_data, media_type
