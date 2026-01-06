# SDK Module

Claude Agent SDK integration layer for managing AI agent lifecycle, MCP tools, and response generation.

## Directory Structure

```
sdk/
├── __init__.py          # Module exports
│
├── config/              # Tool definitions and system prompt (hot-reloaded)
│   ├── tool_definitions.py          # Base ToolDefinition dataclass
│   ├── action_tool_definitions.py   # Action tools (skip, memorize, recall)
│   ├── guideline_tool_definitions.py # Guidelines tool definition
│   ├── gameplay_tool_definitions.py  # TRPG gameplay tools (travel, narration, etc.)
│   ├── onboarding_tool_definitions.py # Onboarding tools (draft_world, persist_world, complete)
│   ├── subagent_tool_definitions.py  # Sub-agent persist tools
│   ├── guidelines_3rd.yaml           # System prompt template
│   ├── conversation_context.yaml     # Context formatting
│   └── localization.yaml             # Localized messages (en, ko)
│
├── loaders/             # Configuration loaders
│   ├── tools.py         # Tool config loading with group overrides
│   ├── guidelines.py    # System prompt loading
│   ├── yaml_loaders.py  # YAML parsing utilities
│   ├── cache.py         # Loader caching
│   └── validation.py    # Config validation
│
├── agent/               # High-level orchestration
│   ├── agent_manager.py           # Response generation, client lifecycle
│   ├── task_subagent_definitions.py # AgentDefinition builders for Task tool sub-agents
│   ├── hooks.py                   # SDK hook factory functions
│   ├── options_builder.py         # ClaudeAgentOptions builder
│   └── streaming_state.py         # StreamingStateManager for partial responses
│
├── client/              # Claude SDK client infrastructure
│   ├── client_pool.py   # Claude SDK client pooling
│   ├── mcp_registry.py  # MCP server registry (tool routing per agent)
│   └── stream_parser.py # Response stream parsing
│
├── tools/               # MCP tool implementations
│   ├── action_tools.py       # skip, memorize, recall
│   ├── guidelines_tools.py   # guidelines reader
│   ├── common.py             # Shared tool utilities
│   ├── context.py            # ToolContext for tool handlers
│   ├── errors.py             # Tool-specific exceptions
│   └── gameplay_tools/       # TRPG gameplay and onboarding tools
│       ├── character_tools.py   # remove_character, move_character, list_characters, persist_character_design
│       ├── location_tools.py    # travel, list_locations, persist_location_design
│       ├── mechanics_tools.py   # inject_memory, change_stat
│       ├── narrative_tools.py   # narration, suggest_options
│       ├── item_tools.py        # persist_item
│       ├── equipment_tools.py   # Equipment handling
│       ├── history_tools.py     # History compression
│       ├── onboarding_tools.py  # draft_world, persist_world, complete (world initialization)
│       └── common.py            # Shared gameplay utilities
│
└── parsing/             # Parsing utilities
    ├── agent_parser.py    # Parse agent config from markdown files
    ├── location_parser.py # Parse location info from Task prompts
    └── memory_parser.py   # Parse long-term memory files with subtitles
```

## Key Components

### AgentManager (`agent/agent_manager.py`)

Orchestrates agent response generation:
- Manages Claude SDK client lifecycle via `ClientPool`
- Parses streaming responses via `StreamParser`
- Handles client interruption for cancellation
- Configures MCP servers through `MCPRegistry`
- Tracks partial responses via `StreamingStateManager`

```python
from sdk import AgentManager

manager = AgentManager()
async for chunk in manager.generate_sdk_response(context):
    yield chunk  # Streaming events (content_delta, thinking_delta, stream_end)
```

### Agent Module Components

| Component | Purpose |
|-----------|---------|
| `agent_manager.py` | Core response generation and client lifecycle |
| `hooks.py` | SDK hook factories (prompt tracking, subagent handling, tool capture) |
| `options_builder.py` | Builds `ClaudeAgentOptions` with MCP config and hooks |
| `streaming_state.py` | Thread-safe tracking of partial responses during streaming |
| `task_subagent_definitions.py` | `AgentDefinition` builders for Task tool sub-agents |

