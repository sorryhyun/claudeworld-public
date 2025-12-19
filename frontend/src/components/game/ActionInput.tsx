import { useState, KeyboardEvent, useRef, useEffect, useMemo, ClipboardEvent, DragEvent, ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useGame } from '../../contexts/GameContext';
import { Button } from '../ui/button';
import { LoadingDots } from '../shared/LoadingDots';
import { cn } from '@/lib/utils';

interface ImageData {
  data: string;  // Base64 encoded (without data URL prefix)
  mediaType: string;  // MIME type
  preview: string;  // Full data URL for preview
}

// Allowed image types
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB max

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
  const { t } = useTranslation();
  const { submitAction, messages, phase, isChatMode } = useGame();
  const [input, setInput] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [attachedImage, setAttachedImage] = useState<ImageData | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Convert file to base64
  const fileToBase64 = (file: File): Promise<ImageData> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64Data = result.split(',')[1];
        resolve({
          data: base64Data,
          mediaType: file.type,
          preview: result,
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // Handle file selection
  const handleFileSelect = async (file: File) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      alert('Please select a valid image file (PNG, JPEG, GIF, or WebP)');
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      alert('Image size must be less than 10MB');
      return;
    }
    try {
      const imageData = await fileToBase64(file);
      setAttachedImage(imageData);
    } catch (error) {
      console.error('Error converting image:', error);
      alert('Failed to process image');
    }
  };

  // Handle file input change
  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
    e.target.value = '';
  };

  // Handle drag events
  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      handleFileSelect(file);
    }
  };

  // Handle paste from clipboard (Ctrl+V)
  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          handleFileSelect(file);
        }
        return;
      }
    }
  };

  // Remove attached image
  const removeImage = () => {
    setAttachedImage(null);
  };

  // Memoize processing state calculations to avoid filtering on every render
  const { isProcessing, isChatModeProcessing } = useMemo(() => {
    // Check if Action_Manager or sub-agents are currently thinking (only in normal mode)
    // Sub-agents (Summarizer, World Seed Generator) have negative agent_ids (-1, -2)
    const chattingAgents = messages.filter(m => m.is_chatting);
    const processing = phase === 'active' && !isChatMode && chattingAgents.some(
      m => m.agent_name === 'Action_Manager' || (m.agent_id !== undefined && m.agent_id !== null && m.agent_id < 0)
    );
    // Check if NPCs are responding in chat mode
    const chatModeProcessing = phase === 'active' && isChatMode && chattingAgents.length > 0;

    return { isProcessing: processing, isChatModeProcessing: chatModeProcessing };
  }, [messages, phase, isChatMode]);

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
    if ((!input.trim() && !attachedImage) || disabled) return;

    const action = input.trim();
    const imageData = attachedImage?.data;
    const imageMediaType = attachedImage?.mediaType;

    setInput('');
    setAttachedImage(null);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await submitAction(action, imageData, imageMediaType);
    } catch (error) {
      console.error('Failed to submit action:', error);
      // Restore input on error
      setInput(action);
      if (imageData && imageMediaType) {
        setAttachedImage({ data: imageData, mediaType: imageMediaType, preview: `data:${imageMediaType};base64,${imageData}` });
      }
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
    <div
      className={cn("space-y-2 relative", isDragging && "bg-blue-50 rounded-lg")}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-blue-100/80 backdrop-blur-sm flex items-center justify-center z-30 pointer-events-none rounded-lg">
          <div className="text-blue-600 font-medium flex items-center gap-2">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Drop image here
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Chat mode indicator */}
      {isChatMode && (
        <div
          className="flex items-center justify-between py-2 px-4 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-lg"
          role="status"
          aria-live="polite"
        >
          <span className="text-sm font-medium text-white">
            {t('game.chatModeIndicator')}
          </span>
          {isChatModeProcessing && (
            <LoadingDots size="sm" color="white" />
          )}
        </div>
      )}

      {/* Clauding indicator (normal gameplay mode) */}
      {isProcessing && (
        <div
          className="flex items-center justify-center gap-2 py-2 px-4 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg"
          role="status"
          aria-live="polite"
        >
          <LoadingDots size="sm" color="white" />
          <span className="text-sm font-medium text-white">{t('game.clauding')}</span>
        </div>
      )}

      {/* Image Preview */}
      {attachedImage && (
        <div className="relative inline-block">
          <img
            src={attachedImage.preview}
            alt="Attached"
            className="max-h-32 max-w-xs rounded-lg border border-slate-200 shadow-sm"
          />
          <button
            type="button"
            onClick={removeImage}
            className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 transition-colors shadow-md"
            title="Remove image"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
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
              {t('game.commandHelp')}
            </div>
          </div>
        )}

        <div className="flex gap-2 items-end">
          {/* Attach Image Button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="flex-shrink-0 w-[44px] h-[44px] rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center hover:bg-slate-200 transition-all disabled:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed"
            title="Attach image (or paste with Ctrl+V)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isChatMode ? 'Say something... (Ctrl+Enter)' : (placeholder || 'Enter your action... (Ctrl+Enter)')}
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-slate-300 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500 disabled:bg-slate-100 disabled:cursor-not-allowed text-sm sm:text-base min-h-[44px] transition-all"
          />
          <Button
            onClick={handleSubmit}
            disabled={disabled || (!input.trim() && !attachedImage)}
            className="px-4 h-[44px] bg-slate-700 hover:bg-slate-600 disabled:bg-slate-300"
            aria-label={t('accessibility.sendAction')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </Button>
        </div>
      </div>
    </div>
  );
}
