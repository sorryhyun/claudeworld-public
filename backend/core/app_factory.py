"""
Application factory for creating FastAPI app instances.

This module provides functions for creating and configuring the FastAPI application
with all necessary middleware, routers, and dependencies.
"""

import sys
from contextlib import asynccontextmanager
from pathlib import Path

from background_scheduler import BackgroundScheduler
from database import get_db, init_db
from fastapi import FastAPI
from fastapi_mcp import FastApiMCP
from infrastructure.database.write_queue import start_writer, stop_writer
from orchestration import ChatOrchestrator
from sdk import AgentManager
from services import AgentFactory

from core import get_logger, get_settings

logger = get_logger("AppFactory")


def is_frozen() -> bool:
    """Check if running as PyInstaller bundle."""
    return getattr(sys, "frozen", False)


def get_static_path() -> Path | None:
    """Get path to static files if running as bundled executable."""
    if not is_frozen():
        return None
    # PyInstaller extracts to sys._MEIPASS
    base_path = Path(sys._MEIPASS)
    static_path = base_path / "static"
    if static_path.exists():
        return static_path
    return None


def create_app() -> FastAPI:
    """
    Create and configure the FastAPI application.

    Returns:
        Configured FastAPI application instance
    """
    from auth import AuthMiddleware
    from fastapi.middleware.cors import CORSMiddleware
    from routers import agent_management, agents, auth, debug, game, mcp_tools, messages, room_agents, rooms
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.errors import RateLimitExceeded
    from slowapi.util import get_remote_address

    settings = get_settings()

    # Create lifespan context manager
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """Lifespan context manager for application startup and shutdown."""
        # Startup
        logger.info("🚀 Application startup...")

        # Start write queue for SQLite (serializes writes to prevent lock contention)
        await start_writer()

        # Validate configuration files
        from sdk.loaders import log_config_validation

        log_config_validation()

        # Initialize database
        await init_db()

        # Create singleton instances
        agent_manager = AgentManager()
        priority_agent_names = settings.get_priority_agent_names()
        chat_orchestrator = ChatOrchestrator(priority_agent_names=priority_agent_names)
        background_scheduler = BackgroundScheduler(
            chat_orchestrator=chat_orchestrator,
            agent_manager=agent_manager,
            get_db_session=get_db,
            max_concurrent_rooms=settings.max_concurrent_rooms,
        )

        # Log priority agent configuration
        if priority_agent_names:
            logger.info(f"🎯 Priority agents enabled: {priority_agent_names}")
            logger.info("   💡 Priority agents will respond first in both initial and follow-up rounds")
        else:
            logger.info("👥 All agents have equal priority (PRIORITY_AGENTS not set)")

        # Store in app state for dependency injection
        app.state.agent_manager = agent_manager
        app.state.chat_orchestrator = chat_orchestrator
        app.state.background_scheduler = background_scheduler

        # Seed agents from config files
        async for db in get_db():
            await AgentFactory.seed_from_configs(db)
            break

        # Start background scheduler
        background_scheduler.start()

        logger.info("✅ Application startup complete")

        yield

        # Shutdown
        logger.info("🛑 Application shutdown...")
        background_scheduler.stop()
        await agent_manager.shutdown()

        await stop_writer()
        logger.info("✅ Application shutdown complete")

    # Initialize rate limiter
    limiter = Limiter(key_func=get_remote_address)

    # Create app with lifespan
    app = FastAPI(title="ClaudeWorld API", lifespan=lifespan)
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    # CORS middleware
    allowed_origins = settings.get_cors_origins()
    logger.info("🔒 CORS Configuration:")
    logger.info(f"   Allowed origins: {allowed_origins}")
    logger.info("   💡 To add more origins, set FRONTEND_URL or VERCEL_URL in .env")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Add authentication middleware
    app.add_middleware(AuthMiddleware)

    # Register routers
    # IMPORTANT: agent_management must come before agents to ensure /agents/configs
    # matches before /agents/{agent_id} (more specific routes before generic ones)
    app.include_router(auth.router, prefix="/auth", tags=["Authentication"])
    app.include_router(rooms.router, prefix="/rooms", tags=["Rooms"])
    app.include_router(agent_management.router, prefix="/agents", tags=["Agent Management"])
    app.include_router(agents.router, prefix="/agents", tags=["Agents"])
    app.include_router(room_agents.router, prefix="/rooms", tags=["Room-Agents"])
    app.include_router(messages.router, prefix="/rooms", tags=["Messages"])
    app.include_router(game.router, tags=["Game"])  # TRPG game routes
    app.include_router(debug.router, prefix="/debug", tags=["Debug"])
    app.include_router(mcp_tools.router, tags=["MCP Tools"])

    # Mount MCP server - exposes simplified tools for easy LLM integration
    # Only expose "MCP Tools" tag with clean, semantic tool names
    mcp = FastApiMCP(
        app,
        name="ClaudeWorld",
        description="Chat with AI agents. Use 'list_agents' to see available agents, then 'chat' to talk with them.",
        include_tags=["MCP Tools"],  # Only expose simplified MCP tools
        headers=["authorization", "x-api-key"],  # Forward auth headers to API calls
    )
    mcp.mount()
    logger.info("🔌 MCP server mounted at /mcp (5 simplified tools)")

    # Serve static files for bundled executable (EXE mode)
    static_path = get_static_path()
    if static_path:
        from fastapi import Request
        from fastapi.responses import FileResponse, HTMLResponse
        from starlette.staticfiles import StaticFiles

        logger.info(f"📁 Serving static files from: {static_path}")

        # Mount assets directory for JS/CSS/images
        assets_path = static_path / "assets"
        if assets_path.exists():
            app.mount("/assets", StaticFiles(directory=str(assets_path)), name="assets")
            logger.info("   📦 Assets mounted at /assets")

        # Serve index.html for SPA routing (catch-all for frontend routes)
        index_html = static_path / "index.html"

        @app.get("/", include_in_schema=False)
        async def serve_root():
            """Serve index.html for root path."""
            if index_html.exists():
                return FileResponse(index_html)
            return HTMLResponse("<h1>Frontend not found</h1>", status_code=404)

        @app.get("/{full_path:path}", include_in_schema=False)
        async def serve_spa(request: Request, full_path: str):
            """Serve frontend SPA - returns index.html for all non-API routes."""
            # Check if it's a static file request
            file_path = static_path / full_path
            if file_path.is_file() and full_path:
                return FileResponse(file_path)
            # For all other routes, serve index.html (SPA routing)
            if index_html.exists():
                return FileResponse(index_html)
            return HTMLResponse("<h1>Frontend not found</h1>", status_code=404)

        logger.info("   🌐 SPA fallback route configured")

    return app
