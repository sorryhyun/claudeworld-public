import { useState, KeyboardEvent } from 'react';
import { MessageList } from '../chat-room/message-list/MessageList';
import type { GameMessage } from '../../contexts/GameContext';
import type { Message } from '../../types';

interface OnboardingChatProps {
  messages: GameMessage[];
  onSendMessage: (message: string) => void;
  isProcessing: boolean;
  worldPhase: 'onboarding' | 'active' | 'ended';
}

// Convert GameMessage to Message format for MessageList compatibility
function convertToMessage(gameMessage: GameMessage): Message {
  return {
    id: gameMessage.id,
    content: gameMessage.content,
    role: gameMessage.role,
    agent_id: gameMessage.agent_id,
    thinking: gameMessage.thinking,
    timestamp: gameMessage.timestamp ?? new Date().toISOString(),
    agent_name: gameMessage.agent_name ?? undefined,
    is_chatting: gameMessage.is_chatting,
  };
}

export function OnboardingChat({
  messages,
  onSendMessage,
  isProcessing,
  worldPhase,
}: OnboardingChatProps) {
  const [inputValue, setInputValue] = useState('');

  const handleSend = () => {
    if (!inputValue.trim() || isProcessing) return;
    onSendMessage(inputValue.trim());
    setInputValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  // Convert GameMessages to Messages for MessageList
  const displayMessages = messages.map(convertToMessage);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Messages Area - matches ChatRoom structure for proper Virtuoso height */}
      {displayMessages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-slate-500">
            <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p className="text-sm">Waiting for your guide...</p>
          </div>
        </div>
      ) : (
        <MessageList messages={displayMessages} />
      )}

      {/* Input Area */}
      <div className="border-t border-slate-200 p-4 bg-white">
        {worldPhase === 'active' ? (
          <div className="text-center text-slate-500 py-2">
            <p className="text-sm">Your world is ready! Click "Enter World" above to begin your adventure.</p>
          </div>
        ) : (
          <div className="flex gap-2">
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your response... (Ctrl+Enter to send)"
              disabled={isProcessing}
              rows={1}
              className="flex-1 px-4 py-3 border border-slate-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent disabled:bg-slate-100 disabled:cursor-not-allowed text-sm sm:text-[15px]"
              style={{ minHeight: '48px', maxHeight: '120px' }}
            />
            <button
              onClick={handleSend}
              disabled={!inputValue.trim() || isProcessing}
              className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 active:bg-slate-500 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center min-w-[80px]"
            >
              {isProcessing ? (
                <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
