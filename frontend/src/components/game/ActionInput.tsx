import { useState, KeyboardEvent, useRef, useEffect, useMemo } from 'react';
import { useGame } from '../../contexts/GameContext';
import { Button } from '../ui/button';

interface SlashCommand {
  command: string;
  description: string;
  availableIn: 'chat' | 'gameplay' | 'both';
}

const SLASH_COMMANDS: SlashCommand[] = [
  { command: '/chat', description: 'Enter free-form NPC conversation mode', availableIn: 'gameplay' },
  { command: '/end', description: 'Exit chat mode and return to gameplay', availableIn: 'chat' },
];

interface ActionInputProps {
  placeholder?: string;
  disabled?: boolean;
}

export function ActionInput({ placeholder, disabled }: ActionInputProps) {
  const { submitAction, messages, phase, isChatMode } = useGame();
  const [input, setInput] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);

  // Check if Action_Manager, Narrator, or sub-agents are currently thinking (only in normal mode)
  // Sub-agents (Summarizer, World Seed Generator) have negative agent_ids (-1, -2)
  const chattingAgents = messages.filter(m => m.is_chatting);
  const isProcessing = phase === 'active' && !isChatMode && chattingAgents.some(
    m => m.agent_name === 'Action_Manager' || m.agent_name === 'Narrator' || (m.agent_id !== undefined && m.agent_id !== null && m.agent_id < 0)
  );

  // Check if NPCs are responding in chat mode
  const isChatModeProcessing = phase === 'active' && isChatMode && chattingAgents.length > 0;

  // Filter available commands based on current mode and input
  const availableCommands = useMemo(() => {
    const modeFilter = isChatMode ? 'chat' : 'gameplay';
    return SLASH_COMMANDS.filter(cmd =>
      cmd.availableIn === modeFilter || cmd.availableIn === 'both'
    );
  }, [isChatMode]);

  // Filter commands based on input (show all if just "/", or filter by prefix)
  const filteredCommands = useMemo(() => {
    if (!input.startsWith('/')) return [];
    const searchTerm = input.toLowerCase();
    return availableCommands.filter(cmd =>
      cmd.command.toLowerCase().startsWith(searchTerm)
    );
  }, [input, availableCommands]);

  const showCommandList = input.startsWith('/') && filteredCommands.length > 0;

  // Reset selected index when filtered commands change
  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [filteredCommands.length]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
    }
  }, [input]);

  const handleSubmit = async () => {
    if (!input.trim() || disabled) return;

    const action = input.trim();
    setInput('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await submitAction(action);
    } catch (error) {
      console.error('Failed to submit action:', error);
      // Restore input on error
      setInput(action);
    }
  };

  const selectCommand = (command: string) => {
    setInput(command);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle command list navigation
    if (showCommandList) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCommandIndex(prev =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCommandIndex(prev =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1
        );
        return;
      }
      // Tab or Enter to autocomplete
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        const selectedCommand = filteredCommands[selectedCommandIndex];
        if (selectedCommand) {
          selectCommand(selectedCommand.command);
        }
        return;
      }
      // Ctrl+Enter to submit (even if exact match)
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSubmit();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInput('');
        return;
      }
    }

    // Submit on Ctrl+Enter (or Cmd+Enter on Mac)
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="space-y-2">
      {/* Chat mode indicator */}
      {isChatMode && (
        <div className="flex items-center justify-between py-2 px-4 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-lg">
          <span className="text-sm font-medium text-white">
            Chat Mode - Talk freely with NPCs. Type /end to return to gameplay.
          </span>
          {isChatModeProcessing && (
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          )}
        </div>
      )}

      {/* Clauding indicator (normal gameplay mode) */}
      {isProcessing && (
        <div className="flex items-center justify-center gap-2 py-2 px-4 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg">
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="text-sm font-medium text-white">clauding...</span>
        </div>
      )}

      {/* Input field with command autocomplete */}
      <div className="relative">
        {/* Slash command dropdown */}
        {showCommandList && (
          <div
            ref={commandListRef}
            className="absolute bottom-full left-0 right-12 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden z-10"
          >
            {filteredCommands.map((cmd, index) => (
              <button
                key={cmd.command}
                type="button"
                onClick={() => selectCommand(cmd.command)}
                onMouseEnter={() => setSelectedCommandIndex(index)}
                className={`w-full px-4 py-2.5 text-left flex items-center gap-3 transition-colors ${
                  index === selectedCommandIndex
                    ? 'bg-slate-100'
                    : 'hover:bg-slate-50'
                }`}
              >
                <span className="font-mono text-sm font-semibold text-slate-700">
                  {cmd.command}
                </span>
                <span className="text-sm text-slate-500">
                  {cmd.description}
                </span>
              </button>
            ))}
            <div className="px-4 py-1.5 bg-slate-50 border-t border-slate-100 text-xs text-slate-400">
              ↑↓ navigate • Tab to complete • Ctrl+Enter to send • Esc to cancel
            </div>
          </div>
        )}

        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isChatMode ? 'Say something... (Ctrl+Enter)' : (placeholder || 'Enter your action... (Ctrl+Enter)')}
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-slate-300 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500 disabled:bg-slate-100 disabled:cursor-not-allowed text-sm sm:text-base min-h-[44px] transition-all"
          />
          <Button
            onClick={handleSubmit}
            disabled={disabled || !input.trim()}
            className="px-4 h-[44px] bg-slate-700 hover:bg-slate-600 disabled:bg-slate-300"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </Button>
        </div>
      </div>
    </div>
  );
}
