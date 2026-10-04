import { invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function sendClaudeMessage(messages: ChatMessage[]): Promise<string> {
  return invoke("send_claude_message", { messages });
}
