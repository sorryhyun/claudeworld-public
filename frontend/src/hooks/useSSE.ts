import { useEffect, useRef, useState, useCallback } from "react";
import { API_BASE_URL, getApiKey } from "../services/apiClient";

/** Per-agent streaming state accumulated from SSE deltas */
export interface AgentStreamState {
  thinking_text: string;
  response_text: string;
  agent_name?: string;
  temp_id: string;
  has_narrated?: boolean;
  narration_text?: string;
}

/** SSE event received from the server */
interface SSEEvent {
  type: string;
  agent_id?: number;
  agent_name?: string;
  temp_id?: string;
  delta?: string;
  skipped?: boolean;
  // new_message fields
  message?: {
    id: number;
    content: string;
    role: string;
    agent_id: number | null;
    agent_name?: string | null;
    agent_profile_pic?: string | null;
    thinking?: string | null;
    timestamp: string;
    chat_session_id?: number | null;
    game_time_snapshot?: { hour: number; minute: number; day: number } | null;
  };
}

export interface UseSSEReturn {
  isConnected: boolean;
  streamingAgents: Map<number, AgentStreamState>;
  /** Last new_message event received (triggers re-render) */
  lastNewMessage: SSEEvent["message"] | null;
  /** Counter that increments on each new_message - for useEffect dependencies */
  newMessageSeq: number;
}

// Exponential backoff delays in ms
const BACKOFF_DELAYS = [1000, 2000, 5000, 10000, 30000];

function getBackoffDelay(attempt: number): number {
  return BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)];
}

/**
 * Hook that manages an SSE connection to stream real-time agent events.
 *
 * Handles:
 * - Ticket-based auth (EventSource can't send custom headers)
 * - Reconnection with exponential backoff
 * - Accumulation of streaming deltas per agent
 * - new_message events for immediate message display
 */
