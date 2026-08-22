# SDK Modernization Plan: adopting current Agent SDK patterns in `backend`

**Status:** in progress. §1, §3 and sequencing step 1 landed 2026-08-22. §3 was decided
**no-go** on its own stated blocker and closed with its fallback branch instead; §2 (the
runtime-mutation spikes) is still not started, and §4–§7 are untouched.
**Scope:** `backend/src/sdk/` and its integration points (`orchestration/turn.ts`,
`room-orchestrator.ts`, `http/state.ts`). No REST-contract or schema changes.
**Baseline:** `@anthropic-ai/claude-agent-sdk` pinned at `0.3.238` (bundling
Claude Code CLI 2.1.238). The `sdk/` layer was ported from Python against the early-0.3
surface and hand-builds several things the SDK now provides natively.

The production code uses exactly one runtime symbol from the SDK — `query()` — plus types.
Everything else (persistent sessions, pooling, MCP serving, tool definition, partial-input
decoding, interrupt choreography) is hand-rolled, each piece with a documented reason.
This plan maps each mechanism to the current SDK affordance, ordered by value, and gates
the risky ones behind spikes — because several of those "old patterns" encode real
discovered CLI behavior, and the docs describing the new affordances have not been
verified against a live session here.

---

## Ground rules

1. **Spike first, migrate second.** ✅ **Done.** `src/scripts/spike-session.ts` is now the
   living SDK-behavior harness, run with `bun run spike` from `backend/`. It probes the
   pin, streaming-input sessions, MCP tools across turns, hook firing, the *name* of the
   sub-agent dispatch tool, the real `Options.agents` definitions driving a `Task` →
   persist round-trip, and `outputFormat` → `structured_output`. It costs real tokens and
   needs Claude Code auth, so it is deliberately outside `bun test`. Run it on every SDK
   bump; it earned its keep immediately (see **Findings** below).
2. **Pin the SDK exactly** ✅ **Done** — `backend/package.json` now reads
   `"@anthropic-ai/claude-agent-sdk": "0.3.238"`, no caret, and the spike's `pin` probe
   fails if the declared version regains a range or drifts from what is installed. Three
   separate places document behavior keyed to "a binary this repository does not pin": the
   undocumented `MCP_SDK_GENERATION` / `MCP_PROTOCOL_NEGOTIATION` gates (`env.ts:29-42`),
   the protocol-era refusal (`endpoint.ts:218-226`), and the stream parser's duck-typing
   (`stream-parser.ts:56-65`). Pin + a spike run per bump is a better safety story than
   tolerance-by-duck-typing.
3. **Each item lands with tests**, and `bun run pilot` + `bun run smoke` are the
   integration gates.

---

## Findings from the first live spike run (2026-08-22)

Two production bugs the harness surfaced on its first run, both invisible without it:

- **The sub-agent dispatch tool is called `Agent`, not `Task`.** CLI 2.1.238's
  `sdk-tools.d.ts` declares `AgentInput` (carrying `subagent_type`, `run_in_background`)
  and no `TaskInput` at all. `hooks.ts` matched `'Task'`, so `subagent_invoked` was never
  emitted and every `subagent_completed` reported `subagentType: 'unknown'`. Nothing
  failed — the telemetry simply read as "sub-agents are not being used". Both names are
  now matched (`SUBAGENT_DISPATCH_TOOLS` in `hooks.ts`, which `options-builder.ts`'s
  `NATIVE_TOOLS` derives from, so the allow-list and the hook cannot name different
  tools), and the spike prints which one actually fires.
- **`SubagentStop` pairs on `agent_id`, not the dispatch's `tool_use_id`.** They are
  different ids. Durations never matched. `SubagentStart` (which carries `agent_id` +
  `agent_type`) is now registered and keys the timings; `SubagentStop` carries
  `agent_type` outright, so a lost pairing costs the duration and not the identity. The
  pilot went from `[subagent] unknown 0ms` to `[subagent] location_designer 24860ms`.

