# agents/CLAUDE.md

Agent definitions. These are **data, not code**: markdown and YAML read at runtime,
hot-reloaded on mtime, and edited by users. Nothing here is compiled or imported.

The loaders that read this tree live in `backend/src/sdk/loaders/` and
`backend/src/sdk/parsing/`; the tools agents may call are declared in
`backend/src/sdk/tools/`. See [`../backend/CLAUDE.md`](../backend/CLAUDE.md).

## Layout

```
agents/
├── group_config.yaml.example      Annotated reference for group overrides
├── group_gameplay/                System agents driving the game
│   ├── group_config.yaml
│   ├── Onboarding_Manager/        Player interview → world seed → phase transition
│   ├── Action_Manager/            Main gameplay orchestrator
│   ├── Chat_Summarizer/           Invoked directly by the app, not via dispatch
│   └── History_Summarizer/
├── group_subagent/                Designers invoked on demand by the above
│   ├── group_config.yaml
│   ├── Character_Designer/        persist_character_design
│   ├── detailed_character_designer/  create_comprehensive_character
│   ├── Item_Designer/             persist_item
│   └── Location_Designer/         persist_location_design
└── <agent_name>/                  Ordinary chat/NPC agents, ungrouped
```

An agent folder:

```
agents/<agent_name>/
├── in_a_nutshell.md         Brief identity summary          (required)
├── characteristics.md       Personality traits              (required)
├── recent_events.md         Auto-updated from platform conversations
├── consolidated_memory.md   Long-term memories, `## subtitle` sections (optional)
└── profile.png              Optional (png/jpg/jpeg/gif/webp/svg)
```

`recent_events.md` is written by the platform from conversation history. It is **not** a
place for character backstory — backstory belongs in `characteristics.md` or
`consolidated_memory.md`.

**Profile pictures:** any of `profile.*`, `avatar.*`, `picture.*`, `photo.*`. Changes apply
immediately. The route serving them is unauthenticated (an `<img src>` cannot send a
header), which is why agent-name validation in `backend/src/http/routes/agents/profile-pic.ts`
is a security control.

## Third-person perspective — not optional

Agent configuration files must be written in **third person**:

- ✅ "Dr. Chen is a seasoned data scientist…" / "프리렌은 엘프 마법사로…"
- ❌ "You are Dr. Chen…" / "당신은 엘프 마법사로…"

The Claude Agent SDK inherits an immutable "You are Claude Code" system prompt. A
second-person description adds a conflicting "You are…" statement and the agent's identity
becomes unstable. Third person reads as description *about* a character instead, which
composes cleanly.

See [`../docs/how_it_works.md`](../docs/how_it_works.md#why-third-person-perspective).

## Memory system

Memory retrieval is **on demand**, through the `recall` tool:

- Only memory *subtitles* are injected into context, inside `<long_term_memory_index>`
- The agent decides when and which memories to fetch, and calls `recall`
- Full content is loaded only on request, which is what keeps the baseline token cost down

**File:** `consolidated_memory.md`. **Format:** sections under `## [subtitle]` headers.
Parsing lives in `backend/src/sdk/parsing/memory.ts`.

## Group configuration

A `group_<name>/group_config.yaml` applies to every agent in that folder. It carries two
kinds of setting.

**Behaviour, group-wide:**

```yaml
interrupt_every_turn: true    # answer every user message, ahead of the ordinary round
priority: 5                   # ordering within the round
transparent: true             # responses are internal, not shown to the player
can_see_system_messages: true
```

**Tool availability**, group-wide and then per agent — per-agent lists *extend* the group
lists rather than replacing them:

```yaml
disabled_tools:
  - memorize
  - recall
  - skip

agents:
  Action_Manager:
    enabled_tool_groups: [action_manager, subagent]
    enabled_tools: [get_game_state, travel, narration, suggest_options, …]
```

**Tool response/description overrides:**

```yaml
tools:
  recall:
    response: "{memory_content}"   # return memories verbatim
  skip:
    response: "This character chooses to remain silent."
```

`agents/group_config.yaml.example` is the annotated reference. Loading is
`backend/src/sdk/loaders/group-config.ts`.

**`readOnlyHint` cannot be overridden from here, deliberately.** It is a scheduling flag the
CLI reads as "safe to run concurrently", not documentation — see the tool section of
[`../backend/CLAUDE.md`](../backend/CLAUDE.md).

**A sub-agent definition naming a tool the turn does not serve gets *no* tools at all**, with
no diagnostic. If a designer suddenly does nothing, check that its `persist_*` tool is
actually attached to a server for that turn.

## Common tasks

- **Create an agent:** add a folder with `in_a_nutshell.md` and `characteristics.md` in third
  person. New folders are picked up on restart.
- **Update an agent:** edit the `.md` files. Changes apply on the agent's next response —
  no restart, no cache to clear.
- **Update a system agent:** edit `group_gameplay/<name>/` or `group_subagent/<name>/`.
- **Debug:** set `DEBUG_AGENTS=true` in `.env` for verbose agent logging.

The system prompt itself is not here — it is the `system_prompt` field of
`config/guidelines_3rd.yaml`.
