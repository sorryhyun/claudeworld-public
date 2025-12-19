# ClaudeWorld Frontend

React + TypeScript frontend for the ClaudeWorld TRPG application.

## Tech Stack

- **React 19.1.1** - UI library
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Tailwind CSS 4.1** - Styling framework
- **shadcn/ui** - Component library built on Radix UI primitives
- **Lucide React** - Icon library
- **React Markdown** - Markdown rendering with GitHub flavored markdown support

## Project Structure

```
frontend/
├── src/
│   ├── components/
│   │   ├── game/                 # TRPG game components
│   │   │   ├── GameApp.tsx       # TRPG mode entry point
│   │   │   ├── WorldSelector.tsx # World creation/selection
│   │   │   ├── GameRoom.tsx      # Main game interface
│   │   │   ├── GameSidebar.tsx   # Left sidebar (locations)
│   │   │   ├── GameStatePanel.tsx # Right sidebar (stats, inventory, map)
│   │   │   ├── ActionInput.tsx   # Player action input
│   │   │   ├── SuggestedActions.tsx # Action Manager suggestions
│   │   │   ├── StatsDisplay.tsx  # Dynamic stats rendering
│   │   │   ├── InventoryList.tsx # Inventory display
│   │   │   ├── Minimap.tsx       # Location visualization
│   │   │   ├── LocationListPanel.tsx # Location navigation
│   │   │   └── TurnIndicator.tsx # Processing indicator
│   │   ├── chat-room/            # Shared chat components
│   │   │   ├── message-list/     # Message display
│   │   │   └── MessageInput.tsx  # Message input
│   │   ├── ui/                   # shadcn/ui components
│   │   └── Login.tsx             # Authentication
│   ├── contexts/
│   │   ├── AuthContext.tsx       # JWT authentication
│   │   └── GameContext.tsx       # TRPG game state management
│   ├── services/
│   │   ├── api.ts               # Base API client
│   │   └── gameService.ts       # Game API calls
│   ├── hooks/
│   │   ├── usePolling.ts        # Message polling
│   │   └── useAgents.ts         # Agent operations
│   ├── App.tsx                   # Root component
│   └── main.tsx                  # Entry point
├── public/                        # Static assets
└── package.json
```

## Key Components

### Game Context (`contexts/GameContext.tsx`)

Central state management for TRPG gameplay:

**State:**
- `world` - Current game world
- `playerState` - Stats, inventory, turn count
- `currentLocation` - Player's current location
- `locations` - Discovered locations
- `messages` - Chat history for current location
- `suggestions` - Action Manager's suggested actions
- `phase` - loading | no_world | onboarding | active

**Actions:**
- `createWorld(name)` - Create new world
- `loadWorld(worldId)` - Load existing world
- `submitAction(text)` - Submit player action
- `travelTo(locationId)` - Travel to location
- `useSuggestion(index)` - Use suggested action

**Polling:**
- Automatic 2-second polling for new messages and state updates
- Phase transition detection (onboarding → active)

### World Selector (`components/game/WorldSelector.tsx`)

Initial screen for world management:
- Create new worlds with custom names
- List and select existing worlds
- Delete worlds

### Game Room (`components/game/GameRoom.tsx`)

Main game interface:
- Message display with thinking text
- Action input for player commands
- Suggested actions from Action Manager
- Turn processing indicator
- Location header with world name

### Game State Panel (`components/game/GameStatePanel.tsx`)

Right sidebar with tabbed interface:
- **Stats Tab**: Dynamic stat bars with color coding
- **Inventory Tab**: Item list with quantities
- **Map Tab**: Minimap with location navigation

### Game Sidebar (`components/game/GameSidebar.tsx`)

Left sidebar with:
- Location list (discovered locations only)
- Travel functionality (click to travel)
- Current location indicator
- Label editing for locations

## Development

### Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

### Environment Variables

Create `frontend/.env`:

```bash
# Backend API URL
VITE_API_BASE_URL=http://localhost:8000
```

### Run Development Server

```bash
npm run dev
# Opens on http://localhost:5173
```

### Build for Production

```bash
npm run build
# Output in dist/

# Preview production build
npm run preview
```

## API Integration

Game API calls via `services/gameService.ts`:

```typescript
import * as gameService from './services/gameService';

// World management
await gameService.createWorld('My Adventure');
await gameService.listWorlds();
await gameService.getWorld(worldId);
await gameService.deleteWorld(worldId);

// Player actions
await gameService.submitAction(worldId, 'I search the room');
await gameService.getActionSuggestions(worldId);

// Locations
await gameService.getLocations(worldId);
await gameService.travelToLocation(worldId, locationId);

// State
await gameService.getPlayerState(worldId);
await gameService.getStats(worldId);
await gameService.getInventory(worldId);

// Polling
await gameService.pollUpdates(worldId, sinceMessageId);
```

## Styling & Components

**Tailwind CSS 4.1** with:
- Typography Plugin for markdown styling
- Animation Plugin for smooth transitions
- Custom theme in `tailwind.config.js`

**shadcn/ui Components:**
- Built on Radix UI primitives for accessibility
- Icons from Lucide React

**Adding components:**
```bash
npx shadcn@latest add [component-name]
```

## Deployment

### Vercel (Recommended)

1. Set environment variable:
   ```
   VITE_API_BASE_URL=https://your-backend.ngrok-free.app
   ```

2. Deploy:
   ```bash
   vercel
   ```

3. Configure backend CORS:
   ```bash
   # In backend/.env
   FRONTEND_URL=https://your-app.vercel.app
   ```

## Troubleshooting

**"Invalid or missing API key" error:**
- Check that you're logged in
- Verify backend is running
- Try logging out and back in

**Messages not updating:**
- Verify backend polling endpoint is accessible
- Check browser console for errors

**World not loading:**
- Check that world exists in database
- Verify user owns the world

**Stats/inventory not showing:**
- Ensure world is in "active" phase
- Check that stat definitions exist in world

## Scripts

```bash
npm run dev       # Start development server
npm run build     # Build for production
npm run preview   # Preview production build
npm run lint      # Run ESLint
```

## Dependencies

**Core:**
- `react` ^19.1.1
- `react-dom` ^19.1.1
- `typescript` ^5.9.3

**UI Components:**
- `@radix-ui/react-*` - Accessible component primitives
- `lucide-react` - Icon library
- `class-variance-authority` - CSS variant utilities
- `tailwind-merge` - Tailwind class merging

**Markdown:**
- `react-markdown`
- `react-syntax-highlighter`
- `remark-gfm`

**Styling:**
- `tailwindcss` ^4.1.16
- `@tailwindcss/typography`

**Build Tools:**
- `vite` ^7.1.7
- `@vitejs/plugin-react`

## Related Documentation

- [Main README](../README.md) - Project overview
- [SETUP.md](../SETUP.md) - Setup and authentication
- [Backend README](../backend/README.md) - Backend API documentation
- [how_it_works.md](../how_it_works.md) - TRPG system architecture
