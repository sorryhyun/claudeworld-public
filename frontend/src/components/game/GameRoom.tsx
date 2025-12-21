import { useRef, useEffect, memo, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import type { Components } from 'react-markdown';
import { useGame, GameMessage } from '../../contexts/GameContext';

// Memoized ReactMarkdown components to prevent object recreation on every render
const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed whitespace-pre-wrap">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-slate-300 pl-4 italic text-slate-700 my-3">
      {children}
    </blockquote>
  ),
  h1: ({ children }) => <h1 className="text-xl font-bold mb-2 mt-4 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h3>,
  hr: () => <hr className="my-4 border-slate-200" />,
  code: ({ children }) => (
    <code className="bg-slate-200 text-slate-800 px-1.5 py-0.5 rounded text-sm font-mono">
      {children}
    </code>
  ),
};
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ActionInput } from './ActionInput';
import { SuggestedActions } from './SuggestedActions';
import { ImageAttachment } from '../chat-room/message-list/ImageAttachment';
import { TurnIndicator } from './TurnIndicator';
import { MobileGameStateSheet } from './MobileGameStateSheet';

// Helper to get only the latest turn (last user message + subsequent assistant responses)
function getLatestTurn(messages: GameMessage[]): GameMessage[] {
  if (messages.length === 0) return [];

  // Find the last user message index
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  // If no user message found, return all messages (initial state)
  if (lastUserIndex === -1) return messages;

  // Return from the last user message to the end
  return messages.slice(lastUserIndex);
}

// Helper to parse timestamp ensuring UTC is handled correctly
const parseTimestamp = (timestamp: string): Date => {
  // Ensure timestamp is treated as UTC if no timezone info present
  let isoString = timestamp;
  if (!timestamp.endsWith('Z') && !timestamp.includes('+') && !/T\d{2}:\d{2}:\d{2}.*-/.test(timestamp)) {
    isoString = timestamp + 'Z';
  }
  return new Date(isoString);
};

// Thinking indicator component (shown above streaming message)
const ThinkingIndicator = memo(({
  agentName,
  thinkingText
}: {
  agentName: string;
  thinkingText: string | null;
}) => (
  <div className="px-4 py-2 bg-slate-50/50 border-b border-slate-100">
    <div className="max-w-3xl mx-auto flex items-center gap-3 text-sm text-slate-600">
      <div className="animate-spin h-4 w-4 border-2 border-slate-300 border-t-indigo-600 rounded-full" />
      <span className="font-medium text-indigo-600">{agentName}</span>
      <span className="text-xs text-slate-400 truncate">
        {thinkingText || 'Generating...'}
      </span>
    </div>
  </div>
));

ThinkingIndicator.displayName = 'ThinkingIndicator';

