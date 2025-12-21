import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGame, DEFAULT_USER_NAMES } from '../contexts/GameContext';
import { useToast } from '../contexts/ToastContext';
import { LanguageSelector } from './shared/LanguageSelector';
import { HowToUseModal } from './shared/HowToUseModal';

export function LandingPage() {
  const { t } = useTranslation();
  const {
    worlds,
    worldsLoading,
    loading,
    createWorld,
    loadWorld,
    language,
    setLanguage,
  } = useGame();
  const { addToast } = useToast();

  const [worldName, setWorldName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showHowToUse, setShowHowToUse] = useState(false);

  const handleCreateWorld = async () => {
    if (!worldName.trim() || isCreating) return;

    setIsCreating(true);
    try {
      const userName = DEFAULT_USER_NAMES[language];
      await createWorld(worldName.trim(), userName, language);
      setWorldName('');
      addToast(`World "${worldName.trim()}" created!`, 'success');
      // Mode will be set to 'onboarding' automatically by createWorld
    } catch (error) {
      console.error('Failed to create world:', error);
      addToast('Failed to create world', 'error');
    } finally {
      setIsCreating(false);
    }
  };

  const handleSelectWorld = async (worldId: number) => {
    try {
      await loadWorld(worldId);
      // Mode will be set automatically based on world.phase
    } catch (error) {
      console.error('Failed to load world:', error);
      addToast('Failed to load world', 'error');
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4 bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="text-center max-w-md">
        {/* Globe icon */}
        <div className="w-24 h-24 mx-auto mb-6 bg-white rounded-full shadow-lg flex items-center justify-center">
          <svg className="w-12 h-12 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        <h1 className="text-3xl font-bold text-slate-800 mb-2">{t('landing.welcome')}</h1>
        <p className="text-slate-600 mb-6">{t('landing.subtitle')}</p>

        {/* Language Selector */}
        <LanguageSelector
          language={language}
          onLanguageChange={setLanguage}
          className="mb-4"
        />

        {/* How to Use Button */}
        <button
          onClick={() => setShowHowToUse(true)}
          className="text-slate-600 hover:text-slate-800 text-sm underline transition-colors mb-8"
        >
          {t('landing.howToUse')}
        </button>

        {/* Create World Form */}
        <div className="bg-white rounded-xl shadow-md p-6 mb-6">
          <h2 className="text-lg font-semibold text-slate-700 mb-4">{t('landing.createNewWorld')}</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={worldName}
              onChange={(e) => setWorldName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateWorld()}
              placeholder={t('landing.enterWorldName')}
              disabled={isCreating || loading}
              className="flex-1 px-4 py-3 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent disabled:bg-slate-100 disabled:cursor-not-allowed"
            />
            <button
              onClick={handleCreateWorld}
              disabled={!worldName.trim() || isCreating || loading}
              className="px-5 py-3 bg-slate-700 hover:bg-slate-600 active:bg-slate-500 disabled:bg-slate-300 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2 shadow-sm disabled:cursor-not-allowed min-w-[100px]"
            >
              {isCreating ? (
                <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  {t('landing.create')}
                </>
              )}
            </button>
          </div>
        </div>

        {/* Existing Worlds */}
        {worldsLoading ? (
          <div className="text-slate-500 text-sm">Loading worlds...</div>
        ) : worlds.length > 0 ? (
          <div className="bg-white rounded-xl shadow-md p-6">
            <h2 className="text-lg font-semibold text-slate-700 mb-4">{t('landing.continueAdventure')}</h2>
            <div className="space-y-2">
              {worlds.slice(0, 5).map((w) => (
                <button
                  key={w.id}
                  onClick={() => handleSelectWorld(w.id)}
                  disabled={loading}
                  className="w-full px-4 py-3 bg-slate-50 hover:bg-slate-100 active:bg-slate-200 text-slate-700 rounded-lg text-sm transition-colors border border-slate-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-between"
                >
                  <span className="font-medium">{w.name}</span>
                  <span className={`px-2 py-0.5 text-xs rounded-full ${
                    w.phase === 'active'
                      ? 'bg-green-100 text-green-700'
                      : w.phase === 'onboarding'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-slate-100 text-slate-600'
                  }`}>
                    {w.phase}
                  </span>
                </button>
              ))}
              {worlds.length > 5 && (
                <p className="text-slate-500 text-xs mt-2">
                  {t('landing.moreWorlds', { count: worlds.length - 5 })}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-slate-500 text-sm">
            {t('landing.noWorlds')}
          </p>
        )}

        <p className="text-slate-400 text-xs mt-6">
          {t('landing.footer')}
        </p>
      </div>

      {/* How to Use Modal */}
      <HowToUseModal open={showHowToUse} onOpenChange={setShowHowToUse} />
    </div>
  );
}
