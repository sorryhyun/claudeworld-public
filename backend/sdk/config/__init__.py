"""SDK configuration files - Python and YAML configs for tools, guidelines, and debug settings.

Python Tool Definition Modules (consolidated input models + descriptions):
- tool_definitions.py: Base ToolDefinition dataclass
- action_tool_definitions.py: Action tools (skip, memorize, recall)
- guideline_tool_definitions.py: Guideline tools (read, anthropic)
- gameplay_tool_definitions.py: Action Manager tools (narration, travel, etc.)
- onboarding_tool_definitions.py: Onboarding tools (draft_world, persist_world, complete)
- subagent_tool_definitions.py: Sub-agent persist tools

YAML Configuration Files:
- guidelines_3rd.yaml: System prompt and behavioral guidelines
- conversation_context.yaml: Conversation history formatting
- localization.yaml: Localized message templates
"""
