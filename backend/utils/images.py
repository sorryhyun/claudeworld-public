"""
Image compression utilities for reducing API payload size.

This module provides functions to compress images before storing them in the database
and sending them to the Claude API, preventing "prompt too long" errors.
"""

import base64
import io
import os
from typing import Tuple

from PIL import Image


class ImageCompressionConfig:
    """Configuration for image compression settings."""

    # Maximum dimensions for images (width or height)
    MAX_DIMENSION = int(os.getenv("IMAGE_MAX_DIMENSION", "1920"))  # Default: 1920px

    # JPEG quality (1-100, higher = better quality but larger size)
    JPEG_QUALITY = int(os.getenv("IMAGE_JPEG_QUALITY", "85"))  # Default: 85

    # PNG compression level (0-9, higher = smaller but slower)
    PNG_COMPRESS_LEVEL = int(os.getenv("IMAGE_PNG_COMPRESS_LEVEL", "6"))  # Default: 6

    # WebP quality (1-100)
    WEBP_QUALITY = int(os.getenv("IMAGE_WEBP_QUALITY", "85"))  # Default: 85

    # Convert GIF to PNG for better compression (GIFs are often large)
    CONVERT_GIF_TO_PNG = True

    # Aggressive compression: Convert all images to WebP for best compression
    # WebP provides 25-35% better compression than JPEG/PNG and supports transparency
    CONVERT_TO_WEBP = os.getenv("IMAGE_CONVERT_TO_WEBP", "true").lower() == "true"

    # Convert images to grayscale for additional 10-30% size reduction
    # Useful when color is not important for the LLM to understand the image
    CONVERT_TO_GRAYSCALE = os.getenv("IMAGE_GRAYSCALE", "false").lower() == "true"


def compress_image_base64(
    base64_data: str,
    media_type: str,
    max_dimension: int = ImageCompressionConfig.MAX_DIMENSION,
    jpeg_quality: int = ImageCompressionConfig.JPEG_QUALITY,
    webp_quality: int = ImageCompressionConfig.WEBP_QUALITY,
    png_compress_level: int = ImageCompressionConfig.PNG_COMPRESS_LEVEL,
) -> Tuple[str, str]:
    """
    Compress a base64-encoded image.

    Args:
        base64_data: Base64-encoded image data (without data URL prefix)
        media_type: MIME type of the image (e.g., 'image/png', 'image/jpeg')
        max_dimension: Maximum width or height in pixels
        jpeg_quality: JPEG compression quality (1-100)
        webp_quality: WebP compression quality (1-100)
        png_compress_level: PNG compression level (0-9)

    Returns:
        Tuple of (compressed_base64_data, media_type)
        Media type may change if format conversion occurred (e.g., GIF -> PNG)

    Raises:
        ValueError: If the image data is invalid or cannot be processed
    """
    try:
        # Decode base64 to bytes
        image_bytes = base64.b64decode(base64_data)

        # Open image with Pillow
        image = Image.open(io.BytesIO(image_bytes))

        # Convert to grayscale if enabled (reduces size by 10-30%)
        if ImageCompressionConfig.CONVERT_TO_GRAYSCALE:
            image = image.convert("L")

        # Convert RGBA to RGB for JPEG (JPEG doesn't support transparency)
        if media_type == "image/jpeg" and image.mode in ("RGBA", "LA", "P"):
            # Create white background
            background = Image.new("RGB", image.size, (255, 255, 255))
            if image.mode == "P":
                image = image.convert("RGBA")
            background.paste(image, mask=image.split()[-1] if image.mode in ("RGBA", "LA") else None)
            image = background

        # Get original dimensions
        original_width, original_height = image.size

        # Calculate new dimensions if image is too large
        if original_width > max_dimension or original_height > max_dimension:
            # Calculate scaling factor to fit within max_dimension
            scale = min(max_dimension / original_width, max_dimension / original_height)
            new_width = int(original_width * scale)
            new_height = int(original_height * scale)

            # Resize using high-quality Lanczos resampling
            image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)

        # Determine output format and compress
        output_format = None
        output_media_type = media_type
        compress_kwargs = {}

        # Aggressive compression: Convert everything to WebP for best compression
        if ImageCompressionConfig.CONVERT_TO_WEBP:
            output_format = "WEBP"
            output_media_type = "image/webp"
            compress_kwargs = {"quality": webp_quality, "method": 6}  # method=6 for better compression

            # For images with transparency, use lossless mode to preserve quality
            if image.mode in ("RGBA", "LA", "P"):
                compress_kwargs["lossless"] = False  # Still use lossy but with alpha channel
                if image.mode == "P":
                    image = image.convert("RGBA")

        # Fallback: Preserve original format with optimization
        elif media_type == "image/jpeg" or media_type == "image/jpg":
            output_format = "JPEG"
            compress_kwargs = {"quality": jpeg_quality, "optimize": True}
        elif media_type == "image/png":
            output_format = "PNG"
            compress_kwargs = {"compress_level": png_compress_level, "optimize": True}
        elif media_type == "image/webp":
            output_format = "WEBP"
            compress_kwargs = {"quality": webp_quality, "method": 6}
        elif media_type == "image/gif":
            if ImageCompressionConfig.CONVERT_GIF_TO_PNG:
                # Convert GIF to PNG for better compression
                output_format = "PNG"
                output_media_type = "image/png"
                compress_kwargs = {"compress_level": png_compress_level, "optimize": True}
            else:
                output_format = "GIF"
                compress_kwargs = {"optimize": True}
        else:
            # Unsupported format, return original
            return base64_data, media_type

        # Save compressed image to bytes
        output_buffer = io.BytesIO()
        image.save(output_buffer, format=output_format, **compress_kwargs)
        compressed_bytes = output_buffer.getvalue()

        # Encode back to base64
        compressed_base64 = base64.b64encode(compressed_bytes).decode("utf-8")

        return compressed_base64, output_media_type

    except Exception as e:
        # If compression fails, log error and return original
        # This ensures the app doesn't break if there's an issue
        print(f"Image compression failed: {e}")
        return base64_data, media_type


def get_image_info(base64_data: str) -> dict:
    """
    Get information about a base64-encoded image.

    Args:
        base64_data: Base64-encoded image data (without data URL prefix)

    Returns:
        Dictionary with image information:
        - width: Image width in pixels
        - height: Image height in pixels
        - format: Image format (e.g., 'JPEG', 'PNG')
        - mode: Color mode (e.g., 'RGB', 'RGBA')
        - size_bytes: Size in bytes (base64 decoded)
        - size_kb: Size in kilobytes

    Raises:
        ValueError: If the image data is invalid
    """
    try:
        image_bytes = base64.b64decode(base64_data)
        image = Image.open(io.BytesIO(image_bytes))

        return {
            "width": image.width,
            "height": image.height,
            "format": image.format,
            "mode": image.mode,
            "size_bytes": len(image_bytes),
            "size_kb": round(len(image_bytes) / 1024, 2),
        }
    except Exception as e:
        raise ValueError(f"Invalid image data: {e}")
