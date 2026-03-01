import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  ReactNode,
} from "react";
import * as gameService from "../services/gameService";
import { api } from "../services";
import { useSSE } from "../hooks/useSSE";
import { useToast } from "./ToastContext";
import type {
  World,
  Location,
  PlayerState,
  GameMessage,
  GamePhase,
} from "./GameContext";

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
  isClauding: boolean; // True when agents are actively processing (Action_Manager, sub-agents, or chat mode NPCs)
  isChatMode: boolean;

  // Session management
  loadWorld: (worldId: number) => Promise<World>;
  clearWorld: () => void;

  // Player actions
  submitAction: (
    actionText: string,
    imageData?: string,
    imageMediaType?: string,
  ) => Promise<void>;
  sendOnboardingMessage: (message: string) => Promise<void>;
  selectSuggestion: (index: number) => Promise<void>;

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
  mode: "chat" | "onboarding" | "game";
}

export function SessionProvider({
  children,
  mode: _mode,
}: SessionProviderProps) {
  const { addToast } = useToast();

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
  const pollingIntervalRef = useRef<number | null>(null);
  const chattingPollIntervalRef = useRef<number | null>(null);
  const [lastMessageId, setLastMessageId] = useState<number | null>(null);
  const [isChatMode, setIsChatMode] = useState(false);

  // Ref to suppress suggestions during action (avoids stale closure in setInterval)
  // Stores the suggestions that were visible when action was submitted
  // Polling will only update suggestions if they're different from these
  const suppressedSuggestionsRef = useRef<string[] | null>(null);

  // Resolve the room ID for SSE connection based on game phase
  const resolvedRoomId = useMemo(() => {
    if (!world) return null;
    if (world.phase === "onboarding") return world.onboarding_room_id;
    return currentLocation?.room_id ?? null;
  }, [world, currentLocation]);

  // SSE connection for real-time streaming
  const {
    isConnected: sseConnected,
    streamingAgents,
    lastNewMessage,
    newMessageSeq,
  } = useSSE(resolvedRoomId);

  // Track SSE connected state in a ref for use in polling callbacks
  const sseConnectedRef = useRef(sseConnected);
  sseConnectedRef.current = sseConnected;

  // Track whether we've already triggered the initial onboarding for this world
  const onboardingTriggeredRef = useRef<number | null>(null);

  // Trigger onboarding start after SSE connects (ensures thinking stream is visible)
  useEffect(() => {
    if (
      sseConnected &&
      world?.phase === "onboarding" &&
      world.id !== onboardingTriggeredRef.current
    ) {
      // Only trigger if there are no assistant messages yet (first-time trigger)
      const hasAssistantMessages = messages.some(
        (m) => m.role === "assistant" && !m.is_chatting,
      );
      if (!hasAssistantMessages) {
        onboardingTriggeredRef.current = world.id;
        gameService.startOnboarding(world.id).catch((err) => {
          console.error("Failed to start onboarding:", err);
        });
      }
    }
  }, [sseConnected, world?.phase, world?.id, messages]);

  // Handle new_message from SSE - append to game messages
  useEffect(() => {
    if (!lastNewMessage || !lastNewMessage.id) return;

    setMessages((prev) => {
      // Skip if we already have this message
      if (prev.some((m) => m.id === lastNewMessage.id)) return prev;

      const newMsg: GameMessage = {
        id: lastNewMessage.id,
        content: lastNewMessage.content,
        role: lastNewMessage.role as "user" | "assistant",
        agent_id: lastNewMessage.agent_id,
        agent_name: lastNewMessage.agent_name || null,
        thinking: lastNewMessage.thinking || null,
        timestamp: lastNewMessage.timestamp,
        game_time_snapshot: lastNewMessage.game_time_snapshot,
      };
      return [...prev, newMsg];
    });

    // Update last message ID for polling sync
    if (
      typeof lastNewMessage.id === "number" &&
      (lastMessageId === null || lastNewMessage.id > lastMessageId)
    ) {
      setLastMessageId(lastNewMessage.id);
    }
  }, [newMessageSeq, lastNewMessage, lastMessageId]);

  // Build chatting indicators from SSE streaming agents
  useEffect(() => {
    if (!sseConnected) return; // Let polling handle it when SSE is down

    setMessages((prev) => {
      const prevChatting = prev.filter((m) => m.is_chatting);

      if (streamingAgents.size === 0 && prevChatting.length === 0) {
        return prev;
      }

      const withoutChatting = prev.filter((m) => !m.is_chatting);

      if (streamingAgents.size === 0) {
        return withoutChatting;
      }

      const chattingMessages: GameMessage[] = [];
      streamingAgents.forEach((state, agentId) => {
        // For Action_Manager, show narration_text (streamed from narration tool)
        // instead of raw response_text (which contains tool discussions)
        const isActionManager = state.agent_name === "Action_Manager";
        chattingMessages.push({
          id: -agentId,
          content: isActionManager ? (state.narration_text || "") : (state.response_text || ""),
          role: "assistant",
          agent_id: agentId,
          agent_name: state.agent_name || null,
          thinking: state.thinking_text || null,
          timestamp: new Date().toISOString(),
          is_chatting: true,
          has_narrated: state.has_narrated,
        });
      });

      const hasSameState =
        chattingMessages.length === prevChatting.length &&
        chattingMessages.every((msg) =>
          prevChatting.some(
            (prev) =>
              prev.agent_id === msg.agent_id &&
              prev.thinking === msg.thinking &&
              prev.content === msg.content &&
              prev.has_narrated === msg.has_narrated,
          ),
        );

      if (hasSameState) return prev;
      return [...withoutChatting, ...chattingMessages];
    });
  }, [sseConnected, streamingAgents]);

  // Derived phase
  const phase: GamePhase = loading
    ? "loading"
    : !world
      ? "no_world"
      : world.phase === "onboarding"
        ? "onboarding"
        : "active";

  // Derived isClauding - true when agents are actively generating responses
  // Blocks user input/suggestions while Claude is working
  const isClauding = useMemo(() => {
    if (actionInProgress) return true;
    if (phase !== "active") return false;

    const chattingAgents = messages.filter((m) => m.is_chatting);
    if (chattingAgents.length === 0) return false;

    // In chat mode, any chatting agent blocks input
    if (isChatMode) return true;

    // Chat_Summarizer should block input while summarizing the conversation
    const chatSummarizer = chattingAgents.find(
      (m) => m.agent_name === "Chat_Summarizer",
    );
    if (chatSummarizer) {
      return true;
    }

    // In normal gameplay, only block if Action_Manager is chatting AND hasn't produced narration yet
    // Once narration tool is used, has_narrated will be true (sent from backend)
    // Sub-agents (negative IDs) should NOT block - they run after narration
    const actionManager = chattingAgents.find(
      (m) => m.agent_name === "Action_Manager",
    );
    if (actionManager) {
      // Block only if Action_Manager hasn't produced narration yet
      return !actionManager.has_narrated;
    }

    // Sub-agents don't block input
    return false;
  }, [actionInProgress, phase, messages, isChatMode]);

  // ==========================================================================
  // SESSION MANAGEMENT
  // ==========================================================================

  const loadWorldData = useCallback(async (worldId: number) => {
    try {
      // Load all independent data in parallel
      const [state, locs, pollResult, suggs] = await Promise.all([
        gameService.getPlayerState(worldId),
        gameService.getLocations(worldId),
        gameService.pollUpdates(worldId, null).catch(() => null),
        gameService.getActionSuggestions(worldId),
      ]);

      setPlayerState(state);
      setLocations(locs);
      setCurrentLocation(locs.find((l) => l.is_current) || null);

      if (pollResult && pollResult.messages.length > 0) {
        setMessages(pollResult.messages);
        setLastMessageId(pollResult.messages[pollResult.messages.length - 1].id);
      } else {
        setMessages([]);
        setLastMessageId(null);
      }

      setSuggestions(suggs);
    } catch (error) {
      console.error("Failed to load world data:", error);
      addToast("Failed to load world data", "error");
    }
  }, [addToast]);

  const loadWorld = useCallback(
    async (worldId: number): Promise<World> => {
      setLoading(true);
      try {
        const worldData = await gameService.getWorld(worldId);
        setWorld(worldData);
        await loadWorldData(worldId);
        return worldData;
      } finally {
        setLoading(false);
      }
    },
    [loadWorldData],
  );

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

  const submitAction = useCallback(
    async (
      actionText: string,
      imageData?: string,
      imageMediaType?: string,
    ): Promise<void> => {
      if (!world || actionInProgress) return;

      setActionInProgress(true);
      // Store current suggestions to suppress - polling won't restore these same suggestions
      suppressedSuggestionsRef.current = [...suggestions];
      setSuggestions([]); // Clear suggestions for new turn

      // Optimistically add user message
      const tempMessage: GameMessage = {
        id: -Date.now(),
        content: actionText,
        role: "user",
        agent_id: null,
        agent_name: null,
        thinking: null,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempMessage]);

      try {
        await gameService.submitAction(
          world.id,
          actionText,
          imageData,
          imageMediaType,
        );
      } catch (error) {
        setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
        throw error;
      } finally {
        setActionInProgress(false);
      }
    },
    [world, actionInProgress, suggestions],
  );

  const sendOnboardingMessage = useCallback(
    async (message: string): Promise<void> => {
      if (!world || !world.onboarding_room_id || actionInProgress) return;

      setActionInProgress(true);

      const tempMessage: GameMessage = {
        id: -Date.now(),
        content: message,
        role: "user",
        agent_id: null,
        agent_name: null,
        thinking: null,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempMessage]);

      try {
        await api.sendMessage(world.onboarding_room_id, {
          content: message,
          role: "user",
          participant_type: "user",
          participant_name: world.user_name || "Player",
        });
      } catch (error) {
        setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
        throw error;
      } finally {
        setActionInProgress(false);
      }
    },
    [world, actionInProgress],
  );

  const selectSuggestion = useCallback(
    async (index: number): Promise<void> => {
      if (index >= 0 && index < suggestions.length) {
        await submitAction(suggestions[index]);
      }
    },
    [suggestions, submitAction],
  );

  // ==========================================================================
  // LOCATION MANAGEMENT
  // ==========================================================================

  const travelTo = useCallback(
    async (locationId: number): Promise<void> => {
      if (!world) return;

      setActionInProgress(true);
      try {
        await gameService.travelToLocation(world.id, locationId);

        // Load locations and messages in parallel
        const [updatedLocs, msgs] = await Promise.all([
          gameService.getLocations(world.id),
          gameService.getLocationMessages(world.id, locationId),
        ]);
        setLocations(updatedLocs);

        const newCurrent = updatedLocs.find((l) => l.id === locationId) || null;
        setCurrentLocation(newCurrent);
        setMessages(msgs);
        setLastMessageId(msgs.length > 0 ? msgs[msgs.length - 1].id : null);
      } finally {
        setActionInProgress(false);
      }
    },
    [world],
  );

  const updateLocationLabel = useCallback(
    async (locationId: number, label: string): Promise<void> => {
      if (!world) return;

      await gameService.updateLocationLabel(world.id, locationId, label);

      setLocations((prev) =>
        prev.map((loc) => (loc.id === locationId ? { ...loc, label } : loc)),
      );

      if (currentLocation?.id === locationId) {
        setCurrentLocation((prev) => (prev ? { ...prev, label } : null));
      }
    },
    [world, currentLocation],
  );

  const viewLocationHistory = useCallback(
    async (locationId: number): Promise<GameMessage[]> => {
      if (!world) return [];
      return gameService.getLocationMessages(world.id, locationId);
    },
    [world],
  );

  // ==========================================================================
  // POLLING
  // ==========================================================================

  const pollForUpdates = useCallback(async () => {
    if (!world) return;

    try {
      // Use world.phase directly instead of mode prop to ensure polling
      // immediately switches to the correct room when phase transitions
      const pollOnboarding = world.phase === "onboarding";
      const updates = await gameService.pollUpdates(
        world.id,
        lastMessageId,
        pollOnboarding,
      );

      if (updates.messages.length > 0) {
        setMessages((prev) => {
          // Remove optimistic (negative ID) messages that now have real counterparts
          const filtered = prev.filter(
            (m) =>
              m.id > 0 ||
              !updates.messages.some(
                (nm: GameMessage) =>
                  nm.content === m.content && nm.role === m.role,
              ),
          );
          // Deduplicate: SSE may have already delivered some messages
          const existingIds = new Set(filtered.map((m) => m.id));
          const trulyNew = updates.messages.filter(
            (m: GameMessage) => !existingIds.has(m.id),
          );
          if (trulyNew.length === 0) return filtered;
          return [...filtered, ...trulyNew];
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
            console.error("Failed to fetch inventory:", error);
          }
        }

        setPlayerState((prev) =>
          prev
            ? {
                ...prev,
                stats: stateUpdate.stats,
                turn_count: stateUpdate.turn_count,
                inventory: newInventory,
                game_time: stateUpdate.game_time ?? prev.game_time,
              }
            : null,
        );

        // Update chat mode state - detect transition from chat mode to game mode
        const wasChatMode = isChatMode;
        const nowChatMode = stateUpdate.is_chat_mode || false;
        setIsChatMode(nowChatMode);

        // When exiting chat mode, clear messages and use the resume message ID
        // to avoid re-fetching old narration from before chat mode
        if (wasChatMode && !nowChatMode) {
          setMessages([]);
          // Use chat_mode_start_message_id as the resume point to only fetch new messages
          const resumeId = stateUpdate.chat_mode_start_message_id ?? null;
          setLastMessageId(resumeId);
          // Suggestions will be fetched in the next poll cycle
        }

        // Update phase and pending_phase
        if (
          stateUpdate.phase !== world.phase ||
          stateUpdate.pending_phase !== world.pending_phase
        ) {
          setWorld((prev) =>
            prev
              ? {
                  ...prev,
                  phase: stateUpdate.phase,
                  pending_phase: stateUpdate.pending_phase ?? null,
                }
              : null,
          );

          if (stateUpdate.phase === "active" && world.phase === "onboarding") {
            const locs = await gameService.getLocations(world.id);
            setLocations(locs);
            const current = locs.find((l) => l.is_current) || null;
            setCurrentLocation(current);
          }
        }
      }

      // Sync current location from backend polling response
      // This ensures UI stays in sync even if travelTo had timing issues
      const polledLocation = updates.location;
      if (
        polledLocation &&
        polledLocation.id &&
        currentLocation?.id !== polledLocation.id
      ) {
        // Location changed - fetch fresh locations to get full location object
        const freshLocs = await gameService.getLocations(world.id);
        setLocations(freshLocs);
        const newCurrent =
          freshLocs.find((l) => l.id === polledLocation.id) || null;
        setCurrentLocation(newCurrent);
      }

      // Update suggestions from poll response (always included to avoid race conditions)
      // But skip if they match the suppressed suggestions - this prevents restoring
      // old suggestions after user submitted an action
      if (updates.suggestions) {
        const suppressed = suppressedSuggestionsRef.current;
        const areSameSuggestions =
          suppressed !== null &&
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
      console.error("Polling error:", error);
    }
  }, [world, lastMessageId, playerState, isChatMode, currentLocation]);

  const pollChattingAgents = useCallback(async () => {
    if (!world) return;
    // Skip chatting agent polling when SSE provides real-time streaming state
    if (sseConnectedRef.current) return;

    try {
      // Use world.phase directly instead of mode prop to ensure polling
      // immediately switches to the correct room when phase transitions
      const pollOnboarding = world.phase === "onboarding";
      const chattingAgents = await gameService.getChattingAgents(
        world.id,
        pollOnboarding,
      );

      setMessages((prev) => {
        const prevChatting = prev.filter((m) => m.is_chatting);

        if (chattingAgents.length === 0 && prevChatting.length === 0) {
          return prev;
        }

        const withoutChatting = prev.filter((m) => !m.is_chatting);

        const chattingMessages: GameMessage[] = chattingAgents.map((agent) => {
          // For Action_Manager, don't show raw response_text - it contains tool discussions
          // The actual narration is created via the narration tool as a separate message
          const isActionManager = agent.name === "Action_Manager";
          return {
            id: -agent.id,
            content: isActionManager ? "" : agent.response_text || "",
            role: "assistant" as const,
            agent_id: agent.id,
            agent_name: agent.name,
            thinking: agent.thinking_text || null,
            timestamp: new Date().toISOString(),
            is_chatting: true,
            has_narrated: agent.has_narrated, // Track if Action_Manager has produced narration
          };
        });

        const hasSameState =
          chattingMessages.length === prevChatting.length &&
          chattingMessages.every((msg) =>
            prevChatting.some(
              (prev) =>
                prev.agent_id === msg.agent_id &&
                prev.thinking === msg.thinking &&
                prev.content === msg.content &&
                prev.has_narrated === msg.has_narrated,
            ),
          );

        if (hasSameState) {
          return prev;
        }

        return [...withoutChatting, ...chattingMessages];
      });
    } catch (error) {
      console.error("Chatting poll error:", error);
    }
  }, [world]);

  const startPolling = useCallback(() => {
    // When SSE is connected, use longer intervals as safety net
    const updateInterval = sseConnectedRef.current ? 15000 : 2000;
    const chattingInterval = sseConnectedRef.current ? 10000 : 1500;

    if (!pollingIntervalRef.current) {
      pollingIntervalRef.current = window.setInterval(pollForUpdates, updateInterval);
    }
    if (!chattingPollIntervalRef.current) {
      chattingPollIntervalRef.current = window.setInterval(pollChattingAgents, chattingInterval);
    }
  }, [pollForUpdates, pollChattingAgents]);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (chattingPollIntervalRef.current) {
      clearInterval(chattingPollIntervalRef.current);
      chattingPollIntervalRef.current = null;
    }
  }, []);

  // Start/stop polling based on world
  // When startPolling changes (due to new poll callbacks), restart intervals
  useEffect(() => {
    if (world) {
      stopPolling();
      startPolling();
    }
    return () => stopPolling();
  }, [world, startPolling, stopPolling]);

  // ==========================================================================
  // CONTEXT VALUE
  // ==========================================================================

  const value: SessionContextValue = useMemo(() => ({
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

    loadWorld,
    clearWorld,

    submitAction,
    sendOnboardingMessage,
    selectSuggestion,

    travelTo,
    updateLocationLabel,
    viewLocationHistory,

    startPolling,
    stopPolling,
  }), [
    world, playerState, currentLocation, locations, messages, suggestions,
    phase, loading, actionInProgress, isClauding, isChatMode, loadWorld,
    clearWorld, submitAction, sendOnboardingMessage, selectSuggestion,
    travelTo, updateLocationLabel, viewLocationHistory, startPolling, stopPolling,
  ]);

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

// =============================================================================
// HOOK
// =============================================================================

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return context;
}
