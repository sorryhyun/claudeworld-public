import { requiredText, type ToolDefinition } from './definitions'

/**
 * The tools every character has. Port of `sdk/tools/action.py`.
 *
 * Descriptions carry `{agent_name}` and `{memory_subtitles}` slots filled in
 * when the server is built for a specific agent, so each character is told about
 * its own memories by name.
 */

export const skipTool = {
  name: 'skip',
  description:
    "Skip this turn when {agent_name} has left the scene or the message doesn't warrant " +
    "{agent_name}'s engagement. Others will continue without you.",
  inputSchema: {},
  response: 'You have decided to skip this message. You will not respond.',
  enabled: true,
} satisfies ToolDefinition

export const memorizeTool = {
  name: 'memorize',
  description:
    "Record significant events as one-liners when 'TodoWrite' reminder is triggered. " +
    'Format: "Event description - emotional core"',
  inputSchema: {
    memory_entry: requiredText('Memory entry').describe(
      'A brief one-liner summary (e.g., "Met the merchant - felt suspicious")',
    ),
  },
  response:
    'Memory recorded: {memory_entry}\n\nThis event has been added to your memory for future reference.',
  enabled: true,
} satisfies ToolDefinition

export const recallTool = {
  name: 'recall',
  description:
    "Retrieve a detailed memory entry by subtitle from {agent_name}'s long-term memories. " +
    'Use this when {agent_name} is reacting to a past event, relationship, or promise ' +
    'and needs concrete details (and their current feelings about it) to respond in-character.\n' +
    'Available memories: {memory_subtitles}',
  inputSchema: {
    subtitle: requiredText('Subtitle').describe('The subtitle of the memory to recall'),
  },
  // The whole memory, verbatim. A group config can narrow this.
  response: '{memory_content}',
  enabled: true,
} satisfies ToolDefinition

export const ACTION_TOOLS = {
  skip: skipTool,
  memorize: memorizeTool,
  recall: recallTool,
} satisfies Record<string, ToolDefinition>
