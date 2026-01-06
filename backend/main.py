"""
claudeworld API - Multi-Claude chat room application.

This is the main entry point for the FastAPI application.
All application configuration and setup is handled by the app factory.
"""

from core import get_settings, setup_logging
from core.app_factory import create_app

settings = get_settings()
setup_logging(debug_mode=settings.debug_agents)

app = create_app()
