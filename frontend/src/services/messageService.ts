import type { Message } from "../types";
import { API_BASE_URL, getFetchOptions } from "./apiClient";

export interface SendMessageData {
  content: string;
  role: "user" | "assistant";
  participant_type?: string;
  participant_name?: string;
  image_data?: string;
  image_media_type?: string;
  mentioned_agent_ids?: number[];
}

export const messageService = {
  async getMessages(roomId: number): Promise<Message[]> {
    const response = await fetch(
      `${API_BASE_URL}/rooms/${roomId}/messages`,
      getFetchOptions(),
    );
    if (!response.ok) throw new Error("Failed to fetch messages");
    return response.json();
  },

  async sendMessage(roomId: number, data: SendMessageData): Promise<Message> {
    const response = await fetch(
      `${API_BASE_URL}/rooms/${roomId}/messages/send`,
      getFetchOptions({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    );
    if (!response.ok) throw new Error("Failed to send message");
    return response.json();
  },

  async clearRoomMessages(roomId: number): Promise<void> {
    const response = await fetch(
      `${API_BASE_URL}/rooms/${roomId}/messages`,
      getFetchOptions({
        method: "DELETE",
      }),
    );
    if (!response.ok) throw new Error("Failed to clear messages");
    return response.json();
  },
};
