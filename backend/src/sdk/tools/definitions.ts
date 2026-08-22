import { z } from 'zod'

/**
 * A tool's declaration, separate from its implementation: description and
 * response template are overridable per agent group, the handler is not.
 * `mcp__server__tool` is derived from the short name here.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Short name, as the model sees it after the server prefix. */
  name: string
  description: string
  /** Raw shape, not a wrapped object. */
  inputSchema: Shape
  /** Success text with `{placeholder}` slots; overridable per agent group. */
  response?: string
  enabled?: boolean
  /**
   * The tool observes the world and never changes it. Surfaced as
   * `readOnlyHint`, which the CLI reads as `isConcurrencySafe()`; not
   * overridable from a group config, where a wrong value would let the CLI run
   * a mutation concurrently with anything else.
   */
  readOnly?: boolean
}

// Rejects whitespace-only: the model does emit `" "` for a required field, and
// an empty memory entry would otherwise reach disk.
export const requiredText = (label: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, { message: `${label} cannot be empty` })

// Trims *before* measuring, so newline padding does not clear the floor.
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

export function qualifiedToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

// Unknown slots are left untouched: a group config naming a placeholder the
// caller omits degrades to an odd message rather than failing the call.
export function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  )
}
