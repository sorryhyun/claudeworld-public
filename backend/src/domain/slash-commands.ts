// Chat-mode slash commands: `/chat` drops the player into free-form conversation
// with the NPCs at their location, `/end` leaves it and hands the transcript to
// the Chat Summarizer. Everything else goes to the Action Manager.

export const SLASH_COMMAND_TYPES = ['chat', 'end', 'none'] as const

export type SlashCommandType = (typeof SLASH_COMMAND_TYPES)[number]

export interface ParsedCommand {
  commandType: SlashCommandType
  /** Always `null` today; present so an argument-taking command can be added. */
  args: string | null
}

// The match is **exact** on the trimmed, lowercased text, not a prefix test:
// `/chatter with the innkeeper` is an ordinary action, and a `startsWith` here
// would swallow it into chat mode.
export function parseSlashCommand(actionText: string): ParsedCommand {
  const text = actionText.trim().toLowerCase()

  if (text === '/chat') return { commandType: 'chat', args: null }
  if (text === '/end') return { commandType: 'end', args: null }

  return { commandType: 'none', args: null }
}