export function useSSE(roomId: number | null): UseSSEReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [streamingAgents, setStreamingAgents] = useState<
    Map<number, AgentStreamState>
  >(new Map());
  const [lastNewMessage, setLastNewMessage] = useState<
    SSEEvent["message"] | null
  >(null);
  const [newMessageSeq, setNewMessageSeq] = useState(0);

  // Refs for reconnection management
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isActiveRef = useRef(true);
  // Track temp_id → agent_id mapping for delta events that don't include agent_id
  const tempIdMapRef = useRef<Map<string, number>>(new Map());

  /** Fetch a single-use SSE ticket from the backend */
  const fetchTicket = useCallback(
    async (targetRoomId: number): Promise<string | null> => {
      try {
        const apiKey = getApiKey();
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) headers["X-API-Key"] = apiKey;

        const resp = await fetch(
          `${API_BASE_URL}/rooms/${targetRoomId}/stream/ticket`,
          { method: "POST", headers },
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.ticket || null;
      } catch {
        return null;
      }
    },
    [],
  );

  /** Connect to the SSE endpoint */
  const connect = useCallback(
    async (targetRoomId: number) => {
      if (!isActiveRef.current) return;

      // Clean up any existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      const ticket = await fetchTicket(targetRoomId);
      if (!ticket || !isActiveRef.current) {
        // Retry with backoff
        scheduleReconnect(targetRoomId);
        return;
      }

      const url = `${API_BASE_URL}/rooms/${targetRoomId}/stream?ticket=${encodeURIComponent(ticket)}`;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        setIsConnected(true);
        reconnectAttemptRef.current = 0;
      };

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
        setIsConnected(false);
        if (isActiveRef.current) {
          scheduleReconnect(targetRoomId);
        }
      };

      // Handle named events

      // Catch-up: restore streaming state for agents already mid-stream on connect/reconnect.
      // The server sends one of these per in-flight stream immediately after `connected`,
      // which is the only thing that makes a turn started before this connection visible.
      es.addEventListener("catch_up", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const agentId = data.agent_id;
          if (agentId == null) return;

          const tempId = data.temp_id || `catch_up_${agentId}`;
          tempIdMapRef.current.set(tempId, agentId);

          setStreamingAgents((prev) => {
            // Don't overwrite if we already have this agent (stream_start arrived first)
            if (prev.has(agentId)) return prev;
            const next = new Map(prev);
            next.set(agentId, {
              thinking_text: data.thinking_text || "",
              response_text: data.response_text || "",
              agent_name: data.agent_name,
              temp_id: tempId,
              narration_text: data.narration_text || "",
            });
            return next;
          });
        } catch {
          /* ignore parse errors */
        }
      });

      es.addEventListener("stream_start", (e: MessageEvent) => {
        try {
          const data: SSEEvent = JSON.parse(e.data);
          if (data.agent_id != null && data.temp_id) {
            tempIdMapRef.current.set(data.temp_id, data.agent_id);
            setStreamingAgents((prev) => {
              const next = new Map(prev);
              next.set(data.agent_id!, {
                thinking_text: "",
                response_text: "",
                agent_name: data.agent_name,
                temp_id: data.temp_id!,
              });
              return next;
            });
          }
        } catch {
          /* ignore parse errors */
        }
      });

      /**
       * Apply one delta to an agent's bubble, creating the bubble if the
       * `stream_start` that should have created it never reached this client.
       *
       * Dropping the delta instead is what made the opening scene invisible: the
       * turn a world's first room starts is broadcast before the client knows
       * the room's id, so every delta after it applied to nothing. The server
       * replays a `catch_up` on connect now, and this is the belt to that
       * braces — it also covers a reconnect landing mid-delta against an older
       * server.
       */
      const applyDelta = (
        e: MessageEvent,
        field: "thinking_text" | "response_text" | "narration_text",
      ) => {
        try {
          const data: SSEEvent = JSON.parse(e.data);
          const agentId =
            data.agent_id ?? tempIdMapRef.current.get(data.temp_id || "");
          if (agentId == null) return;
          const delta = data.delta || "";
          if (!delta) return;

          if (data.temp_id) tempIdMapRef.current.set(data.temp_id, agentId);

          setStreamingAgents((prev) => {
            const existing = prev.get(agentId) ?? {
              thinking_text: "",
              response_text: "",
              agent_name: data.agent_name,
              temp_id: data.temp_id || `recovered_${agentId}`,
              narration_text: "",
            };
            const next = new Map(prev);
            next.set(agentId, {
              ...existing,
              [field]: (existing[field] || "") + delta,
            });
            return next;
          });
        } catch {
          /* ignore */
        }
      };

      es.addEventListener("content_delta", (e: MessageEvent) =>
        applyDelta(e, "response_text"),
      );

      es.addEventListener("thinking_delta", (e: MessageEvent) =>
        applyDelta(e, "thinking_text"),
      );

      es.addEventListener("narration_delta", (e: MessageEvent) =>
        applyDelta(e, "narration_text"),
      );

      es.addEventListener("stream_end", (e: MessageEvent) => {
        try {
          const data: SSEEvent = JSON.parse(e.data);
          const agentId =
            data.agent_id ?? tempIdMapRef.current.get(data.temp_id || "");
          if (agentId == null) return;

          // Clean up temp_id mapping
          if (data.temp_id) tempIdMapRef.current.delete(data.temp_id);

          // Remove agent from streaming map
          setStreamingAgents((prev) => {
            const next = new Map(prev);
            next.delete(agentId);
            return next;
          });
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("new_message", (e: MessageEvent) => {
        try {
          const data: SSEEvent = JSON.parse(e.data);
          if (data.message) {
            setLastNewMessage(data.message);
            setNewMessageSeq((s) => s + 1);

            // The `narration` tool persists its message mid-turn and the agent
            // keeps working, so the buffer has to be dropped here: the saved
            // message now carries that text, and leaving it would render it
            // twice -- once saved, once in the live bubble -- and make a second
            // `narration` call in the same turn append onto the stale prose.
            const agentId = data.message.agent_id;
            if (agentId != null) {
              setStreamingAgents((prev) => {
                const existing = prev.get(agentId);
                if (!existing?.narration_text) return prev;
                const next = new Map(prev);
                next.set(agentId, { ...existing, narration_text: "" });
                return next;
              });
            }
          }
        } catch {
          /* ignore */
        }
      });

      // keepalive events are handled automatically by EventSource (no action needed)
    },
    [fetchTicket],
  );

  // scheduleReconnect as a plain function using refs
  function scheduleReconnect(targetRoomId: number) {
    if (!isActiveRef.current) return;
    const delay = getBackoffDelay(reconnectAttemptRef.current);
    reconnectAttemptRef.current++;
    reconnectTimerRef.current = setTimeout(() => {
      if (isActiveRef.current) {
        connect(targetRoomId);
      }
    }, delay);
  }

  // Main effect: connect when roomId changes
  useEffect(() => {
    isActiveRef.current = true;
    reconnectAttemptRef.current = 0;
    tempIdMapRef.current.clear();
    setStreamingAgents(new Map());
    setIsConnected(false);
    setLastNewMessage(null);

    if (roomId != null) {
      connect(roomId);
    }

    return () => {
      isActiveRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      tempIdMapRef.current.clear();
      setIsConnected(false);
    };
  }, [roomId, connect]);

  return { isConnected, streamingAgents, lastNewMessage, newMessageSeq };
}