### MCPRegistry (`client/mcp_registry.py`)

Central hub for tool management. Determines which tools each agent receives based on:
- Agent's group configuration (`group_config.yaml`)
- Default tool groups (guidelines, action)
- Phase-specific tools (onboarding, gameplay)

```python
from sdk.client.mcp_registry import get_mcp_registry

registry = get_mcp_registry()
config = registry.build_mcp_config(agent_context)
# Returns: MCPServerConfig(mcp_servers, allowed_tool_names, enabled_groups)
```

### Sub-Agent Invocation (`agent/task_subagent_definitions.py`)

Sub-agents are invoked via the Task tool pattern (SDK native):
- `item_designer`: Create new item templates with balanced stats and lore
- `character_designer`: Create new NPCs
- `location_designer`: Create new locations
- `chat_summarizer`: Summarize chat conversations

Sub-agents use persist tools (`persist_item`, `persist_character_design`, etc.)
to save their results directly to filesystem and database.

Note: `change_stat` is used directly by Action Manager (not via a sub-agent).
Note: Onboarding_Manager handles world generation via `draft_world` and `persist_world` tools.

### Parsing Utilities (`parsing/`)

| Module | Purpose |
|--------|---------|
| `agent_parser.py` | Parse agent config from markdown folder structure |
| `location_parser.py` | Extract location info from location_designer Task prompts |
| `memory_parser.py` | Parse long-term memory files with `## [subtitle]` format |

```python
from sdk.parsing import parse_agent_config, parse_location_from_task_prompt, parse_long_term_memory

# Parse agent config
config = parse_agent_config("/path/to/agent/folder")

# Parse location from Task prompt
location_info = parse_location_from_task_prompt("Create 연남동 골목길 (Yeonnam-dong Alley), ...")
# Returns: {"name": "yeonnam_dong_alley", "display_name": "연남동 골목길 (Yeonnam-dong Alley)", ...}

# Parse memory file
memories = parse_long_term_memory(Path("agent/consolidated_memory.md"))
# Returns: {"subtitle1": "content1", "subtitle2": "content2", ...}
```

### Tool Groups

Tools are organized into groups configured in YAML files:

| Group | Tools | When Enabled |
|-------|-------|--------------|
| `action` | skip, memorize, recall | Always |
| `guidelines` | guidelines | Always |
| `onboarding` | complete | Onboarding phase |
| `action_manager` | travel, narration, suggest_options, remove_character, move_character, inject_memory, list_locations, list_characters, persist_* | Action Manager and sub-agents |

## Adding New Tools

1. **Define tool in Python** (`config/gameplay_tool_definitions.py`):
   ```python
   from .tool_definitions import ToolDefinition

   MY_TOOL = ToolDefinition(
       name="my_tool",
       description="What the tool does",
       group="action_manager",  # Tool group for filtering
       input_schema={
           "type": "object",
           "properties": {
               "param1": {
                   "type": "string",
                   "description": "Parameter description"
               }
           },
           "required": ["param1"]
       }
   )

   # Add to ALL_GAMEPLAY_TOOLS list
   ```

2. **Implement handler** in appropriate tools module:
   ```python
   # sdk/tools/gameplay_tools/my_tools.py
   async def handle_my_tool(param1: str, context: ToolContext) -> str:
       # Implementation
       return "Tool result"
   ```

3. **Register in MCP server** (`sdk/tools/gameplay_tools/__init__.py`):
   ```python
   @mcp_server.tool()
   async def my_tool(param1: str) -> str:
       return await handle_my_tool(param1, context)
   ```

4. **Enable for agents** via `group_config.yaml`:
   ```yaml
   enabled_tool_groups:
     - action_manager  # Enables all tools in this group
   ```

## Configuration

### Tool Overrides (`group_config.yaml`)

Groups can customize tool behavior:

```yaml
# agents/group_example/group_config.yaml
tools:
  recall:
    response: "{memory_content}"  # Return verbatim, no AI rephrasing
  skip:
    response: "This character remains silent."
```

### Debug Logging

Enable via environment variable:
```bash
DEBUG_AGENTS=true
```

This logs:
- System prompts
- Tool configurations
- Messages sent to agents
- Agent responses