## 1. Close the functional gaps first (these are bugs, not modernization) ✅ done

### 1.1 Populate `Options.agents` — sub-agent definitions were never ported ✅

The single largest finding. Every agent gets `Task`/`TaskOutput` in its tool set
(`options-builder.ts:46`), built-in agents are disabled
(`CLAUDE_CODE_DISABLE_BUILTIN_AGENTS=true`, `env.ts:25`), `settingSources: []` blocks
filesystem agent discovery — and **no production caller ever sets `Options.agents`**.
`Task` has nothing to dispatch to. Python builds these from
`backend/sdk/agent/task_subagent_definitions.py` in the retired Python tree; the TypeScript backend has no equivalent. The
sub-agent identities exist on disk (`agents/group_subagent/*/`) and the parent-side
callback tools (`mcp__subagents__persist_*`) are fully implemented — only the
`AgentDefinition` construction is missing.

**Landed as:**

- `sdk/agent/subagent-definitions.ts` — loads `agents/group_subagent/{name}/` configs into
  `AgentDefinition { description, prompt, tools: ['mcp__subagents__persist_*'], model: 'inherit' }`,
  mirroring Python's builder heading for heading, with the same mtime-keyed hot reload
  `yaml-config.ts` uses. `detailed_character_designer` keeps Python's behaviour: no persist
  tool, so `tools` is omitted (inherit the parent's) and the prompt asks for prose.
- `turn.ts` derives **one** `ServerRole` and passes it to both `mcp.bindTurn` and
  `buildSubagentDefinitionsForRole`, so the tool set and the sub-agent set cannot disagree.
- `optionsFingerprint` now hashes agent-definition **content**, not just keys — otherwise a
  sub-agent prompt edit never invalidates a warm session.
- **New, not in the original plan:** `buildSubagentDefinitionsForRole` takes the turn's
  qualified tool list and drops any designer whose persist tool this turn does not serve.
  `buildToolSets` gates each persist tool on an optional `ServerDeps` entry, so a caller
  wired without `items` serves no `persist_item`; an `item_designer` restricted to it would
  be dispatched with a tool that does not exist and its design discarded as prose. The
  pilot's reduced `ServerDeps` is exactly that case, and is what exposed it.
- Telemetry hooks verified — and found broken; see **Findings** above.

**Gates, both run live:** `bun run spike` is green, and `bun run pilot` gained a third turn
that drives `location_designer` → `mcp__subagents__persist_location_design` over the
*stateless HTTP endpoint* (the half the in-process spike cannot show) and asserts the
location row landed. The pilot also now shares one deps object across its turns; turn two
had been handed a copy without `onTelemetry`, so tool and sub-agent telemetry silently
stopped after turn one.

### 1.2 Wire `outputFormat` (structured outputs) — ⚠️ premise did not hold

The plan assumed the onboarding world-seed path parses JSON out of prose. **It does not,
in either backend.** The World Seed Generator was merged into the Onboarding Manager
(`tape/gameplay-tape.ts`, `trpg_generator.py:193`), and the seed is written through the
`draft_world` / `persist_world` / `complete` tools — already structured, already validated
by Zod. There is no "reply in JSON" instruction anywhere in `backend/src/` or
`config/*.yaml`, and no hand parsing to replace. Forcing
`outputFormat: json_schema` onto the Onboarding Manager would be a regression, not an
adoption: it is a *conversational* agent whose prose is shown to the player (the onboarding
tape is the one tape that is not hidden).

The plumbing is real and correct (`AgentOptionsInput` → `Options` → `stream-parser` →
`TurnEvent.structuredOutput`), so it is kept and now has a live spike probe asserting
`outputFormat` → `structured_output` end to end. Adopt it when a genuinely
single-shot, machine-read agent appears — a summarizer or a classifier, not an interview.

---

## 2. Runtime session mutation — shrink the fingerprint (spike-gated)

`Options` are baked in at `query()` time; `optionsFingerprint` + pool eviction is the
workaround, and it forces a full CLI respawn for changes as small as a model flip. The
current `Query` object exposes mid-session mutation:

| Method | Replaces |
|---|---|
| `setModel(model)` | eviction on `USE_SONNET` flip / model change |
| `setMcpServers(servers)` / `toggleMcpServer` / `reconnectMcpServer` | eviction on MCP-config change (incl. the ephemeral-port-changed-on-restart case) |
| `setPermissionMode(mode)` | n/a today, keeps the option open |
| `applyFlagSettings(settings)` | n/a today |

**Spike:** on a warm streaming-input session with ≥2 turns: does `setMcpServers` between
turns actually rebind for the next turn? Does `setModel` apply cleanly mid-session with
`resume` semantics intact? If yes, `SessionPool.isReusable` mutates-on-acquire instead of
evicting for model and MCP-server drift, and the fingerprint shrinks to
`systemPrompt + tools + agents + outputFormat`. The fingerprint does **not** disappear —
the system prompt is still immutable per session, and per-turn config re-parse
(`turn.ts:862-864`) means prompt edits must keep evicting.

### 2.1 Re-verify `streamInput()`

`session.ts:23-26` has a hard "never call `Query.streamInput()` — it ends the CLI's
stdin" rule, discovered in early 0.3.x. Current docs present `streamInput(stream)` as the
supported way to push additional messages into a running query. **Spike:** three turns via
`streamInput` on one subprocess, session id stable, MCP tools callable each turn, late
sub-agent `tools/call` still serviced. If the behavior changed, `input-channel.ts` (the
hand-rolled push generator) and the `as any` prompt cast at `session.ts:107` can go. The
background pump stays regardless — late sub-agent tool calls still need the stream
drained between turns. If behavior is unchanged, keep the current pattern; it costs
nothing.

### 2.2 `startup()` / `WarmQuery` pre-warm

The first turn in a room pays CLI spawn + initialize. `startup()` pre-warms a subprocess
before any prompt exists. Candidate: `SessionPool` pre-warms on room open or world load.
**Spike first:** verify `WarmQuery` composes with streaming-input mode and `resume` —
if it only supports the one-shot prompt form, skip this item.

---

## 3. MCP transport: in-process — **no-go**, decided 2026-08-22 ✅

The proposal was to delete `sdk/mcp/` (~440 lines of loopback `Bun.serve`, bearer
auth, DNS-rebind checks, JSON-RPC error shaping, protocol-era gating) and go back to
in-process servers, now that `TurnRegistry` has made per-turn state external to the
handlers and the stale-closure failure mode no longer applies to the current design.

**The first blocker held, and it is the one the section said to stop on.** There is no
in-process path that does not put MCP v1 shapes back in the tool layer, because
`Options.mcpServers` accepts an in-process server only as `{ type: 'sdk', instance }`,
and `instance` is typed as v1's `McpServer`. Both spellings were compiled against the
pinned SDK:

```
createSdkMcpServer({ tools: ourGameTools })
  TS2322: Type 'SdkTool[]' is not assignable to type 'SdkMcpToolDefinition<any>[]'.
    … Two different types with this name exist, but they are unrelated.
      Types of property 'structuredContent' are incompatible.
        Type 'unknown' is not assignable to type '{ [x: string]: unknown; } | undefined'.

{ type: 'sdk', name, instance: ourV2McpServer }
  TS2739: Type 'McpServer' is missing the following properties from type
    'McpServer': experimental, handleAutomaticTaskPolling, resource, tool, prompt
```

`structuredContent` is the exact incompatibility `handlers/context.ts:6-18` dropped the
SDK's `tool()` helper to escape. `@anthropic-ai/claude-agent-sdk@0.3.238` still declares
`@modelcontextprotocol/sdk: ^1.29.0` as a peer (Bun auto-installs 1.30.0 to satisfy it),
and it vendors that v1 implementation into `sdk.mjs` — `createSdkMcpServer` builds a
bundled v1 `McpServer` and `Query.connectSdkMcpServer` calls `instance.connect(transport)`
on it. Going in-process therefore means either casting at the boundary and type-checking
every handler's return against the wrong `CallToolResult`, or standardizing the tool
layer back on v1 while the endpoint, the client and the tests stay on v2.

The other two blockers were not reached, but neither would have changed the answer:
late sub-agent `tools/call` already works in-process (the spike's `subagents` probe), and
`_meta` passes through `createSdkMcpServer` unchanged.

**Decision: keep the HTTP endpoint.** Revisit only if the SDK's peer dependency moves to
`@modelcontextprotocol/server` v2, which is the single fact that made this a no-go.

### 3.1 What was adopted instead — the cheap wins on the current transport ✅

Both were verified against CLI 2.1.238's own code before being written, because
adopting an option the CLI ignores is worse than not adopting it.

- **`instructions` per namespace.** `SERVER_INSTRUCTIONS` in `handlers/servers.ts`,
  served on `server/discover` by `mcp/endpoint.ts`. The CLI assigns
  `this._instructions = discover.instructions` on the modern-era connect path and
  renders every connected server's into one `# MCP Server Instructions` block of the
  model's context. That makes it the home for guidance that spans a namespace — call
  ordering, gather-before-you-narrate, "prose is not a result" for the sub-agent
  callbacks — which until now had to be repeated inside individual tool descriptions or
  left unsaid. It is **not** per-agent: one string serves every character bound to the
  namespace, so anything that varies by agent stays in the tool description.
- **`ToolAnnotations.readOnlyHint`** on the seven query tools (`recall`,
  `recall_history`, `list_inventory`, `list_world_item`, `list_locations`,
  `list_characters`, `read_lore_guidelines`). Not cosmetic, which is what the original
  plan assumed: the CLI's tool wrapper reads it as
  `isConcurrencySafe(){return I.annotations?.readOnlyHint ?? false}`, so **an unannotated
  tool is always executed alone**. Every tool this backend serves was unannotated, so a
  turn that wanted the roster, the map and the inventory paid three serial round trips.
  Declared as `readOnly` on `ToolDefinition` next to the description, and stamped in one
  pass in `buildToolSets` — the same shape as `applyDisabledTools`, so the fact lives
  with the declaration and cannot be forgotten at the twenty-first `tool()` call site.
  Deliberately not overridable from `group_config.yaml`: whether a handler writes is a
  property of the code, and a world author who got it wrong would be telling the CLI it
  may run a mutation concurrently with anything else.

`destructiveHint` is left unset everywhere. It defaults to true for an unannotated tool,
which is the honest default for a surface that deletes characters and rewrites player
state, so saying so adds nothing.

**Gates:** `bun run lint`, `bun run typecheck` and the full suite are green (1583 tests).
`mcp-endpoint.test.ts` asserts both over the wire with a real MCP v2 client —
`server/discover` carries the instructions, and `tools/list` marks `recall` while leaving
`memorize` and `skip` alone. `tool-definitions.test.ts` pins the read-only set as a list,
because the failure mode is silent and one-directional. `bun run smoke` passes, and a
live `bun run pilot` run is **PHASE 0 PASS** — three real turns against the real CLI over
the stateless endpoint, including the `location_designer` dispatch →
`persist_location_design` round trip, so the new `subagents` instructions and the
annotated `tools/list` were both on the wire. A new `instructions` probe in
`bun run spike` checks the CLI-side rendering live; **that one has not been run** — it
needs Claude Code auth and real tokens, and nothing else in this change does.

**Found while running the pilot, unrelated and not fixed here:** the run ends with
`Bun.serve() timed out a request after 10 seconds. Pass idleTimeout to configure.` The
endpoint's `Bun.serve` sets no `idleTimeout`, so it takes Bun's 10-second default, while
the SDK documents MCP tool calls as "effectively unbounded by default"
(`MCP_TOOL_TIMEOUT`). Any tool call or held-open stream that goes quiet for ten seconds
is dropped by the transport rather than by the protocol. Pre-existing — nothing in this
change touches request duration — and worth its own item.

## 4. Observability & control (low risk, adopt opportunistically)

- **`getContextUsage()`** → drive history compression from real context pressure instead
  of fixed 100–120-message windows (`turn.ts:927-950`) and batch-of-3 summarization
  (`history-compression-service.ts`).
- **`stopTask(taskId)`** → `interruptRoom` today cannot reach a running sub-agent; the
  `PreToolUse:Task` hook already captures `tool_use_id`s (`hooks.ts:120-142`). Wire task
  ids into the interrupt path.
- **`agentProgressSummaries` + `SDKTaskProgressMessage`**, optionally
  **`forwardSubagentText`** → surface Action-Manager sub-agent progress in the UI. Today
  sub-agent activity is visible only as a boolean via `setSubAgentActive` callbacks.
- **`maxBudgetUsd` / `taskBudget`** → per-turn cost ceiling. A runaway Action-Manager
  turn currently has no bound except the 120s idle deadline.
- **Hook events**: consider `SessionEnd`/`Stop` for telemetry symmetry. Keep hooks
  observation-only (`hooks.ts:3-13`) — permission gating stays "omit the tool from the
  set", not `canUseTool`.

---

## 5. Session persistence hygiene

- **`resume` must keep the CLI-side transcript**, so `persistSession` stays `true`. But
  adopt **`sessionStore`** to control *where* transcripts live — required for the packaged
  exe (Phase 5) so sessions land in the app data dir, not `~/.claude` keyed off an empty
  temp cwd.
- **`resumeDropsTurn`** → cleaner retry-after-interrupt: an interrupted turn's partial
  exchange currently stays in the CLI transcript forever.
- **`listSessions` / `getSessionMessages`** → a debug endpoint; also lets
  `deleteRoomAgentSessions` (which today only forgets the id, leaving the CLI
  conversation intact — `crud/sessions.ts:50-58`) actually clean up.
- **`forkSession`** → enabler for future "clone room/world" features; note it, don't
  build it.

---

## 6. Packaging (folds into migration Phase 5)

`extractFromBunfs()` + `pathToClaudeCodeExecutable` for `bun build --compile` — already
in the migration plan's gotchas table; the current docs confirm the import-with-
`{ type: "file" }` shape. Combine with `sessionStore` (§5) and the `FRONTEND_DIST`
static serving already done.

---

## 7. Narration as `append` / `finalize` tools (streaming redesign; post-cutover)

Proposed 2026-08-22. Today `narration` is one tool call carrying the whole narrative
(`sdk/tools/gameplay.ts:208`, handler in `handlers/narrative-tools.ts:46-67`), and the
streaming UX comes from hand-decoding that call's `input_json_delta` fragments
(`NarrationStreamExtractor`, 165 lines) behind the
`CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` gate — an undocumented env flag on an
unpinned binary. Restructure instead:

- **`append_narration({ text })`** — appends to a per-turn buffer on the `TurnBinding`
  and pushes the chunk to the UI through a new `onNarrationDelta(roomId, delta)` callback
  on `NarrativeDeps` (same inversion pattern as `onNarrationProduced`, so `sdk/` still
  never imports orchestration).
- **`finalize_narration({ text? })`** — persists the buffer as one message (NPC reactions
  in the `thinking` column, exactly what the handler does today) and fires
  `onNarrationProduced` to reopen player input.
- **Safety nets (non-negotiable):** auto-finalize at `stream_end` when the buffer is
  non-empty and `finalize_narration` was never called; on interrupt, persist the partial
  buffer — today an interrupt mid-`narration` loses the text entirely, because the
  handler never runs.

**Wins:** deletes the extractor and the fine-grained-streaming env gate; streaming
becomes plain tool calls, identical over the HTTP endpoint or a future in-process server
(§3) and immune to CLI version drift; partial narration is durable server-side; and the
model can open the scene *before* mechanics finish resolving — today the tool description
mandates "call this AFTER resolving mechanics", so the player sees nothing through NPC
reactions + interpretation + `change_stat`/`travel`. With append, first visible text
arrives much earlier in a long Action-Manager turn.

**Costs:** granularity drops from token-level typing to paragraph bursts, each appearing
only after the model finishes generating that chunk plus a tool round-trip — acceptable
for a reading-paced TRPG, and the SSE contract does not change (deltas just get bigger;
a frontend typewriter animation over each chunk recovers the feel). Each chunk is a full
tool round-trip, so turn latency and token overhead rise with chunk count. The
append→finalize discipline lands on the prompt, but the degenerate cases are harmless:
one giant append ≈ today's behavior, a forgotten finalize is covered by auto-finalize.

**Sequencing constraint (the reason this is post-cutover):** it forks the tool surface
from the frozen Python backend — `append_narration`/`finalize_narration` have no Python
counterpart, and the registry and `group_config.yaml` address tools by name. Do it after
the Phase-4 parity harness has served its purpose, or explicitly exclude the narration
tools from the parity diff. Until then the extractor stays (see the bullet below).

---

## What NOT to change — still-correct load-bearing patterns

Verified against current docs; these survive the modernization:

- **Manual `stream.next()` + background pump** (`session.ts:17-33`) — generator
  semantics haven't changed; `for await` + `break` still tears down the session, and late
  sub-agent tool calls still need the stream drained between turns.
- **Interrupt-before-abort ordering** (`room-orchestrator.ts:28-45`).
- **`{...process.env}` spread in `env`** — the TS SDK still *replaces* the subprocess
  environment.
- **`settingSources: []`**, **`bypassPermissions` + `allowDangerouslySkipPermissions`**,
  **`thinking: { type: 'adaptive', display: 'summarized' }`** — all still the right
  embedded-use configuration.
- **`Task`/`TaskOutput` in `NATIVE_TOOLS`** — `Task` is kept alongside `Agent` because an
  unknown name in `tools` is inert while a missing one is a dispatch the model cannot make.
- **`NarrationStreamExtractor`** — the SDK still exposes raw `input_json_delta`
  fragments only; there is no accumulated-partial-tool-input API. The hand decoder stays
  until §7 replaces the mechanism at the app level, post-cutover.
- **The parent-harness env scrub** (`env.ts:71-84`) — nested execution still needs it.

---

## Sequencing

| Step | Item | Effort | Gate |
|---|---|---|---|
| 1 | ✅ Pin SDK exactly; revive `spike-session.ts` as the SDK-behavior harness | done | spike green |
| 2 | ✅ §1.1 sub-agent definitions (`Options.agents`) | done | pilot drives a real dispatch → `persist_location_design` round-trip |
| 3 | ✅ §1.2 `outputFormat` — premise did not hold; plumbing kept and spike-covered | done | — |
| 4 | §2 spikes (`setMcpServers`/`setModel`, `streamInput`, `startup`) | 1 day | adopt only what the spike proves |
| 5 | §4 observability items, as adjacent code is touched | incremental | — |
| 6 | ✅ §3 in-process-MCP go/no-go — **no-go** on the v2 `CallToolResult` blocker; adopted `instructions` + `readOnlyHint` instead | done | lint/typecheck/1583 tests + `smoke` + a live `pilot` run green |
| 7 | §5–6 fold into migration Phases 4–5 | with those phases | — |
| 8 | §7 append/finalize narration | 1–2 days | **post-cutover** — forks the tool surface from Python (parity) |
