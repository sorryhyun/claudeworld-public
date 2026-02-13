import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import * as gameService from "../services/gameService";
import { WorldsProvider, useWorlds } from "./WorldsContext";
import { SessionProvider, useSession } from "./SessionContext";
import { changeLanguage as i18nChangeLanguage } from "../i18n";

// =============================================================================
// TYPES (Re-exported for backward compatibility)
// =============================================================================

export interface StatDefinition {
  name: string;
  display: string;
  min: number;
  max: number | null;
  default: number;
}

export interface World {
  id: number;
  name: string;
  owner_id: string | null;
  user_name: string | null;
  language: "en" | "ko" | "jp";
  genre: string | null;
  theme: string | null;
  lore: string | null;
  stat_definitions: { stats: StatDefinition[] } | null;
  phase: "onboarding" | "active" | "ended";
  pending_phase: "active" | null; // Set by complete tool, triggers "Enter World" button
  onboarding_room_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Location {
  id: number;
  world_id: number;
  name: string;
  label: string | null;
  description: string | null;
  room_id: number | null;
  position_x: number;
  position_y: number;
  is_current: boolean;
  is_discovered: boolean;
  adjacent_locations: number[] | null;
  created_at: string;
}

export interface NPC {
  id: number;
  name: string;
  role: string | null;
  description: string | null;
}

export interface GameTime {
  hour: number;
  minute: number;
  day: number;
}

export interface PropertyValue {
  value: unknown;
  higher_is_better: boolean;
}

export interface InventoryItem {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  properties: Record<string, unknown | PropertyValue> | null;
}

export interface PlayerState {
  id: number;
  world_id: number;
  stats: Record<string, number> | null;
  inventory: InventoryItem[] | null;
  current_location_id: number | null;
  turn_count: number;
  game_time: GameTime | null;
  equipment: Record<string, string | null> | null; // slot_name -> item_id
}

// World-level item template (from items/ directory)
export interface WorldItem {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  rarity?: string;
  icon?: string;
  default_properties?: Record<string, unknown>;
  equippable?: {
    slot: string;
    passive_effects?: Record<string, number>;
  };
  usable?: Record<string, unknown>;
}

export interface GameMessage {
  id: number;
  content: string;
  role: "user" | "assistant";
  agent_id: number | null;
  agent_name: string | null;
  thinking: string | null;
  timestamp: string | null;
  is_chatting?: boolean;
  has_narrated?: boolean; // For Action_Manager: true when narration tool has been called
  image_data?: string | null; // Base64-encoded image data
  image_media_type?: string | null; // MIME type (e.g., 'image/png', 'image/jpeg')
  game_time_snapshot?: { hour: number; minute: number; day: number } | null; // In-game time for display
}

export type GamePhase = "loading" | "no_world" | "onboarding" | "active";
export type GameLanguage = "en" | "ko" | "jp";
export type AppMode = "chat" | "onboarding" | "game";

export const DEFAULT_USER_NAMES: Record<GameLanguage, string> = {
  en: "newcomer",
  ko: "손님",
  jp: "訪問者",
};

// =============================================================================
// APP CONTEXT (Lean coordinator for mode and language)
// =============================================================================

interface AppContextValue {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  language: GameLanguage;
  setLanguage: (lang: GameLanguage) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function AppProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AppMode>("chat");

  const [language, setLanguageState] = useState<GameLanguage>(() => {
    const saved = localStorage.getItem("gameLanguage");
    if (saved === "en" || saved === "ko" || saved === "jp") return saved;
    return "ko";
  });

  // Sync i18n when language changes (including initial mount)
  useEffect(() => {
    i18nChangeLanguage(language);
  }, [language]);

  const setLanguage = useCallback((lang: GameLanguage) => {
    setLanguageState(lang);
    localStorage.setItem("gameLanguage", lang);
    i18nChangeLanguage(lang); // Sync i18n language immediately
  }, []);

