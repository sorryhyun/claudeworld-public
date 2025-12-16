import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from 'react';
import * as gameService from '../services/gameService';
import { api } from '../services';
import type {
  World,
  Location,
  PlayerState,
  GameMessage,
  GamePhase,
} from './GameContext';

// =============================================================================
// CONTEXT
// =============================================================================

interface SessionContextValue {
  // Current session state
  world: World | null;
  playerState: PlayerState | null;
  currentLocation: Location | null;
  locations: Location[];
  messages: GameMessage[];
  suggestions: string[];
  phase: GamePhase;
  loading: boolean;
  actionInProgress: boolean;
  isChatMode: boolean;

  // Session management
  loadWorld: (worldId: number) => Promise<World>;
  clearWorld: () => void;

  // Player actions
  submitAction: (actionText: string) => Promise<void>;
  sendOnboardingMessage: (message: string) => Promise<void>;
  useSuggestion: (index: number) => Promise<void>;

  // Location management
  travelTo: (locationId: number) => Promise<void>;
  updateLocationLabel: (locationId: number, label: string) => Promise<void>;
  viewLocationHistory: (locationId: number) => Promise<GameMessage[]>;

  // Polling
  startPolling: () => void;
  stopPolling: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

// =============================================================================
// PROVIDER
// =============================================================================

interface SessionProviderProps {
  children: ReactNode;
  mode: 'chat' | 'onboarding' | 'game';
}

export function SessionProvider({ children, mode }: SessionProviderProps) {
  // Session state
  const [world, setWorld] = useState<World | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState | null>(null);
  const [currentLocation, setCurrentLocation] = useState<Location | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [messages, setMessages] = useState<GameMessage[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  // UI state
  const [loading, setLoading] = useState(false);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [pollingInterval, setPollingInterval] = useState<number | null>(null);
  const [chattingPollInterval, setChattingPollInterval] = useState<number | null>(null);
  const [lastMessageId, setLastMessageId] = useState<number | null>(null);
  const [isChatMode, setIsChatMode] = useState(false);

  // Ref to suppress suggestions during action (avoids stale closure in setInterval)
  // Stores the suggestions that were visible when action was submitted
  // Polling will only update suggestions if they're different from these
  const suppressedSuggestionsRef = useRef<string[] | null>(null);

  // Derived phase
  const phase: GamePhase = loading
    ? 'loading'
    : !world
    ? 'no_world'
    : world.phase === 'onboarding'
    ? 'onboarding'
    : 'active';

  // ==========================================================================
  // SESSION MANAGEMENT
  // ==========================================================================

  const loadWorldData = useCallback(async (worldId: number) => {
    // Load player state
    const state = await gameService.getPlayerState(worldId);
    setPlayerState(state);

    // Load locations
    const locs = await gameService.getLocations(worldId);
    setLocations(locs);

    // Find current location
    const current = locs.find(l => l.is_current) || null;
    setCurrentLocation(current);

    // Load messages via poll endpoint
    try {
      const pollData = await gameService.pollUpdates(worldId, null);
      if (pollData.messages.length > 0) {
        setMessages(pollData.messages);
        setLastMessageId(pollData.messages[pollData.messages.length - 1].id);
      } else {
        setMessages([]);
        setLastMessageId(null);
      }
    } catch {
      setMessages([]);
      setLastMessageId(null);
    }

    // Load suggestions
    const suggs = await gameService.getActionSuggestions(worldId);
    setSuggestions(suggs);
  }, []);

  const loadWorld = useCallback(async (worldId: number): Promise<World> => {
    setLoading(true);
    try {
      const worldData = await gameService.getWorld(worldId);
      setWorld(worldData);
      await loadWorldData(worldId);
      return worldData;
    } finally {
      setLoading(false);
    }
  }, [loadWorldData]);

  const clearWorld = useCallback(() => {
    setWorld(null);
    setPlayerState(null);
    setCurrentLocation(null);
    setLocations([]);
    setMessages([]);
    setSuggestions([]);
    setLastMessageId(null);
    setIsChatMode(false);
  }, []);

  // ==========================================================================
  // PLAYER ACTIONS
  // ==========================================================================

  const submitAction = useCallback(async (actionText: string): Promise<void> => {
    if (!world || actionInProgress) return;

    setActionInProgress(true);
    // Store current suggestions to suppress - polling won't restore these same suggestions
    suppressedSuggestionsRef.current = [...suggestions];
    setSuggestions([]); // Clear suggestions for new turn

    // Optimistically add user message
    const tempMessage: GameMessage = {
      id: -Date.now(),
      content: actionText,
      role: 'user',
      agent_id: null,
      agent_name: null,
      thinking: null,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempMessage]);

    try {
      await gameService.submitAction(world.id, actionText);
    } catch (error) {
      setMessages(prev => prev.filter(m => m.id !== tempMessage.id));
      throw error;
    } finally {
      setActionInProgress(false);
    }
  }, [world, actionInProgress, suggestions]);

  const sendOnboardingMessage = useCallback(async (message: string): Promise<void> => {
    if (!world || !world.onboarding_room_id || actionInProgress) return;

    setActionInProgress(true);

    const tempMessage: GameMessage = {
      id: -Date.now(),
      content: message,
      role: 'user',
      agent_id: null,
      agent_name: null,
      thinking: null,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempMessage]);

    try {
      await api.sendMessage(world.onboarding_room_id, {
        content: message,
        role: 'user',
        participant_type: 'user',
        participant_name: world.user_name || 'Player',
      });
    } catch (error) {
      setMessages(prev => prev.filter(m => m.id !== tempMessage.id));
      throw error;
    } finally {
      setActionInProgress(false);
    }
  }, [world, actionInProgress]);

