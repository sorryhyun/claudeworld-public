import { z } from 'zod'
import { requiredText, requiredTextOfLength, type ToolDefinition } from './definitions'

/**
 * Comprehensive character creation, used only by `detailed_character_designer`
 * during onboarding. The length floors on `appearance`, `personality` and
 * `backstory` are the whole difference from `persist_character_design`: they
 * stop the tool producing a one-line NPC where a history was asked for.
 */

/** One `## [subtitle]` section of a character's `consolidated_memory.md`. */
export const consolidatedMemorySchema = z.object({
  subtitle: requiredText('Subtitle').describe(
    "Memory subtitle (will be shown in index, e.g., 'childhood_trauma', '첫_만남')",
  ),
  content: requiredTextOfLength('Content', 10).describe(
    'Full memory content (narrative, feelings, reflections)',
  ),
})

export type ConsolidatedMemoryInput = z.infer<typeof consolidatedMemorySchema>

export const createComprehensiveCharacterTool = {
  name: 'create_comprehensive_character',
  description: `Create a comprehensive character with detailed backstory, personality, and initial memories.

This tool creates a fully-fledged character suitable for deep roleplay interactions.
Use this during onboarding when the user wants rich, memorable characters rather than simple NPCs.

**What it does:**
1. Creates character files (in_a_nutshell.md, characteristics.md) with backstory
2. Adds character to specified location
3. Prepares character for memory implantation (call implant_consolidated_memory next)

**When to use:**
- User explicitly requests "detailed character" or "comprehensive character"
- Creating main story NPCs with rich backgrounds
- Building characters that need depth and complexity

**After calling this tool:**
Call implant_consolidated_memory to populate the character's long-term memories.`,
  inputSchema: {
    name: requiredText('Name').describe("Character's name"),
    role: requiredText('Role').describe("Character's role (e.g., merchant, guard, sage)"),
    appearance: requiredTextOfLength('Appearance', 50).describe(
      'Detailed physical description (50+ chars)',
    ),
    personality: requiredTextOfLength('Personality', 100).describe(
      'Comprehensive personality description with traits, quirks, values (100+ chars)',
    ),
    backstory: requiredTextOfLength('Backstory', 200).describe(
      'Rich backstory narrative (200+ chars) - formative events, relationships, motivations',
    ),
    which_location: z
      .string()
      .default('current')
      .describe("Where to place: 'current' or location name"),
    secret: z
      .string()
      .nullable()
      .default(null)
      .describe('Hidden detail or motivation (optional but recommended)'),
    initial_disposition: z
      .string()
      .default('neutral')
      .describe('Initial attitude: friendly, neutral, wary, hostile'),
    initial_memories: z
      .array(consolidatedMemorySchema)
      .nullable()
      .default(null)
      .describe(
        'Initial consolidated memories (3-8 recommended) - will be implanted via separate tool',
      ),
  },
  response: '{creation_result}',
  enabled: true,
} satisfies ToolDefinition

export const implantConsolidatedMemoryTool = {
  name: 'implant_consolidated_memory',
  description: `Implant consolidated memories into a character's long-term memory file.

Populates consolidated_memory.md with formatted memories that the character can recall.
Each memory has a subtitle (shown in memory index) and content (full narrative).

**Format in consolidated_memory.md:**
\`\`\`markdown
## [memory_subtitle]
Memory content here...

## [another_memory]
More content...
\`\`\`

**Usage:**
- Call after create_comprehensive_character to add initial memories
- Can be called multiple times (append mode) to add more memories later
- Use overwrite mode to completely replace all memories

**Memory design tips:**
- 3-8 memories recommended for initial setup
- Subtitles should be memorable keywords (e.g., 'childhood_trauma', '스승의_가르침')
- Content should include narrative + emotional reflection
- Mix formative events, relationships, skills, and beliefs`,
  inputSchema: {
    character_name: requiredText('Character name').describe(
      'Character name (must match existing character in world)',
    ),
    memories: z
      .array(consolidatedMemorySchema)
      .min(1)
      .describe('List of consolidated memories to implant (each with subtitle and content)',),
    // An enum states the rule to the model up front, where a validator would
    // only state it after a failed call.
    mode: z
      .enum(['append', 'overwrite'])
      .default('append')
      .describe("Operation mode: 'append' (add to existing) or 'overwrite' (replace all)"),
  },
  response: '{implant_result}',
  enabled: true,
} satisfies ToolDefinition

export const CHARACTER_DESIGN_TOOLS = {
  create_comprehensive_character: createComprehensiveCharacterTool,
  implant_consolidated_memory: implantConsolidatedMemoryTool,
} satisfies Record<string, ToolDefinition>
