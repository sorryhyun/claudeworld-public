/**
 * Chat-mode slash commands. Port of
 * `backend/domain/value_objects/slash_commands.py`.
 *
 * `/chat` drops the player into free-form conversation with the NPCs at their
 * location; `/end` leaves it and hands the transcript to the Chat Summarizer.
 * Everything else is a normal action and goes to the Action Manager.
 */

/**
 * Python's `SlashCommandType` is a bare `Enum`, not a `str, Enum` — it is only
 * ever compared, never serialised — so nothing depends on these exact strings
 * crossing a wire. They are kept anyway so a log line reads the same.
 */
export const SLASH_COMMAND_TYPES = ['chat', 'end', 'none'] as const

export type SlashCommandType = (typeof SLASH_COMMAND_TYPES)[number]

export interface ParsedCommand {
  commandType: SlashCommandType
  /**
   * Always `null` today. Python declares `args: Optional[str] = None` and
   * never populates it; the field is kept so adding an argument-taking command
   * does not change every call site's shape.
   */
  args: string | null
}

/**
 * Classify a line of player input.
 *
 * The match is **exact** on the trimmed, lowercased text — not a prefix test.
 * `/chatter with the innkeeper` is an ordinary action and must reach the
 * Action Manager; a `startsWith` here would silently swallow it into chat mode
 * instead. That is the whole reason this function exists rather than being
 * inlined as a comparison.
 */
export function parseSlashCommand(actionText: string): ParsedCommand {
  const text = actionText.trim().toLowerCase()

  if (text === '/chat') return { commandType: 'chat', args: null }
  if (text === '/end') return { commandType: 'end', args: null }

  return { commandType: 'none', args: null }
}