  return (
    <AppContext.Provider value={{ mode, setMode, language, setLanguage }}>
      {children}
    </AppContext.Provider>
  );
}

// =============================================================================
// GAME CONTEXT (Composed interface for backward compatibility)
// =============================================================================

interface GameContextValue {
  // State (from SessionContext)
  worlds: World[];
  world: World | null;
  playerState: PlayerState | null;
  currentLocation: Location | null;
  locations: Location[];
  messages: GameMessage[];
  suggestions: string[];
  phase: GamePhase;
  loading: boolean;
  worldsLoading: boolean;
  actionInProgress: boolean;
  isClauding: boolean; // True when agents are actively processing
  isChatMode: boolean;
  worldItems: WorldItem[]; // All items defined in the world

  // App Mode (from AppContext)
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  enterOnboarding: (worldId: number) => Promise<void>;
  enterGame: (worldId: number) => Promise<void>;
  exitToChat: () => void;

  // Language (from AppContext)
  language: GameLanguage;
  setLanguage: (lang: GameLanguage) => void;

  // World Management (coordinated)
  createWorld: (
    name: string,
    userName?: string,
    language?: "en" | "ko" | "jp",
  ) => Promise<World>;
  loadWorld: (worldId: number) => Promise<void>;
  deleteWorld: (worldId: number) => Promise<void>;
  resetWorld: (worldId: number) => Promise<void>;
  refreshWorlds: () => Promise<void>;
  clearWorld: () => void;

  // Player Actions (from SessionContext)
  submitAction: (
    actionText: string,
    imageData?: string,
    imageMediaType?: string,
  ) => Promise<void>;
  sendOnboardingMessage: (message: string) => Promise<void>;
  selectSuggestion: (index: number) => Promise<void>;

  // Location Management (from SessionContext)
  travelTo: (locationId: number) => Promise<void>;
  updateLocationLabel: (locationId: number, label: string) => Promise<void>;
  viewLocationHistory: (locationId: number) => Promise<GameMessage[]>;

  // Polling (from SessionContext)
  startPolling: () => void;
  stopPolling: () => void;

