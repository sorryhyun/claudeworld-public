import { z } from 'zod'

/**
 * A tool's declaration, separated from its implementation.
 *
 * Port of `sdk/tools/tool_definitions.py`. Python kept these apart because the
 * description and the response template are overridable per agent group via
 * `group_config.yaml`, while the handler is fixed — so the two halves have
 * different lifetimes and different owners.
 *
 * One thing is fixed that Python left loose: Python stored the fully-qualified
 * `mcp__server__tool` name in the definition *and* separately registered the
 * short name with the SDK, leaving the two to be kept in sync by hand. Here the
 * short name is the only name written down and the qualified form is derived
 * (`qualifiedToolName`), so they cannot drift.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Short name as the model sees it after the server prefix, e.g. `narration`. */
  name: string
  description: string
  /** Zod raw shape — the SDK's `tool()` takes the shape, not a wrapped object. */
  inputSchema: Shape
  /**
   * Template for the tool's success text, with `{placeholder}` slots.
   *
   * Group configs override this to change what an agent is told after a call —
   * the `recall` tool's `{memory_content}` override, for instance, makes an
   * agent's memories come back verbatim instead of summarized.
   */
  response?: string
  enabled?: boolean
  /**
   * The tool observes the world and never changes it.
   *
   * Surfaced to the CLI as `ToolAnnotations.readOnlyHint`, which is not
   * decoration: `isConcurrencySafe()` and `isReadOnly()` on the CLI's tool
   * wrapper both read it, and a tool that reports neither is executed on its
   * own. Marking the query tools lets a turn fetch the roster, the map and the
   * inventory in one parallel batch instead of three serial round trips.
   *
   * Not overridable from a group config, unlike {@link ToolDefinition.description}
   * and {@link ToolDefinition.response}: whether a handler writes is a property
   * of the code, and a world author who got it wrong would be telling the CLI
   * it may run a mutation concurrently with anything else.
   */
  readOnly?: boolean
}

/**
 * Trim, and reject a value that is only whitespace.
 *
 * Python enforced this with a `mode="before"` validator on every string field.
 * It matters because the model does occasionally emit `" "` for a required
 * field, and an empty memory entry — or an empty location name — would
 * otherwise be written to disk.
 *
 * Lifted here from `action.ts` when the other twenty-odd tool definitions
 * arrived: every one of them needs it, and two copies of the rule is one copy
 * too many.
 */
export const requiredText = (label: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, { message: `${label} cannot be empty` })

/**
 * A required string with a *minimum length* the model must actually clear.
 *
 * Python spells this `Field(..., min_length=200)` plus a validator that strips
 * first and measures after. Order is the whole point: a backstory padded with
 * newlines must not pass a 200-character floor, so the trim happens before the
 * measurement here too.
 */
export const requiredTextOfLength = (label: string, minChars: number, maxChars?: number) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length >= minChars, {
      message: `${label} must be at least ${minChars} characters`,
    })
    .refine((v) => maxChars === undefined || v.length <= maxChars, {
      message: `${label} must be at most ${maxChars} characters`,
    })

/** The name the model actually calls, as assembled by the SDK's MCP layer. */
export function qualifiedToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

/**
 * Fill `{placeholder}` slots, leaving unknown ones untouched.
 *
 * Tolerant by design: Python's `format_response` caught KeyError and returned
 * the raw template, because a group config carrying a placeholder the caller
 * does not supply should degrade to a slightly odd message rather than fail the
 * tool call mid-turn.
 */
export function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  )
}
