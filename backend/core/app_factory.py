"""
Application factory for creating FastAPI app instances.

This module provides functions for creating and configuring the FastAPI application
with all necessary middleware, routers, and dependencies.
"""

import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi_mcp import FastApiMCP
from infrastructure.database.connection import get_db, init_db
from infrastructure.database.write_queue import start_writer, stop_writer
from infrastructure.scheduler import BackgroundScheduler
from orchestration import ChatOrchestrator
from sdk import AgentManager
from services import AgentFactory

from core import get_logger, get_settings

logger = get_logger("AppFactory")


def create_app() -> FastAPI:
    """
    Create and configure the FastAPI application.

    Returns:
        Configured FastAPI application instance
    """
    from infrastructure.auth import AuthMiddleware
    from fastapi.middleware.cors import CORSMiddleware
    from routers import agent_management, agents, auth, debug, game, mcp_tools, messages, readme, room_agents, rooms
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
    app.include_router(readme.router, tags=["Documentation"])  # Readme/help content
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

    # Serve static frontend files when running as PyInstaller bundle
    if getattr(sys, "frozen", False):
        from fastapi.responses import FileResponse
        from fastapi.staticfiles import StaticFiles
        from starlette.exceptions import HTTPException as StarletteHTTPException

        # Get the bundled static directory path
        base_path = Path(sys._MEIPASS)
        static_dir = base_path / "static"

        if static_dir.exists():
            # Mount static assets (js, css, etc.)
            app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")

            # API prefixes that should NOT be handled by SPA
            API_PREFIXES = (
                "/auth",
                "/rooms",
                "/agents",
                "/worlds",
                "/debug",
                "/readme",
                "/mcp",
                "/docs",
                "/openapi.json",
                "/redoc",
            )

            # Serve root index.html
            @app.get("/")
            async def serve_index():
                """Serve the SPA index.html for root path."""
                return FileResponse(static_dir / "index.html")

            # Custom 404 handler to serve SPA for frontend routes
            @app.exception_handler(StarletteHTTPException)
            async def spa_exception_handler(request, exc):
                """Serve index.html for 404s on non-API routes (SPA routing)."""
                if exc.status_code == 404:
                    path = request.url.path
                    # Don't serve SPA for API routes - return the actual 404
                    if path.startswith(API_PREFIXES):
                        from fastapi.responses import JSONResponse

                        return JSONResponse(
                            status_code=404,
                            content={"detail": "Not Found"},
                        )
                    # Check if it's a static file that exists
                    file_path = static_dir / path.lstrip("/")
                    if file_path.exists() and file_path.is_file():
                        return FileResponse(file_path)
                    # Serve index.html for SPA routing
                    return FileResponse(static_dir / "index.html")
                # Re-raise other HTTP exceptions
                from fastapi.responses import JSONResponse

                return JSONResponse(
                    status_code=exc.status_code,
                    content={"detail": exc.detail},
                )

            logger.info(f"📦 Serving frontend from bundled static files: {static_dir}")

    return app
