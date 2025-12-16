import { useGame } from '../../contexts/GameContext';

interface SuggestedActionsProps {
  isChatMode?: boolean;
}

export function SuggestedActions({ isChatMode = false }: SuggestedActionsProps) {
  const { suggestions, useSuggestion, actionInProgress, submitAction } = useGame();

  const handleEnterChatMode = () => {
    submitAction('/chat');
  };

  const handleExitChatMode = () => {
    submitAction('/end');
  };

  // In chat mode, just show the /end button
  if (isChatMode) {
    return (
      <div className="px-4 pb-4">
        <button
          onClick={handleExitChatMode}
          disabled={actionInProgress}
          className="px-4 py-2.5 text-base bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 active:from-amber-700 active:to-orange-700 text-white rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
        >
          🎮 게임플레이로 돌아간다
        </button>
      </div>
    );
  }

  // Split suggestions into 2 rows
  const midpoint = Math.ceil(suggestions.length / 2);
  const row1 = suggestions.slice(0, midpoint);
  const row2 = suggestions.slice(midpoint);

  return (
    <div className="px-4 pb-4">
      {suggestions.length > 0 && (
        <>
          <p className="text-sm text-slate-500 mb-3 font-medium">Suggested actions:</p>
          <div className="flex flex-col gap-2">
            {[row1, row2].map((row, rowIndex) => (
              row.length > 0 && (
                <div key={rowIndex} className="flex flex-wrap gap-2">
                  {row.map((suggestion, index) => {
                    const actualIndex = rowIndex === 0 ? index : midpoint + index;
                    return (
                      <button
                        key={actualIndex}
                        onClick={() => useSuggestion(actualIndex)}
                        disabled={actionInProgress}
                        className="px-4 py-2.5 text-base bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed border border-slate-200 shadow-sm"
                      >
                        <span className="text-slate-400 mr-1.5">{actualIndex + 1}.</span>
                        {suggestion}
                      </button>
                    );
                  })}
                </div>
              )
            ))}
          </div>
        </>
      )}

      {/* Direct chat mode button */}
      <div className={suggestions.length > 0 ? "mt-3" : ""}>
        <button
          onClick={handleEnterChatMode}
          disabled={actionInProgress}
          className="px-4 py-2.5 text-base bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 active:from-blue-700 active:to-cyan-700 text-white rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
        >
          💬 캐릭터들과 직접 대화한다
        </button>
      </div>
    </div>
  );
}
