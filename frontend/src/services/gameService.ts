import { API_BASE_URL, getFetchOptions } from "./apiClient";
import type {
  World,
  Location,
  PlayerState,
  GameMessage,
} from "../contexts/GameContext";

const API_BASE = `${API_BASE_URL}/worlds`;

// =============================================================================
// WORLD MANAGEMENT
// =============================================================================

export async function createWorld(
  name: string,
  userName?: string,
  language: string = "ko",
): Promise<World> {
  const body: { name: string; user_name?: string; language: string } = {
    name,
    language,
  };
  if (userName) {
    body.user_name = userName;
  }
  const response = await fetch(API_BASE, {
    ...getFetchOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Failed to create world" }));
    throw new Error(error.detail || "Failed to create world");
  }
  return response.json();
}

export async function listWorlds(): Promise<World[]> {
  const response = await fetch(API_BASE, getFetchOptions());
  if (!response.ok) {
    throw new Error("Failed to list worlds");
  }
  return response.json();
}

export async function getWorld(worldId: number): Promise<World> {
  const response = await fetch(`${API_BASE}/${worldId}`, getFetchOptions());
  if (!response.ok) {
    throw new Error("Failed to get world");
  }
  return response.json();
}

export async function deleteWorld(worldId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/${worldId}`, {
    ...getFetchOptions({ method: "DELETE" }),
  });
  if (!response.ok) {
    throw new Error("Failed to delete world");
  }
}

export interface ResetWorldResponse {
  success: boolean;
  message: string;
  world_id: number;
  starting_location: string;
}

export async function resetWorld(worldId: number): Promise<ResetWorldResponse> {
  const response = await fetch(`${API_BASE}/${worldId}/reset`, {
    ...getFetchOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    }),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Failed to reset world" }));
    throw new Error(error.detail || "Failed to reset world");
  }
  return response.json();
}

export interface ImportableWorld {
  name: string;
  owner_id: string | null;
  user_name: string | null;
  language: "en" | "ko" | "jp";
  phase: "onboarding" | "active" | "ended";
  genre: string | null;
  theme: string | null;
  created_at: string | null;
}

export async function listImportableWorlds(): Promise<ImportableWorld[]> {
  const response = await fetch(`${API_BASE}/importable`, getFetchOptions());
  if (!response.ok) {
    throw new Error("Failed to list importable worlds");
  }
  return response.json();
}

export async function importWorld(worldName: string): Promise<World> {
  const response = await fetch(
    `${API_BASE}/import/${encodeURIComponent(worldName)}`,
    {
      ...getFetchOptions({ method: "POST" }),
    },
  );
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Failed to import world" }));
    throw new Error(error.detail || "Failed to import world");
  }
  return response.json();
}

export interface EnterWorldResponse {
  world: World;
  arrival_message_sent: boolean;
}

export async function startOnboarding(
  worldId: number,
): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/${worldId}/start-onboarding`, {
    ...getFetchOptions({ method: "POST" }),
  });
  if (!response.ok) {
    throw new Error("Failed to start onboarding");
  }
  return response.json();
}

