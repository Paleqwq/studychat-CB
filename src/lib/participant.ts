import type { Conversation } from "./types";

// Explicit allowlist: experimental configuration IDs and private columns stay on the server.
export function participantConversation(c: Conversation): Conversation {
  return { id: c.id, participant_code: c.participant_code, title: c.title, created_at: c.created_at,
    updated_at: c.updated_at, request_count: c.request_count, locked_until: c.locked_until };
}
