import { useState, useEffect, useRef } from 'react';
import { useGame } from '../../contexts/GameContext';
import { useToast } from '../../contexts/ToastContext';
import { OnboardingChat } from './OnboardingChat';
import { WorldReadyBanner } from './WorldReadyBanner';

export function OnboardingPage() {
  const {
    world,
    messages,
    phase,
    loading,
    enterGame,
    exitToChat,
    sendOnboardingMessage,
    actionInProgress,
  } = useGame();
  const { addToast } = useToast();

  // Track phase transition for showing the ready banner
  const [showWorldReady, setShowWorldReady] = useState(false);
  const prevPhaseRef = useRef<string | null>(null);

  // Detect world phase transition from onboarding to active
  useEffect(() => {
    if (world?.phase) {
      const currentPhase = world.phase;
      const prevPhase = prevPhaseRef.current;

      // Show banner when transitioning from onboarding to active
      if (prevPhase === 'onboarding' && currentPhase === 'active') {
        setShowWorldReady(true);
        addToast('World creation complete! Your adventure awaits.', 'success');
      }

      prevPhaseRef.current = currentPhase;
    }
  }, [world?.phase, addToast]);

  const handleEnterWorld = async () => {
    if (!world?.id) return;

    try {
      await enterGame(world.id);
      setShowWorldReady(false);
      addToast('Entering your world...', 'success');
    } catch (error) {
      console.error('Failed to enter world:', error);
      addToast('Failed to enter world', 'error');
    }
  };

  const handleSendMessage = async (message: string) => {
    if (!message.trim() || actionInProgress) return;

    try {
      await sendOnboardingMessage(message);
    } catch (error) {
      console.error('Failed to send message:', error);
      addToast('Failed to send message', 'error');
    }
  };

  const handleCancel = () => {
    exitToChat();
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-4 border-slate-300 border-t-slate-700 rounded-full mx-auto mb-4" />
          <p className="text-lg text-slate-600">Loading world...</p>
        </div>
      </div>
    );
  }

  // No world state (shouldn't happen in onboarding mode, but handle gracefully)
  if (!world) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center">
          <h3 className="text-xl font-bold text-slate-700 mb-2">No World Selected</h3>
          <p className="text-slate-600 mb-4">Something went wrong. Please try again.</p>
          <button
            onClick={handleCancel}
            className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
          >
            Back to Chat
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-white min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between pr-4 py-3 pl-14 lg:pl-[var(--header-left-padding,1rem)] border-b border-slate-200 bg-white">
        <div className="flex items-center gap-3">
          <button
            onClick={handleCancel}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
            title="Cancel onboarding"
          >
            <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <div>
            <h2 className="font-bold text-lg text-slate-800">{world.name}</h2>
            <p className="text-sm text-slate-500">
              {phase === 'onboarding' ? 'Creating your world...' : 'World ready!'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-2 py-1 text-xs font-medium rounded-full ${
            phase === 'onboarding'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-green-100 text-green-700'
          }`}>
            {phase === 'onboarding' ? 'Onboarding' : 'Ready'}
          </span>
        </div>
      </div>

      {/* World Ready Banner */}
      {(showWorldReady || world.phase === 'active') && (
        <WorldReadyBanner onEnterWorld={handleEnterWorld} />
      )}

      {/* Chat Area */}
      <OnboardingChat
        messages={messages}
        onSendMessage={handleSendMessage}
        isProcessing={actionInProgress}
        worldPhase={world.phase}
      />
    </div>
  );
}