  const useSuggestion = useCallback(async (index: number): Promise<void> => {
    if (index >= 0 && index < suggestions.length) {
      await submitAction(suggestions[index]);
    }
  }, [suggestions, submitAction]);

  // ==========================================================================
  // LOCATION MANAGEMENT
  // ==========================================================================

  const travelTo = useCallback(async (locationId: number): Promise<void> => {
    if (!world) return;

    setActionInProgress(true);
    try {
      await gameService.travelToLocation(world.id, locationId);

      const updatedLocs = await gameService.getLocations(world.id);
      setLocations(updatedLocs);

      const newCurrent = updatedLocs.find(l => l.id === locationId) || null;
      setCurrentLocation(newCurrent);

      if (newCurrent) {
        const msgs = await gameService.getLocationMessages(world.id, newCurrent.id);
        setMessages(msgs);
        setLastMessageId(msgs.length > 0 ? msgs[msgs.length - 1].id : null);
      }
    } finally {
      setActionInProgress(false);
    }
  }, [world]);

  const updateLocationLabel = useCallback(async (
    locationId: number,
    label: string
  ): Promise<void> => {
    if (!world) return;

    await gameService.updateLocationLabel(world.id, locationId, label);

    setLocations(prev =>
      prev.map(loc => loc.id === locationId ? { ...loc, label } : loc)
    );

    if (currentLocation?.id === locationId) {
      setCurrentLocation(prev => prev ? { ...prev, label } : null);
    }
  }, [world, currentLocation]);

  const viewLocationHistory = useCallback(async (
    locationId: number
  ): Promise<GameMessage[]> => {
    if (!world) return [];
    return gameService.getLocationMessages(world.id, locationId);
  }, [world]);

  // ==========================================================================
  // POLLING
  // ==========================================================================