// Message row component for game messages
const GameMessageRow = memo(({
  message,
  isExpanded,
  onToggleThinking
}: {
  message: GameMessage;
  isExpanded: boolean;
  onToggleThinking: (id: number) => void;
}) => {
  const isUser = message.role === 'user';
  const isChatting = message.is_chatting;
  const hasContent = message.content && message.content.trim().length > 0;

  // For chatting/processing messages with no content yet, show only the thinking indicator
  if (isChatting && !hasContent) {
    return (
      <ThinkingIndicator
        agentName={message.agent_name || 'Narrator'}
        thinkingText={message.thinking}
      />
    );
  }

  // For chatting messages WITH content, render in the same style as completed messages
  // but with a thinking indicator above
  if (isChatting && hasContent) {
    return (
      <>
        <ThinkingIndicator
          agentName={message.agent_name || 'Narrator'}
          thinkingText={message.thinking}
        />
        <div className="px-4 py-3 bg-white">
          <div className="max-w-3xl mx-auto">
            {/* Role label - same as completed */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
                {message.agent_name || 'Narrator'}
              </span>
            </div>

            {/* Message content - same styling as completed */}
            <div className="prose prose-slate prose-sm max-w-none text-slate-800">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={MARKDOWN_COMPONENTS}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className={`px-4 py-3 ${isUser ? 'bg-slate-50' : 'bg-white'}`}>
      <div className="max-w-3xl mx-auto">
        {/* Role label */}
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs font-semibold uppercase tracking-wider ${
            isUser ? 'text-slate-500' : 'text-indigo-600'
          }`}>
            {isUser ? 'You' : (message.agent_name || 'Narrator')}
          </span>
          {message.timestamp && (
            <span className="text-xs text-slate-400">
              {parseTimestamp(message.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
          )}
        </div>

        {/* Thinking section (for AI messages) */}
        {message.thinking && (
          <div className="mb-2">
            <button
              onClick={() => onToggleThinking(message.id)}
              className="text-xs text-slate-600 hover:text-slate-800 flex items-center gap-1 transition-colors"
              aria-expanded={isExpanded}
              aria-controls={`thinking-${message.id}`}
            >
              <svg
                className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Show thinking
            </button>
            {isExpanded && (
              <div
                id={`thinking-${message.id}`}
                className="mt-2 p-3 bg-slate-100 rounded-lg text-xs text-slate-700 italic whitespace-pre-wrap border border-slate-200"
              >
                {message.thinking}
              </div>
            )}
          </div>
        )}

        {/* Image attachment */}
        {message.image_data && message.image_media_type && (
          <div className="mb-2">
            <ImageAttachment
              imageData={message.image_data}
              imageMediaType={message.image_media_type}
              isUserMessage={isUser}
            />
          </div>
        )}

        {/* Message content */}
        <div className={`prose prose-slate prose-sm max-w-none ${
          isUser ? 'text-slate-700' : 'text-slate-800'
        }`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={MARKDOWN_COMPONENTS}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
});

GameMessageRow.displayName = 'GameMessageRow';

export function GameRoom() {
  const { t } = useTranslation();
  const {
    world,
    messages,
    suggestions,
    phase,
    actionInProgress,
    currentLocation,
    clearWorld,
    isChatMode,
    playerState,
  } = useGame();

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
  // Use ref to stabilize Set access in callbacks without causing re-renders
  const expandedThinkingRef = useRef(expandedThinking);
  expandedThinkingRef.current = expandedThinking;
  const [isAtBottom, setIsAtBottom] = useState(true);
  const lastMessageCountRef = useRef(0);
  const [showHistory, setShowHistory] = useState(false);
  const historyModalRef = useFocusTrap<HTMLDivElement>(showHistory);
  const [lastAnnouncedMessageId, setLastAnnouncedMessageId] = useState<number | null>(null);

  // Get only the latest turn for display (not the full history)
  const displayMessages = useMemo(() => getLatestTurn(messages), [messages]);

  // Count of previous turns (for history button badge)
  const previousTurnCount = messages.length - displayMessages.length;

  // Auto-scroll on new messages
  useEffect(() => {
    if (displayMessages.length > 0 && virtuosoRef.current) {
      const isNewMessage = displayMessages.length > lastMessageCountRef.current;
      lastMessageCountRef.current = displayMessages.length;

      if (isNewMessage && isAtBottom) {
        virtuosoRef.current.scrollToIndex({
          index: displayMessages.length - 1,
          align: 'end',
          behavior: 'smooth',
        });
      }
    }
  }, [displayMessages.length, isAtBottom]);

  // Reset on messages clear
  useEffect(() => {
    if (displayMessages.length === 0) {
      setIsAtBottom(true);
      lastMessageCountRef.current = 0;
    }
  }, [displayMessages.length]);

  // Track last message for screen reader announcement
  useEffect(() => {
    if (displayMessages.length > 0) {
      const lastMessage = displayMessages[displayMessages.length - 1];
      if (lastMessage.id !== lastAnnouncedMessageId && lastMessage.role !== 'user') {
        setLastAnnouncedMessageId(lastMessage.id);
      }
    }
  }, [displayMessages, lastAnnouncedMessageId]);

  // Handle Escape key to close history modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showHistory) {
        setShowHistory(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showHistory]);

  const toggleThinking = useCallback((messageId: number) => {
    setExpandedThinking(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  }, []);

  // Use Virtuoso's data parameter to avoid messages dependency
  // This prevents itemContent recreation when messages array reference changes
  // Access expandedThinking via ref to avoid recreating callback on every toggle
  const itemContent = useCallback((_index: number, message: GameMessage) => (
    <GameMessageRow
      message={message}
      isExpanded={expandedThinkingRef.current.has(message.id)}
      onToggleThinking={toggleThinking}
    />
  ), [toggleThinking]);

  if (!world) return null;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-white">
      {/* Header */}
      <div className="border-b border-slate-200 pr-4 py-3 pl-14 lg:pl-[var(--header-left-padding,1rem)] bg-white shrink-0">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-slate-800 truncate">{world.name}</h1>
              <button
                onClick={clearWorld}
                className="text-xs text-slate-400 hover:text-slate-600 px-2 py-0.5 rounded hover:bg-slate-100 transition-colors"
                aria-label={t('gameRoom.exit')}
              >
                {t('gameRoom.exit')}
              </button>
            </div>
            {phase === 'active' && (
              <div className="flex items-center gap-3 mt-0.5 text-sm text-slate-500">
                {currentLocation && (
                  <span className="flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {currentLocation.label || currentLocation.name}
                  </span>
                )}
                {playerState?.game_time && (
                  <span className="flex items-center gap-1 tabular-nums">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {String(playerState.game_time.hour).padStart(2, '0')}:{String(playerState.game_time.minute).padStart(2, '0')}
                    <span className="text-slate-400 ml-0.5">Day {playerState.game_time.day}</span>
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* History button */}
            {previousTurnCount > 0 && (
              <button
                onClick={() => setShowHistory(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
                aria-label={t('gameRoom.history')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{t('gameRoom.history')}</span>
                <span className="px-1.5 py-0.5 bg-slate-200 text-slate-600 text-xs font-medium rounded-full" aria-label={`${previousTurnCount} messages`}>
                  {previousTurnCount}
                </span>
              </button>
            )}
            {phase === 'onboarding' && (
              <span className="px-3 py-1 bg-blue-100 text-blue-700 text-xs font-medium rounded-full" role="status">
                {t('gameRoom.settingUpWorld')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-hidden min-h-0 relative">
        {displayMessages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-500">
            <div className="text-center px-4">
              <svg className="w-16 h-16 mx-auto mb-4 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
              <p className="text-lg font-medium mb-1">
                {phase === 'onboarding'
                  ? t('gameRoom.adventureBegins')
                  : t('gameRoom.whatToDo')}
              </p>
              <p className="text-sm">
                {phase === 'onboarding'
                  ? t('gameRoom.describeWorld')
                  : t('gameRoom.enterActionOrChoose')}
              </p>
            </div>
          </div>
        ) : (
          <>
            <Virtuoso
              ref={virtuosoRef}
              data={displayMessages}
              totalCount={displayMessages.length}
              itemContent={itemContent}
              initialTopMostItemIndex={displayMessages.length - 1}
              followOutput="smooth"
              atBottomStateChange={setIsAtBottom}
              overscan={200}
              className="h-full"
            />
          </>
        )}
      </div>

      {/* Turn Indicator */}
      {actionInProgress && <TurnIndicator />}

      {/* Suggested Actions and Mode Toggle Button */}
      {phase === 'active' && !actionInProgress && (
        <SuggestedActions isChatMode={isChatMode} />
      )}

      {/* Action Input */}
      <div className="border-t border-slate-200 p-4 bg-white shrink-0">
        <ActionInput
          placeholder={
            phase === 'onboarding'
              ? 'Describe your ideal world... (Ctrl+Enter)'
              : isChatMode
              ? 'Say something... (Ctrl+Enter to send, /end to exit)'
              : suggestions.length > 0
              ? '...Or, will you do something else? (Ctrl+Enter)'
              : 'What do you do? (Ctrl+Enter)'
          }
          disabled={actionInProgress}
        />
      </div>

      {/* Mobile Game State Sheet */}
      <MobileGameStateSheet />

      {/* Screen reader announcements for new messages */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {displayMessages.length > 0 && displayMessages[displayMessages.length - 1].role !== 'user' && (
          <p>
            {t('accessibility.newMessage', { agent: displayMessages[displayMessages.length - 1].agent_name || 'Narrator' })}
          </p>
        )}
      </div>

      {/* History Modal */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowHistory(false)}
            aria-hidden="true"
          />
          {/* Modal */}
          <div
            ref={historyModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-modal-title"
            className="relative w-full max-w-3xl max-h-[80vh] mx-4 bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div>
                <h2 id="history-modal-title" className="text-lg font-semibold text-slate-800">{t('gameRoom.conversationHistory')}</h2>
                <p className="text-sm text-slate-500">{t('gameRoom.messagesTotal', { count: messages.length })}</p>
              </div>
              <button
                onClick={() => setShowHistory(false)}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                aria-label={t('common.close')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto">
              {messages.map((message) => (
                <GameMessageRow
                  key={message.id}
                  message={message}
                  isExpanded={expandedThinking.has(message.id)}
                  onToggleThinking={toggleThinking}
                />
              ))}
            </div>
            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50">
              <button
                onClick={() => setShowHistory(false)}
                className="w-full px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition-colors"
              >
                {t('gameRoom.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
