import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import * as gameService from "../services/gameService";
import { useAuth } from "./AuthContext";
import type { World } from "./GameContext";

// =============================================================================
// CONTEXT
// =============================================================================

interface WorldsContextValue {
  worlds: World[];
  worldsLoading: boolean;
  refreshWorlds: () => Promise<void>;
  addWorld: (world: World) => void;
  removeWorld: (worldId: number) => void;
}

const WorldsContext = createContext<WorldsContextValue | null>(null);

// =============================================================================
// PROVIDER
// =============================================================================

interface WorldsProviderProps {
  children: ReactNode;
}

export function WorldsProvider({ children }: WorldsProviderProps) {
  const [worlds, setWorlds] = useState<World[]>([]);
  const [worldsLoading, setWorldsLoading] = useState(true);
  const { apiKey } = useAuth();

  const refreshWorlds = useCallback(async () => {
    setWorldsLoading(true);
    try {
      const worldList = await gameService.listWorlds();
      setWorlds(worldList);
    } finally {
      setWorldsLoading(false);
    }
  }, []);

  // Load worlds when apiKey becomes available
  useEffect(() => {
    if (!apiKey) {
      setWorldsLoading(false);
      return;
    }
    refreshWorlds();
  }, [apiKey, refreshWorlds]);

  const addWorld = useCallback((world: World) => {
    setWorlds((prev) => [world, ...prev]);
  }, []);

  const removeWorld = useCallback((worldId: number) => {
    setWorlds((prev) => prev.filter((w) => w.id !== worldId));
  }, []);

  const value: WorldsContextValue = {
    worlds,
    worldsLoading,
    refreshWorlds,
    addWorld,
    removeWorld,
  };

  return (
    <WorldsContext.Provider value={value}>{children}</WorldsContext.Provider>
  );
}

// =============================================================================
// HOOK
// =============================================================================

export function useWorlds(): WorldsContextValue {
  const context = useContext(WorldsContext);
  if (!context) {
    throw new Error("useWorlds must be used within a WorldsProvider");
  }
  return context;
}
