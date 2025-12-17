# ClaudeWorld

*251207: Update will be delayed until claude agent sdk fixes bug where tool calling for background agents be broken*

A turn-based text adventure (TRPG) powered by Claude AI agents that collaborate to create and run interactive worlds.

## Features

- **Dynamic World Creation** - AI agents interview you and generate unique worlds based on your preferences
- **Turn-Based Gameplay** - Sequential agent processing: interpret action → create NPCs → update stats → narrate
- **Persistent Game State** - Stats, inventory, locations, and NPCs tracked across sessions
- **Location-Based Exploration** - Travel between discovered locations with unique chat histories
- **Intelligent Narration** - The Narrator describes outcomes and suggests actions
- **HTTP Polling** - Real-time updates via polling (2-second intervals)
- **JWT Authentication** - Secure password-based authentication

## Tech Stack

**Backend:** FastAPI, SQLAlchemy (async), SQLite/PostgreSQL, Anthropic Claude Agent SDK
**Frontend:** React, TypeScript, Vite, Tailwind CSS

## Quick Start

### 1. Install Dependencies

```bash
make install
```

### 2. Configure Authentication

```bash
make generate-hash  # Generate password hash
python -c "import secrets; print(secrets.token_hex(32))"  # Generate JWT secret
cp .env.example .env  # Add API_KEY_HASH and JWT_SECRET to .env
```

See [SETUP.md](SETUP.md) for details.

### 3. Run & Access

```bash
make dev
```

Open http://localhost:5173 and login with your password.

## How It Works

### Onboarding Phase

1. Create a new world
2. The **Onboarding Manager** interviews you about your ideal world
3. The **World Seed Generator** creates lore, stat system, and starting location
4. The **Narrator** describes your starting scene

### Active Gameplay

```
Your Action → Action_Manager → Character_Designer → Stat_Calculator → Narrator
                (interpret)      (create NPCs)       (update stats)    (narrate)
                                    [skip?]            [skip?]          [always]
```

Each turn:
1. Submit an action (e.g., "I search the room carefully")
2. **Action Manager** interprets your intent
3. **Character Designer** creates NPCs if needed (or skips)
4. **Stat Calculator** applies mechanical effects (or skips)
5. **Narrator** describes the outcome and suggests next actions

## System Agents

Eight specialized agents in `agents/group_onboarding/` and `agents/group_gameplay/`:

| Agent | Role |
|-------|------|
| **Onboarding_Manager** | Interviews player about world preferences |
| **World_Seed_Generator** | Creates world lore, stat system, locations |
| **Action_Manager** | Interprets player actions and outcomes |
| **Character_Designer** | Creates NPCs when interactions require them |
| **Location_Designer** | Creates new locations during exploration |
| **Stat_Calculator** | Processes mechanical game effects |
| **Narrator** | Describes results, suggests next actions |
| **Summarizer** | Generates conversation summaries |

## API

### Game Endpoints

```
POST   /api/worlds                    # Create new world
GET    /api/worlds                    # List your worlds
GET    /api/worlds/{id}               # Get world details
POST   /api/worlds/{id}/action        # Submit player action
GET    /api/worlds/{id}/poll          # Poll for updates
GET    /api/worlds/{id}/state         # Get player state
GET    /api/worlds/{id}/locations     # List discovered locations
POST   /api/worlds/{id}/locations/{loc}/travel  # Travel to location
```

### Authentication

```
POST   /auth/login    # Login with password
GET    /auth/verify   # Verify JWT token
```

See [backend/README.md](backend/README.md) for full API reference.

## Agent Configuration

System agents use a folder-based structure:

```
agents/
  group_onboarding/
    ├── group_config.yaml        # Group behavior settings
    ├── Onboarding_Manager/
    │   ├── in_a_nutshell.md     # Brief identity (third-person)
    │   └── characteristics.md    # Personality traits (third-person)
    └── World_Seed_Generator/
  group_gameplay/
    ├── group_config.yaml
    ├── Action_Manager/
    ├── Character_Designer/
    ├── Location_Designer/
    ├── Stat_Calculator/
    ├── Narrator/
    └── Summarizer/
```

All agents use **third-person perspective** (e.g., "The Narrator is..." not "You are...").

See [how_it_works.md](how_it_works.md) for details.

## Commands

```bash
make dev           # Run full stack
make install       # Install dependencies
make stop          # Stop servers
make clean         # Clean build artifacts
```

## Deployment

### Windows Executable

Build a standalone `.exe` for easy distribution:
```bash
make build-exe
```

Creates `dist/ClaudeWorld.exe` with bundled frontend, backend, and first-time setup wizard.

**Automated builds:** GitHub Actions automatically builds and attaches executables when you create a release. See [DEPLOYMENT.md](DEPLOYMENT.md) for details.

### Web Deployment

**Backend:** Local machine with ngrok tunnel (or cloud hosting)
**Frontend:** Vercel (or other static hosting)
**CORS:** Configure via `FRONTEND_URL` in backend `.env`

See [SETUP.md](SETUP.md) for deployment details.

## Configuration

**Backend `.env`:**
- `API_KEY_HASH` (required) - Bcrypt hash of admin password
- `JWT_SECRET` (required) - Secret for JWT signing
- `CLAUDE_API_KEY` - Direct API key for production (optional, uses Claude Code auth if not set)
- `USER_NAME` - Display name for user messages
- `DEBUG_AGENTS` - "true" for verbose logging
- `USE_HAIKU` - "true" to use Haiku model instead of Opus
- `ENABLE_GUEST_LOGIN` - "true"/"false" to enable guest access (default: true)
- `FRONTEND_URL` - CORS origin for production deployments

**Frontend `.env`:**
- `VITE_API_BASE_URL` - Backend URL (default: http://localhost:8000)

## Documentation

- [SETUP.md](SETUP.md) - Setup, authentication, deployment
- [how_it_works.md](how_it_works.md) - System architecture
- [backend/README.md](backend/README.md) - Backend API documentation
- [frontend/README.md](frontend/README.md) - Frontend documentation

## History

ClaudeWorld evolved from ChitChats, a multi-agent chat room application.