export async function enterWorld(worldId: number): Promise<EnterWorldResponse> {
  const response = await fetch(`${API_BASE}/${worldId}/enter`, {
    ...getFetchOptions({ method: "POST" }),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Failed to enter world" }));
    throw new Error(error.detail || "Failed to enter world");
  }
  return response.json();
}

// =============================================================================
// PLAYER ACTIONS
// =============================================================================

export async function submitAction(
  worldId: number,
  actionText: string,
  imageData?: string,
  imageMediaType?: string,
): Promise<{ status: string }> {
  const body: { text: string; image_data?: string; image_media_type?: string } =
    { text: actionText };
  if (imageData && imageMediaType) {
    body.image_data = imageData;
    body.image_media_type = imageMediaType;
  }
  const response = await fetch(`${API_BASE}/${worldId}/action`, {
    ...getFetchOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Failed to submit action" }));
    throw new Error(error.detail || "Failed to submit action");
  }
  return response.json();
}

export async function getActionSuggestions(worldId: number): Promise<string[]> {
  try {
    const response = await fetch(
      `${API_BASE}/${worldId}/action/suggestions`,
      getFetchOptions(),
    );
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return data.suggestions || [];
  } catch {
    return [];
  }
}

// =============================================================================
// LOCATIONS
// =============================================================================

export async function getLocations(worldId: number): Promise<Location[]> {
  const response = await fetch(
    `${API_BASE}/${worldId}/locations`,
    getFetchOptions(),
  );
  if (!response.ok) {
    throw new Error("Failed to get locations");
  }
  return response.json();
}

export async function getCurrentLocation(worldId: number): Promise<Location> {
  const response = await fetch(
    `${API_BASE}/${worldId}/locations/current`,
    getFetchOptions(),
  );
  if (!response.ok) {
    throw new Error("Failed to get current location");
  }
  return response.json();
}

export async function travelToLocation(
  worldId: number,
  locationId: number,
): Promise<{ status: string }> {
  const response = await fetch(
    `${API_BASE}/${worldId}/locations/${locationId}/travel`,
    {
      ...getFetchOptions({ method: "POST" }),
    },
  );
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Failed to travel" }));
    throw new Error(error.detail || "Failed to travel to location");
  }
  return response.json();
}

export async function updateLocationLabel(
  worldId: number,
  locationId: number,
  label: string,
): Promise<Location> {
  const response = await fetch(
    `${API_BASE}/${worldId}/locations/${locationId}`,
    {
      ...getFetchOptions({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      }),
    },
  );
  if (!response.ok) {
    throw new Error("Failed to update location label");
  }
  return response.json();
}

export async function getLocationMessages(
  worldId: number,
  locationId: number,
  limit: number = 50,
): Promise<GameMessage[]> {
  const response = await fetch(
    `${API_BASE}/${worldId}/locations/${locationId}/messages?limit=${limit}`,
    getFetchOptions(),
  );
  if (!response.ok) {
    throw new Error("Failed to get location messages");
  }
  const data = await response.json();
  return data.messages || [];
}

// =============================================================================
// GAME STATE
// =============================================================================

export async function getPlayerState(worldId: number): Promise<PlayerState> {
  const response = await fetch(
    `${API_BASE}/${worldId}/state`,
    getFetchOptions(),
  );
  if (!response.ok) {
    throw new Error("Failed to get player state");
  }
  return response.json();
}

export async function getStats(worldId: number): Promise<{
  definitions: Array<{
    name: string;
    display: string;
    min: number;
    max: number | null;
  }>;
  current: Record<string, number>;
}> {
  const response = await fetch(
    `${API_BASE}/${worldId}/state/stats`,
    getFetchOptions(),
  );
  if (!response.ok) {
    throw new Error("Failed to get stats");
  }
  return response.json();
}

export async function getInventory(worldId: number): Promise<{
  items: Array<{
    id: string;
    name: string;
    description: string | null;
    quantity: number;
    properties: Record<string, unknown> | null;
  }>;
  count: number;
}> {
  const response = await fetch(
    `${API_BASE}/${worldId}/state/inventory`,
    getFetchOptions(),
  );
  if (!response.ok) {
    throw new Error("Failed to get inventory");
  }
  return response.json();
}

export async function getWorldItems(worldId: number): Promise<{
  items: Array<{
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
  }>;
  count: number;
}> {
  const response = await fetch(
    `${API_BASE}/${worldId}/items`,
    getFetchOptions(),
  );
  if (!response.ok) {
    throw new Error("Failed to get world items");
  }
  return response.json();
}

// =============================================================================
// POLLING
// =============================================================================

export interface PollResponse {
  messages: GameMessage[];
  state: {
    stats: Record<string, number>;
    inventory_count: number;
    turn_count: number;
    phase: "onboarding" | "active" | "ended";
    pending_phase: "active" | null; // Set by complete tool, triggers "Enter World" button
    is_chat_mode: boolean;
    chat_mode_start_message_id: number | null;
    game_time?: { hour: number; minute: number; day: number } | null;
  } | null;
  location: {
    id: number;
    name: string;
  } | null;
  suggestions: string[];
}

export async function pollUpdates(
  worldId: number,
  sinceMessageId: number | null,
  pollOnboarding: boolean = false,
): Promise<PollResponse> {
  const params = new URLSearchParams();
  if (sinceMessageId !== null) {
    params.set("since_message_id", String(sinceMessageId));
  }
  if (pollOnboarding) {
    params.set("poll_onboarding", "true");
  }

  const url = `${API_BASE}/${worldId}/poll${params.toString() ? `?${params}` : ""}`;
  const response = await fetch(url, getFetchOptions());
  if (!response.ok) {
    throw new Error("Failed to poll updates");
  }
  return response.json();
}

export interface ChattingAgent {
  id: number;
  name: string;
  profile_pic: string | null;
  thinking_text: string;
  response_text: string;
  has_narrated?: boolean; // For Action_Manager: true when narration tool has been called
}

export async function getChattingAgents(
  worldId: number,
  pollOnboarding: boolean = false,
): Promise<ChattingAgent[]> {
  const params = pollOnboarding ? "?poll_onboarding=true" : "";
  const response = await fetch(
    `${API_BASE}/${worldId}/chatting-agents${params}`,
    getFetchOptions(),
  );
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return data.chatting_agents || [];
}

export interface WorldCharacter {
  id: number;
  name: string;
  profile_pic: string | null;
  in_a_nutshell: string | null;
  location_id: number;
  location_name: string;
}

export async function getWorldCharacters(
  worldId: number,
): Promise<WorldCharacter[]> {
  const response = await fetch(
    `${API_BASE}/${worldId}/characters`,
    getFetchOptions(),
  );
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return data.characters || [];
}

export async function getWorldHistory(worldId: number): Promise<string> {
  const response = await fetch(
    `${API_BASE}/${worldId}/history`,
    getFetchOptions(),
  );
  if (!response.ok) {
    return "";
  }
  const data = await response.json();
  return data.history || "";
}

export interface CompressHistoryResult {
  success: boolean;
  turns_compressed: number;
  sections_created: number;
  message: string;
}

export async function compressWorldHistory(
  worldId: number,
): Promise<CompressHistoryResult> {
  const response = await fetch(`${API_BASE}/${worldId}/history/compress`, {
    ...getFetchOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Failed to compress history" }));
    throw new Error(error.detail || "Failed to compress history");
  }
  return response.json();
}