  // World Items
  refreshWorldItems: () => Promise<void>;
}

const GameContext = createContext<GameContextValue | null>(null);

// =============================================================================
// INNER PROVIDER (Composes all contexts)
// =============================================================================

function GameInnerProvider({ children }: { children: ReactNode }) {
  const appContext = useContext(AppContext);
  const worldsContext = useWorlds();
  const sessionContext = useSession();

  // World items state (items defined in the world's items/ directory)
  const [worldItems, setWorldItems] = useState<WorldItem[]>([]);

  if (!appContext) {
    throw new Error("GameInnerProvider must be used within AppProvider");
  }

  const { mode, setMode, language, setLanguage } = appContext;
  const { worlds, worldsLoading, refreshWorlds, addWorld, removeWorld } =
    worldsContext;
  const {
    world,
    playerState,
    currentLocation,
    locations,
    messages,
    suggestions,
    phase,
    loading,
    actionInProgress,
    isClauding,
    isChatMode,
    loadWorld: sessionLoadWorld,
    clearWorld: sessionClearWorld,
    submitAction,
    sendOnboardingMessage,
    selectSuggestion,
    travelTo,
    updateLocationLabel,
    viewLocationHistory,
    startPolling,
    stopPolling,
  } = sessionContext;

  // ==========================================================================
  // COORDINATED ACTIONS
  // ==========================================================================

  const createWorld = useCallback(
    async (
      name: string,
      userName?: string,
      lang: "en" | "ko" | "jp" = "ko",
    ): Promise<World> => {
      const newWorld = await gameService.createWorld(name, userName, lang);
      addWorld(newWorld);
      await sessionLoadWorld(newWorld.id);
      setMode("onboarding");
      return newWorld;
    },
    [addWorld, sessionLoadWorld, setMode],
  );

  const loadWorld = useCallback(
    async (worldId: number): Promise<void> => {
      const worldData = await sessionLoadWorld(worldId);
      // Sync language to world's language
      if (worldData.language) {
        setLanguage(worldData.language);
      }
      setMode(worldData.phase === "onboarding" ? "onboarding" : "game");
    },
    [sessionLoadWorld, setMode, setLanguage],
  );

  const clearWorld = useCallback(() => {
    sessionClearWorld();
    setWorldItems([]);
  }, [sessionClearWorld]);

  const deleteWorld = useCallback(
    async (worldId: number): Promise<void> => {
      await gameService.deleteWorld(worldId);
      removeWorld(worldId);
      if (world?.id === worldId) {
        clearWorld();
      }
    },
    [world, removeWorld, clearWorld],
  );

  const resetWorld = useCallback(
    async (worldId: number): Promise<void> => {
      await gameService.resetWorld(worldId);
      // Reload the world to get fresh state after reset
      if (world?.id === worldId) {
        await sessionLoadWorld(worldId);
        setMode("game");
      }
    },
    [world, sessionLoadWorld, setMode],
  );

  const enterOnboarding = useCallback(
    async (worldId: number): Promise<void> => {
      await sessionLoadWorld(worldId);
      setMode("onboarding");
    },
    [sessionLoadWorld, setMode],
  );

  const enterGame = useCallback(
    async (worldId: number): Promise<void> => {
      // Call the enter endpoint which syncs phase and sends arrival message
      await gameService.enterWorld(worldId);
      // Then load the full world data with the updated world
      await sessionLoadWorld(worldId);
      setMode("game");
    },
    [sessionLoadWorld, setMode],
  );

  const exitToChat = useCallback(() => {
    clearWorld();
    setMode("chat");
  }, [clearWorld, setMode]);

  // Fetch world items from the world's items/ directory
  const refreshWorldItems = useCallback(async () => {
    if (!world) {
      setWorldItems([]);
      return;
    }
    try {
      const result = await gameService.getWorldItems(world.id);
      setWorldItems(result.items || []);
    } catch (error) {
      console.error("Failed to load world items:", error);
      setWorldItems([]);
    }
  }, [world]);

  // Load world items when world changes
  useEffect(() => {
    if (world && world.phase === "active") {
      refreshWorldItems();
    } else {
      setWorldItems([]);
    }
  }, [world?.id, world?.phase, refreshWorldItems]);

  // ==========================================================================
  // CONTEXT VALUE
  // ==========================================================================

  const value: GameContextValue = {
    // State
    worlds,
    world,
    playerState,
    currentLocation,
    locations,
    messages,
    suggestions,
    phase,
    loading,
    worldsLoading,
    actionInProgress,
    isClauding,
    isChatMode,
    worldItems,

    // App Mode
    mode,
    setMode,
    enterOnboarding,
    enterGame,
    exitToChat,

    // Language
    language,
    setLanguage,

    // World Management
    createWorld,
    loadWorld,
    deleteWorld,
    resetWorld,
    refreshWorlds,
    clearWorld,

    // Player Actions
    submitAction,
    sendOnboardingMessage,
    selectSuggestion,

    // Location Management
    travelTo,
    updateLocationLabel,
    viewLocationHistory,

    // Polling
    startPolling,
    stopPolling,

    // World Items
    refreshWorldItems,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

// =============================================================================
// PUBLIC PROVIDER (Wraps all context layers)
// =============================================================================

interface GameProviderProps {
  children: ReactNode;
}

export function GameProvider({ children }: GameProviderProps) {
  return (
    <AppProvider>
      <WorldsProvider>
        <GameProviderInner>{children}</GameProviderInner>
      </WorldsProvider>
    </AppProvider>
  );
}

// SessionProvider needs mode from AppContext, so we need an intermediate component
function GameProviderInner({ children }: { children: ReactNode }) {
  const appContext = useContext(AppContext);
  if (!appContext) {
    throw new Error("GameProviderInner must be used within AppProvider");
  }

  return (
    <SessionProvider mode={appContext.mode}>
      <GameInnerProvider>{children}</GameInnerProvider>
    </SessionProvider>
  );
}

// =============================================================================
// HOOKS
// =============================================================================

export function useGame(): GameContextValue {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error("useGame must be used within a GameProvider");
  }
  return context;
}

// Export individual hooks for granular access
export { useWorlds } from "./WorldsContext";
export { useSession } from "./SessionContext";
