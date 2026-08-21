import "../test/setup";
import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  mock,
} from "bun:test";

// usePolling composes useSSE, which POSTs for a stream ticket and opens an
// EventSource. Neither belongs in a polling test: the ticket request races the
// message fetch for the queued fetch mocks. Stub it as permanently
// disconnected so only the polling paths are exercised.
const SSE_DISCONNECTED = {
  isConnected: false,
  streamingAgents: new Map(),
  lastNewMessage: null,
  newMessageSeq: 0,
};
mock.module("./useSSE", () => ({
  useSSE: () => SSE_DISCONNECTED,
}));

const { renderHook, waitFor } = await import("@testing-library/react");
const { setApiKey } = await import("../services/apiClient");
const { usePolling } = await import("./usePolling");

// Suppress console errors in tests
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = mock();
});

afterAll(() => {
  console.error = originalConsoleError;
  setApiKey(null);
});

describe("usePolling", () => {
  beforeEach(() => {
    // A fresh mock per test - queued `mockResolvedValueOnce` responses must not
    // leak across tests.
    globalThis.fetch = mock() as unknown as typeof fetch;
    setApiKey("test-api-key");
  });

  const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof mock>;

  it("should initialize with empty messages and disconnected state", () => {
    const { result } = renderHook(() => usePolling(null));

    expect(result.current.messages).toEqual([]);
    expect(result.current.isConnected).toBe(false);
  });

  it("should fetch all messages on initial load when roomId is provided", async () => {
    const mockMessages = [
      { id: 1, content: "Hello", role: "user", timestamp: "2024-01-01" },
      { id: 2, content: "Hi", role: "assistant", timestamp: "2024-01-02" },
    ];

    fetchMock().mockResolvedValue({
      ok: true,
      json: async () => mockMessages,
    });

    renderHook(() => usePolling(1));

    await waitFor(() => {
      expect(fetchMock()).toHaveBeenCalledWith(
        expect.stringContaining("/rooms/1/messages"),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-API-Key": "test-api-key",
            "ngrok-skip-browser-warning": "true",
          }),
        }),
      );
    });
  });

  it("should set isConnected to true on successful message fetch", async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const { result } = renderHook(() => usePolling(1));

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });
  });

  it("should set isConnected to false on failed message fetch", async () => {
    fetchMock().mockResolvedValue({
      ok: false,
      statusText: "Not Found",
    });

    const { result } = renderHook(() => usePolling(1));

    await waitFor(() => {
      expect(result.current.isConnected).toBe(false);
    });
  });

  it("should handle network errors gracefully", async () => {
    fetchMock().mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => usePolling(1));

    await waitFor(() => {
      expect(result.current.isConnected).toBe(false);
    });
  });

  it("should send message with correct headers and body", async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const { result } = renderHook(() => usePolling(1));

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    result.current.sendMessage("Test message");

    await waitFor(() => {
      const sendCall = fetchMock().mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("/messages/send"),
      );
      expect(sendCall).toBeDefined();
      expect(sendCall![1]).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-API-Key": "test-api-key",
        }),
      });
      expect(JSON.parse((sendCall![1] as RequestInit).body as string)).toMatchObject({
        content: "Test message",
        role: "user",
      });
    });
  });

  it("should send message with optional parameters", async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const { result } = renderHook(() => usePolling(1));

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    result.current.sendMessage("Test", "character", "CharacterName", [
      { data: "base64data", media_type: "image/png" },
    ]);

    await waitFor(() => {
      const sendCall = fetchMock().mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("/messages/send"),
      );
      expect(sendCall).toBeDefined();
      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        content: "Test",
        role: "user",
        participant_type: "character",
        participant_name: "CharacterName",
        images: [{ data: "base64data", media_type: "image/png" }],
      });
    });
  });

  it("should reset messages on resetMessages call", async () => {
    const initialMessages = [
      { id: 1, content: "Hello", role: "user", timestamp: "2024-01-01" },
    ];

    fetchMock().mockResolvedValueOnce({
      ok: true,
      json: async () => initialMessages,
    });

    // Ongoing polling and the post-reset refetch both come back empty.
    fetchMock().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const { result } = renderHook(() => usePolling(1));

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });

    await result.current.resetMessages();

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(0);
    });
  });

  it("should clear messages when roomId changes", async () => {
    const room1Messages = [
      { id: 1, content: "Room 1", role: "user", timestamp: "2024-01-01" },
    ];
    const room2Messages = [
      { id: 2, content: "Room 2", role: "user", timestamp: "2024-01-02" },
    ];

    // First room fetch
    fetchMock().mockResolvedValueOnce({
      ok: true,
      json: async () => room1Messages,
    });

    // Ongoing polling for room 1
    fetchMock().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const { result, rerender } = renderHook(
      ({ roomId }) => usePolling(roomId),
      {
        initialProps: { roomId: 1 },
      },
    );

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe("Room 1");
    });

    // Second room fetch
    fetchMock().mockResolvedValueOnce({
      ok: true,
      json: async () => room2Messages,
    });

    rerender({ roomId: 2 });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe("Room 2");
    });
  });

  it("should not make API calls when roomId is null", () => {
    renderHook(() => usePolling(null));

    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("should expose setMessages for external updates", async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const { result } = renderHook(() => usePolling(1));

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    const newMessages = [
      {
        id: 3,
        content: "External",
        role: "user" as const,
        timestamp: "2024-01-03",
        agent_id: null,
      },
    ];

    result.current.setMessages((prev) => [...prev, ...newMessages]);

    await waitFor(() => {
      expect(result.current.messages).toContainEqual(newMessages[0]);
    });
  });
});
