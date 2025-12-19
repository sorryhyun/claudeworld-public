import { useState, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { cn } from '@/lib/utils';
import { LoadingDots } from './LoadingDots';

export type MessageVariant = 'chat' | 'game' | 'system' | 'narration';

export interface MessageBubbleProps {
  content: string;
  thinkingText?: string;
  variant?: MessageVariant;
  sender?: {
    name: string;
    avatarUrl?: string;
    isPlayer?: boolean;
  };
  timestamp?: Date | string;
  isStreaming?: boolean;
  isTyping?: boolean;
  isSkipped?: boolean;
  className?: string;
  onCopy?: (content: string) => void;
}

/**
 * Unified message bubble component for displaying chat and game messages.
 *
 * Variants:
 * - chat: Light theme chat bubbles (default)
 * - game: Dark theme game messages
 * - system: System announcements
 * - narration: Story narration with gradient background
 */
export const MessageBubble = memo(function MessageBubble({
  content,
  thinkingText,
  variant = 'chat',
  sender,
  timestamp,
  isStreaming,
  isTyping,
  isSkipped,
  className,
  onCopy,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  const handleCopy = useCallback(async () => {
    if (onCopy) {
      onCopy(content);
    } else {
      await navigator.clipboard.writeText(content);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content, onCopy]);

  const formatTime = (ts: Date | string) => {
    const date = typeof ts === 'string' ? new Date(ts) : ts;
    if (isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Variant-specific container styles
  const variantContainerStyles: Record<MessageVariant, string> = {
    chat: sender?.isPlayer
      ? 'bg-slate-700 text-white rounded-2xl rounded-tr-sm'
      : 'bg-slate-100 text-slate-800 rounded-2xl rounded-tl-sm',
    game: 'bg-slate-800/80 rounded-xl border border-slate-700/50 text-slate-100',
    system: 'bg-blue-50 rounded-lg border border-blue-200 text-blue-800 text-center',
    narration: 'bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200 italic text-slate-700',
  };

  // System messages are centered without sender info
  if (variant === 'system') {
    return (
      <div className={cn('py-2 animate-fadeIn', className)}>
        <div className={cn(
          'inline-block px-4 py-1.5 text-sm',
          variantContainerStyles[variant]
        )}>
          {content}
        </div>
      </div>
    );
  }

  const isPlayer = sender?.isPlayer;

  return (
    <div
      className={cn(
        'flex animate-fadeIn',
        isPlayer ? 'justify-end' : 'justify-start',
        className
      )}
    >
      <div className={cn(
        'flex gap-2 sm:gap-3 max-w-[92%] sm:max-w-[85%] lg:max-w-3xl',
        isPlayer && 'flex-row-reverse'
      )}>
        {/* Avatar */}
        {sender && (
          sender.avatarUrl ? (
            <img
              src={sender.avatarUrl}
              alt={sender.name}
              className="w-9 h-9 sm:w-12 sm:h-12 rounded-full flex-shrink-0 object-cover ring-1 ring-slate-200 shadow-sm"
              loading="lazy"
            />
          ) : (
            <div className={cn(
              'w-9 h-9 sm:w-12 sm:h-12 rounded-full flex items-center justify-center flex-shrink-0',
              isPlayer ? 'bg-slate-700' : 'bg-slate-300'
            )}>
              <span className={cn(
                'font-semibold text-sm',
                isPlayer ? 'text-white' : 'text-slate-700'
              )}>
                {sender.name[0]?.toUpperCase() || 'A'}
              </span>
            </div>
          )
        )}

        {/* Message Content */}
        <div className="flex flex-col gap-1 min-w-0">
          {/* Header: sender name + timestamp */}
          {sender && (
            <div className={cn(
              'flex items-center gap-2 px-1',
              isPlayer && 'justify-end'
            )}>
              <span className="font-semibold text-sm text-slate-700">
                {sender.name}
              </span>
              {timestamp && !isTyping && (
                <span className="text-xs text-slate-500">
                  {formatTime(timestamp)}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2 min-w-0">
            {/* Thinking text toggle (collapsible) */}
            {thinkingText && !isTyping && (
              <button
                onClick={() => setThinkingExpanded(!thinkingExpanded)}
                className="flex items-center gap-2 text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors ml-1"
                aria-expanded={thinkingExpanded}
              >
                <svg
                  className={cn(
                    'w-4 h-4 transition-transform',
                    thinkingExpanded && 'rotate-90'
                  )}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span>{t('message.thinkingProcess', 'Thinking Process')}</span>
              </button>
            )}

            {/* Expanded thinking content */}
            {thinkingText && thinkingExpanded && (
              <div className="pl-3 py-1 my-1 border-l-2 border-slate-300 text-slate-500 text-sm bg-slate-50/50 rounded-r-lg">
                <div className="whitespace-pre-wrap break-words leading-relaxed italic font-mono text-xs">
                  {thinkingText}
                </div>
              </div>
            )}

            {/* Main message bubble */}
            <div
              className={cn(
                'relative group px-3 py-2 sm:px-4 sm:py-3 text-sm sm:text-[15px] leading-relaxed',
                variantContainerStyles[variant],
                isSkipped && 'opacity-75 italic'
              )}
            >
              {isTyping ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <LoadingDots size="sm" color="secondary" />
                    <span className="text-sm text-slate-600">
                      {thinkingText ? t('message.thinking', 'thinking...') : t('message.typing', 'typing...')}
                    </span>
                  </div>
                  {/* Streaming thinking content */}
                  {thinkingText && (
                    <div className="pl-3 py-1 border-l-2 border-slate-300 text-slate-500 bg-slate-50/50 rounded-r-lg max-h-32 overflow-y-auto">
                      <div className="whitespace-pre-wrap break-words leading-relaxed italic font-mono text-xs">
                        {thinkingText}
                      </div>
                    </div>
                  )}
                  {/* Streaming response content */}
                  {content && (
                    <div className="text-slate-700 text-sm">
                      {content}
                      <span className="inline-block w-2 h-4 bg-slate-600 ml-0.5 animate-pulse" />
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="prose prose-sm max-w-none break-words leading-relaxed select-text prose-p:leading-relaxed">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkBreaks]}
                      components={{
                        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                        em: ({ children }) => <em className="italic">{children}</em>,
                        ul: ({ children }) => <ul className="list-disc list-inside mb-2">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal list-inside mb-2">{children}</ol>,
                        li: ({ children }) => <li className="mb-1">{children}</li>,
                        code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) => {
                          const isInline = !className;
                          return isInline ? (
                            <code className="bg-slate-200 text-slate-800 px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
                              {children}
                            </code>
                          ) : (
                            <pre className="bg-slate-800 text-slate-100 p-3 rounded-lg overflow-x-auto my-2">
                              <code className="text-sm font-mono" {...props}>{children}</code>
                            </pre>
                          );
                        },
                        a: ({ children, href }) => (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyan-600 hover:text-cyan-500 underline"
                          >
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {content}
                    </ReactMarkdown>

                    {/* Streaming indicator */}
                    {isStreaming && (
                      <span className="inline-block w-2 h-4 bg-slate-600 ml-0.5 animate-pulse" />
                    )}
                  </div>

                  {/* Copy button (appears on hover) */}
                  <button
                    onClick={handleCopy}
                    className={cn(
                      'absolute bottom-2 right-2 p-1.5 rounded-lg transition-all',
                      'opacity-0 group-hover:opacity-100 focus:opacity-100',
                      isPlayer
                        ? 'bg-white/20 hover:bg-white/30 text-white'
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                    )}
                    title={copied ? t('message.copied', 'Copied!') : t('message.copy', 'Copy message')}
                    aria-label={copied ? t('message.copied', 'Copied!') : t('message.copy', 'Copy message')}
                  >
                    {copied ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