  const pollForUpdates = useCallback(async () => {
    if (!world) return;

    try {
      const pollOnboarding = mode === 'onboarding';
      const updates = await gameService.pollUpdates(world.id, lastMessageId, pollOnboarding);

      if (updates.messages.length > 0) {
        setMessages(prev => {
          const filtered = prev.filter(m => m.id > 0 || !updates.messages.some(
            (nm: GameMessage) => nm.content === m.content && nm.role === m.role
          ));
          return [...filtered, ...updates.messages];
        });
        setLastMessageId(updates.messages[updates.messages.length - 1].id);
      }

      const stateUpdate = updates.state;
      if (stateUpdate) {
        // Check if inventory count changed - if so, fetch full inventory
        const currentInventoryCount = playerState?.inventory?.length ?? 0;
        let newInventory = playerState?.inventory ?? [];

        if (stateUpdate.inventory_count !== currentInventoryCount) {
          try {
            const inventoryData = await gameService.getInventory(world.id);
            newInventory = inventoryData.items;
          } catch (error) {
            console.error('Failed to fetch inventory:', error);
          }
        }

        setPlayerState(prev => prev ? {
          ...prev,
          stats: stateUpdate.stats,
          turn_count: stateUpdate.turn_count,
          inventory: newInventory,
        } : null);

        // Update chat mode state - detect transition from chat mode to game mode
        const wasChatMode = isChatMode;
        const nowChatMode = stateUpdate.is_chat_mode || false;
        setIsChatMode(nowChatMode);

        // When exiting chat mode, clear messages and reset to fresh game-mode messages
        if (wasChatMode && !nowChatMode) {
          setMessages([]);
          setLastMessageId(null);
          // Suggestions will be fetched in the next poll cycle
        }

        if (stateUpdate.phase !== world.phase) {
          setWorld(prev => prev ? { ...prev, phase: stateUpdate.phase } : null);

          if (stateUpdate.phase === 'active' && world.phase === 'onboarding') {
            const locs = await gameService.getLocations(world.id);
            setLocations(locs);
            const current = locs.find(l => l.is_current) || null;
            setCurrentLocation(current);
          }
        }
      }

      // Sync current location from backend polling response
      // This ensures UI stays in sync even if travelTo had timing issues
      const polledLocation = updates.location;
      if (polledLocation && polledLocation.id && currentLocation?.id !== polledLocation.id) {
        // Location changed - fetch fresh locations to get full location object
        const freshLocs = await gameService.getLocations(world.id);
        setLocations(freshLocs);
        const newCurrent = freshLocs.find(l => l.id === polledLocation.id) || null;
        setCurrentLocation(newCurrent);
      }

      // Update suggestions from poll response (always included to avoid race conditions)
      // But skip if they match the suppressed suggestions - this prevents restoring
      // old suggestions after user submitted an action
      if (updates.suggestions) {
        const suppressed = suppressedSuggestionsRef.current;
        const areSameSuggestions = suppressed !== null &&
          suppressed.length === updates.suggestions.length &&
          suppressed.every((s, i) => s === updates.suggestions[i]);

        if (!areSameSuggestions) {
          // New/different suggestions - clear suppression and update
          suppressedSuggestionsRef.current = null;
          setSuggestions(updates.suggestions);
        }
        // If same as suppressed, don't restore them
      }
    } catch (error) {
      console.error('Polling error:', error);
    }
  }, [world, lastMessageId, mode, playerState, isChatMode, currentLocation]);

  const pollChattingAgents = useCallback(async () => {
    if (!world) return;

    try {
      const pollOnboarding = mode === 'onboarding';
      const chattingAgents = await gameService.getChattingAgents(world.id, pollOnboarding);

      setMessages(prev => {
        const prevChatting = prev.filter(m => m.is_chatting);

        if (chattingAgents.length === 0 && prevChatting.length === 0) {
          return prev;
        }

        const withoutChatting = prev.filter(m => !m.is_chatting);

        const chattingMessages: GameMessage[] = chattingAgents.map(agent => ({
          id: -agent.id,
          content: agent.response_text || '',
          role: 'assistant' as const,
          agent_id: agent.id,
          agent_name: agent.name,
          thinking: agent.thinking_text || null,
          timestamp: new Date().toISOString(),
          is_chatting: true,
        }));

        const hasSameState = chattingMessages.length === prevChatting.length &&
          chattingMessages.every(msg =>
            prevChatting.some(prev =>
              prev.agent_id === msg.agent_id &&
              prev.thinking === msg.thinking &&
              prev.content === msg.content
            )
          );

        if (hasSameState) {
          return prev;
        }

        return [...withoutChatting, ...chattingMessages];
      });
    } catch (error) {
      console.error('Chatting poll error:', error);
    }
  }, [world, mode]);

  const startPolling = useCallback(() => {
    if (!pollingInterval) {
      const interval = window.setInterval(pollForUpdates, 2000);
      setPollingInterval(interval);
    }
    if (!chattingPollInterval) {
      const interval = window.setInterval(pollChattingAgents, 1500);
      setChattingPollInterval(interval);
    }
  }, [pollForUpdates, pollChattingAgents, pollingInterval, chattingPollInterval]);

  const stopPolling = useCallback(() => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      setPollingInterval(null);
    }
    if (chattingPollInterval) {
      clearInterval(chattingPollInterval);
      setChattingPollInterval(null);
    }
  }, [pollingInterval, chattingPollInterval]);

  // Start/stop polling based on world
  useEffect(() => {
    if (world && !pollingInterval) {
      startPolling();
    }
    return () => stopPolling();
  }, [world, pollingInterval, startPolling, stopPolling]);

  // ==========================================================================
  // CONTEXT VALUE
  // ==========================================================================

  const value: SessionContextValue = {
    world,
    playerState,
    currentLocation,
    locations,
    messages,
    suggestions,
    phase,
    loading,
    actionInProgress,
    isChatMode,

    loadWorld,
    clearWorld,

    submitAction,
    sendOnboardingMessage,
    useSuggestion,

    travelTo,
    updateLocationLabel,
    viewLocationHistory,

    startPolling,
    stopPolling,
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}

// =============================================================================
// HOOK
// =============================================================================

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
