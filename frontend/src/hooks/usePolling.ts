import { useEffect, useRef, useState, useCallback } from "react";
import type { Message, ImageItem } from "../types";
import { API_BASE_URL, getFetchOptions } from "../services/apiClient";
import { useSSE } from "./useSSE";

interface UsePollingReturn {
  messages: Message[];
  sendMessage: (
    content: string,
    participant_type?: string,
    participant_name?: string,
    images?: ImageItem[],
    mentioned_agent_ids?: number[],
  ) => void;
  isConnected: boolean;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  resetMessages: () => Promise<void>;
}

const POLL_INTERVAL = 5000; // Poll every 5 seconds
const POLL_INTERVAL_SSE = 30000; // Safety-net polling when SSE connected
const STATUS_POLL_INTERVAL = 3000; // Poll agent status every 3 seconds

export const usePolling = (roomId: number | null): UsePollingReturn => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const pollIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusPollIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const immediatePollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastMessageIdRef = useRef<number>(0);
  const isInitialLoadRef = useRef(true);

  // SSE connection for real-time streaming
  const {
    isConnected: sseConnected,
    streamingAgents,
    lastNewMessage,
    newMessageSeq,
  } = useSSE(roomId);

  // Track SSE connected state in a ref for use in polling intervals
  const sseConnectedRef = useRef(sseConnected);
  sseConnectedRef.current = sseConnected;

  // Handle new_message from SSE - append to messages
  useEffect(() => {
    if (!lastNewMessage || !lastNewMessage.id) return;

    setMessages((prev) => {
      // Skip if we already have this message
      if (prev.some((m) => m.id === lastNewMessage.id)) return prev;

      const newMsg: Message = {
        id: lastNewMessage.id,
        content: lastNewMessage.content,
        role: lastNewMessage.role,
        agent_id: lastNewMessage.agent_id,
        agent_name: lastNewMessage.agent_name || undefined,
        agent_profile_pic: lastNewMessage.agent_profile_pic,
        thinking: lastNewMessage.thinking,
        timestamp: lastNewMessage.timestamp,
        game_time_snapshot: lastNewMessage.game_time_snapshot,
      };
      return [...prev, newMsg];
    });

    // Update last message ID for polling sync
    if (
      typeof lastNewMessage.id === "number" &&
      lastNewMessage.id > lastMessageIdRef.current
    ) {
      lastMessageIdRef.current = lastNewMessage.id;
    }
  }, [newMessageSeq, lastNewMessage]);

  // Build chatting indicators from SSE streaming agents
  useEffect(() => {
    setMessages((prev) => {
      const prevChatting = prev.filter((m) => m.is_chatting);

      // When SSE is connected, derive chatting state from streamingAgents map
      if (sseConnected) {
        if (streamingAgents.size === 0 && prevChatting.length === 0) {
          return prev;
        }

        const withoutChatting = prev.filter((m) => !m.is_chatting);

        if (streamingAgents.size === 0) {
          return withoutChatting;
        }

        const chattingMessages: Message[] = [];
        streamingAgents.forEach((state, agentId) => {
          chattingMessages.push({
            id: `chatting_${agentId}`,
            agent_id: agentId,
            agent_name: state.agent_name,
            content: state.response_text || "",
            role: "assistant",
            timestamp: new Date().toISOString(),
            is_chatting: true,
            thinking: state.thinking_text || null,
          });
        });

        // Check if chatting state actually changed
        const hasSameState =
          chattingMessages.length === prevChatting.length &&
          chattingMessages.every((msg) =>
            prevChatting.some(
              (prev) =>
                prev.agent_id === msg.agent_id &&
                prev.thinking === msg.thinking &&
                prev.content === msg.content,
            ),
          );

        if (hasSameState) return prev;
        return [...withoutChatting, ...chattingMessages];
      }

      // SSE not connected - polling handles chatting state (no change here)
      return prev;
    });
  }, [sseConnected, streamingAgents]);

  // Fetch all messages (initial load)
  const fetchAllMessages = useCallback(async () => {
    if (!roomId) return;

    try {
      const response = await fetch(
        `${API_BASE_URL}/rooms/${roomId}/messages`,
        getFetchOptions(),
      );

      if (response.ok) {
        const allMessages = await response.json();
        setMessages(allMessages);

        // Update last message ID
        if (allMessages.length > 0) {
          lastMessageIdRef.current = allMessages[allMessages.length - 1].id;
        }

        setIsConnected(true);
      } else {
        console.error("Failed to fetch messages:", response.statusText);
        setIsConnected(false);
      }
    } catch (error) {
      console.error("Error fetching messages:", error);
      setIsConnected(false);
    }
  }, [roomId]);

  // Poll for new messages
  const pollNewMessages = useCallback(async () => {
    if (!roomId) return;

    try {
      const url =
        lastMessageIdRef.current > 0
          ? `${API_BASE_URL}/rooms/${roomId}/messages/poll?since_id=${lastMessageIdRef.current}`
          : `${API_BASE_URL}/rooms/${roomId}/messages/poll`;

      const response = await fetch(url, getFetchOptions());

      if (response.ok) {
        const newMessages = await response.json();

        if (newMessages.length > 0) {
          setMessages((prev) => {
            // Deduplicate: SSE may have already delivered some messages
            const existingIds = new Set(prev.map((m) => m.id));
            const truly_new = newMessages.filter(
              (m: Message) => !existingIds.has(m.id),
            );
            if (truly_new.length === 0) return prev;
            return [...prev, ...truly_new];
          });
          // Update last message ID
          lastMessageIdRef.current = newMessages[newMessages.length - 1].id;
        }

        setIsConnected(true);
      } else {
        console.error("Failed to poll messages:", response.statusText);
        setIsConnected(false);
      }
    } catch (error) {
      console.error("Error polling messages:", error);
      setIsConnected(false);
    }
  }, [roomId]);

  // Poll for chatting agent status (only used when SSE is NOT connected)
  const pollChattingAgents = useCallback(async () => {
    if (!roomId) return;
    // Skip polling when SSE provides real-time streaming state
    if (sseConnectedRef.current) return;

    try {
      const response = await fetch(
        `${API_BASE_URL}/rooms/${roomId}/chatting-agents`,
        getFetchOptions(),
      );

      if (response.ok) {
        const data = await response.json();
        const chattingAgents = data.chatting_agents || [];

        // Add/update chatting indicators in messages
        setMessages((prev) => {
          const prevChatting = prev.filter((m) => m.is_chatting);

          // If nothing is chatting now and nothing was chatting before, avoid rewriting state
          if (chattingAgents.length === 0 && prevChatting.length === 0) {
            return prev;
          }

          // Remove old chatting indicators
          const withoutChatting = prev.filter((m) => !m.is_chatting);

          // Add new chatting indicators for agents that are chatting
          const chattingMessages = chattingAgents.map(
            (agent: {
              id: number;
              name: string;
              profile_pic?: string | null;
              response_text?: string;
              thinking_text?: string;
            }) => ({
              id: `chatting_${agent.id}` as string,
              agent_id: agent.id,
              agent_name: agent.name,
              agent_profile_pic: agent.profile_pic,
              content: agent.response_text || "",
              role: "assistant" as const,
              timestamp: new Date().toISOString(),
              is_chatting: true,
              thinking: agent.thinking_text || null,
            }),
          );

          // If the chatting state hasn't changed (same agents with same thinking/content), avoid state churn
          const hasSameChattingState =
            chattingMessages.length === prevChatting.length &&
            chattingMessages.every((msg: (typeof chattingMessages)[number]) =>
              prevChatting.some(
                (prevMsg) =>
                  prevMsg.agent_id === msg.agent_id &&
                  prevMsg.agent_name === msg.agent_name &&
                  prevMsg.agent_profile_pic === msg.agent_profile_pic &&
                  prevMsg.thinking === msg.thinking &&
                  prevMsg.content === msg.content,
              ),
            );

          if (hasSameChattingState) {
            return prev;
          }

          return [...withoutChatting, ...chattingMessages];
        });
      }
    } catch (error) {
      console.error("Error polling chatting agents:", error);
    }
  }, [roomId]);

  // Setup polling with visibility API optimization
  useEffect(() => {
    if (!roomId) {
      setIsConnected(false);
      return;
    }

    // Clear messages when switching rooms
    setMessages([]);
    lastMessageIdRef.current = 0;
    isInitialLoadRef.current = true;
    let isActive = true;
    let isTabVisible = !document.hidden;

    // Initial load
    fetchAllMessages();

    // Start polling for new messages using setTimeout to prevent stacking
    // When SSE is connected, use longer interval as safety net
    const scheduleNextPoll = () => {
      if (!isActive) return;

      pollIntervalRef.current = setTimeout(
        async () => {
          // Only poll if tab is visible
          if (isTabVisible) {
            await pollNewMessages();
          }
          scheduleNextPoll(); // Schedule next poll after this one completes
        },
        sseConnectedRef.current ? POLL_INTERVAL_SSE : POLL_INTERVAL,
      );
    };

    // Start polling for chatting agent status (skipped internally when SSE connected)
    const scheduleNextStatusPoll = () => {
      if (!isActive) return;

      statusPollIntervalRef.current = setTimeout(async () => {
        // Only poll if tab is visible
        if (isTabVisible) {
          await pollChattingAgents();
        }
        scheduleNextStatusPoll(); // Schedule next poll after this one completes
      }, STATUS_POLL_INTERVAL);
    };

    // Handle visibility change - pause/resume polling
    const handleVisibilityChange = () => {
      isTabVisible = !document.hidden;
      if (isTabVisible) {
        // Tab became visible - fetch immediately to catch up
        pollNewMessages();
        if (!sseConnectedRef.current) {
          pollChattingAgents();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Start both polling cycles
    scheduleNextPoll();
    scheduleNextStatusPoll();

    return () => {
      // Cleanup on unmount or room change
      isActive = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pollIntervalRef.current) {
        clearTimeout(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (statusPollIntervalRef.current) {
        clearTimeout(statusPollIntervalRef.current);
        statusPollIntervalRef.current = null;
      }
      if (immediatePollTimeoutRef.current) {
        clearTimeout(immediatePollTimeoutRef.current);
        immediatePollTimeoutRef.current = null;
      }
      setIsConnected(false);
    };
  }, [roomId, fetchAllMessages, pollNewMessages, pollChattingAgents]);

  const sendMessage = async (
    content: string,
    participant_type?: string,
    participant_name?: string,
    images?: ImageItem[],
    mentioned_agent_ids?: number[],
  ) => {
    if (!roomId) return;

    try {
      const messageData: {
        content: string;
        role: string;
        participant_type?: string;
        participant_name?: string;
        images?: ImageItem[];
        mentioned_agent_ids?: number[];
      } = {
        content,
        role: "user", // Required by MessageCreate schema
      };
      if (participant_type) {
        messageData.participant_type = participant_type;
      }
      if (participant_name) {
        messageData.participant_name = participant_name;
      }
      if (images && images.length > 0) {
        messageData.images = images;
      }
      if (mentioned_agent_ids && mentioned_agent_ids.length > 0) {
        messageData.mentioned_agent_ids = mentioned_agent_ids;
      }

      const response = await fetch(
        `${API_BASE_URL}/rooms/${roomId}/messages/send`,
        getFetchOptions({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(messageData),
        }),
      );

      if (response.ok) {
        // The new message will be picked up by SSE or the next poll
        // Cancel any pending immediate poll and schedule a new one
        if (immediatePollTimeoutRef.current) {
          clearTimeout(immediatePollTimeoutRef.current);
        }
        immediatePollTimeoutRef.current = setTimeout(() => {
          pollNewMessages();
          immediatePollTimeoutRef.current = null;
        }, 100);
      } else {
        console.error("Failed to send message:", response.statusText);
      }
    } catch (error) {
      console.error("Error sending message:", error);
    }
  };

  const resetMessages = useCallback(async () => {
    // Clear all messages and reset polling state
    setMessages([]);
    lastMessageIdRef.current = 0;

    // Cancel any pending immediate poll to prevent race conditions
    if (immediatePollTimeoutRef.current) {
      clearTimeout(immediatePollTimeoutRef.current);
      immediatePollTimeoutRef.current = null;
    }

    // Trigger immediate fetch to ensure we're in sync with backend
    // Wait for this to complete before allowing polling to continue
    await fetchAllMessages();
  }, [fetchAllMessages]);

  return { messages, sendMessage, isConnected, setMessages, resetMessages };
};
