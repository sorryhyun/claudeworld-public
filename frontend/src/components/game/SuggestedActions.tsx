import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useGame } from '../../contexts/GameContext';

interface SuggestedActionsProps {
  isChatMode?: boolean;
}

export const SuggestedActions = memo(function SuggestedActions({ isChatMode = false }: SuggestedActionsProps) {
  const { t } = useTranslation();
  const { suggestions, selectSuggestion, isClauding, submitAction } = useGame();

  const handleEnterChatMode = useCallback(() => {
    submitAction('/chat');
  }, [submitAction]);

  const handleExitChatMode = useCallback(() => {
    submitAction('/end');
  }, [submitAction]);

  // Memoize row splitting computation - must be called before any early returns
  const { row1, row2, midpoint } = useMemo(() => {
    const mid = Math.ceil(suggestions.length / 2);
    return {
      row1: suggestions.slice(0, mid),
      row2: suggestions.slice(mid),
      midpoint: mid,
    };
  }, [suggestions]);

  // In chat mode, just show the /end button
  if (isChatMode) {
    return (
      <div className="px-4 pb-4">
        <button
          onClick={handleExitChatMode}
          disabled={isClauding}
          className="px-4 py-2.5 text-base bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 active:from-amber-700 active:to-orange-700 text-white rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
        >
          🎮 {t('game.returnToGameplay')}
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 pb-4">
      {suggestions.length > 0 && (
        <>
          <p className="text-sm text-slate-500 mb-3 font-medium">{t('game.suggestedActions')}</p>
          <div className="flex flex-col gap-2">
            {[row1, row2].map((row, rowIndex) => (
              row.length > 0 && (
                <div key={rowIndex} className="flex flex-wrap gap-2">
                  {row.map((suggestion, index) => {
                    const actualIndex = rowIndex === 0 ? index : midpoint + index;
                    return (
                      <button
                        key={actualIndex}
                        onClick={() => selectSuggestion(actualIndex)}
                        disabled={isClauding}
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
          disabled={isClauding}
          className="px-4 py-2.5 text-base bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 active:from-blue-700 active:to-cyan-700 text-white rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
        >
          💬 {t('game.chatWithCharacters')}
        </button>
      </div>
    </div>
  );
});
