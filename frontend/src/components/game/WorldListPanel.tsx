import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { World, useGame, DEFAULT_USER_NAMES } from '../../contexts/GameContext';
import { Input } from '../ui/input';
import { listImportableWorlds, importWorld, ImportableWorld } from '../../services/gameService';

interface WorldListPanelProps {
  worlds: World[];
  selectedWorldId: number | null;
  onSelectWorld: (worldId: number) => void;
  onDeleteWorld: (worldId: number) => Promise<void>;
  onResetWorld: (worldId: number) => Promise<void>;
  onCreateWorld: (name: string, userName?: string, language?: 'en' | 'ko' | 'jp') => Promise<void>;
  onWorldImported?: () => void;
  loading?: boolean;
  creating?: boolean;
}

export function WorldListPanel({
  worlds,
  selectedWorldId,
  onSelectWorld,
  onDeleteWorld,
  onResetWorld,
  onCreateWorld,
  onWorldImported,
  loading = false,
  creating = false,
}: WorldListPanelProps) {
  const { t } = useTranslation();
  const { language } = useGame();
  const [newWorldName, setNewWorldName] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [resettingId, setResettingId] = useState<number | null>(null);
  const [importableWorlds, setImportableWorlds] = useState<ImportableWorld[]>([]);
  const [loadingImportable, setLoadingImportable] = useState(false);
  const [importingName, setImportingName] = useState<string | null>(null);
  const [showImportSection, setShowImportSection] = useState(false);

  // Load importable worlds
  const loadImportableWorlds = async () => {
    setLoadingImportable(true);
    try {
      const importable = await listImportableWorlds();
      setImportableWorlds(importable);
      setShowImportSection(importable.length > 0);
    } catch (error) {
      console.error('Failed to load importable worlds:', error);
    } finally {
      setLoadingImportable(false);
    }
  };

  useEffect(() => {
    loadImportableWorlds();
  }, [worlds]); // Refresh when worlds list changes

  const handleImport = async (worldName: string) => {
    setImportingName(worldName);
    try {
      await importWorld(worldName);
      // Remove from importable list
      setImportableWorlds(prev => prev.filter(w => w.name !== worldName));
      // Notify parent to refresh worlds list
      onWorldImported?.();
    } catch (error) {
      console.error('Failed to import world:', error);
      alert(error instanceof Error ? error.message : 'Failed to import world');
    } finally {
      setImportingName(null);
    }
  };

  const handleCreate = async () => {
    if (!newWorldName.trim() || creating) return;
    const userName = DEFAULT_USER_NAMES[language];
    await onCreateWorld(newWorldName.trim(), userName, language);
    setNewWorldName('');
  };

  const handleQuickCreate = async (lang: 'en' | 'ko' | 'jp') => {
    if (creating) return;
    const defaultNames = { en: 'New World', ko: '새로운 세계', jp: '新しい世界' };
    const timestamp = Date.now().toString(36).slice(-4);
    const worldName = `${defaultNames[lang]} ${timestamp}`;
    const userName = DEFAULT_USER_NAMES[lang];
    await onCreateWorld(worldName, userName, lang);
  };

  const handleDelete = async (e: React.MouseEvent, worldId: number) => {
    e.stopPropagation();
    if (!confirm(t('worldList.deleteConfirm'))) {
      return;
    }
    setDeletingId(worldId);
    try {
      await onDeleteWorld(worldId);
    } finally {
      setDeletingId(null);
    }
  };

  const handleReset = async (e: React.MouseEvent, worldId: number) => {
    e.stopPropagation();
    if (!confirm(t('worldList.resetConfirm'))) {
      return;
    }
    setResettingId(worldId);
    try {
      await onResetWorld(worldId);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to reset world');
    } finally {
      setResettingId(null);
    }
  };

  const getPhaseColor = (phase: string) => {
    switch (phase) {
      case 'active':
        return 'bg-green-100 text-green-700';
      case 'onboarding':
        return 'bg-blue-100 text-blue-700';
      default:
        return 'bg-slate-100 text-slate-600';
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin h-6 w-6 border-3 border-slate-300 border-t-slate-600 rounded-full mx-auto mb-2" />
          <p className="text-sm text-slate-500">{t('worldList.loadingWorlds')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Create New World */}
      <div className="p-3 border-b border-slate-200 bg-white">
        <div className="flex gap-2 mb-2">
          <Input
            value={newWorldName}
            onChange={(e) => setNewWorldName(e.target.value)}
            placeholder={t('worldList.newWorldPlaceholder')}
            disabled={creating}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="flex-1 text-sm h-9"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newWorldName.trim()}
            className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-300 text-white rounded-md text-sm font-medium transition-colors disabled:cursor-not-allowed min-w-[60px] flex items-center justify-center"
          >
            {creating ? (
              <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            )}
          </button>
        </div>
        {/* Quick Create Language Buttons */}
        <div className="flex gap-1.5">
          <button
            onClick={() => handleQuickCreate('en')}
            disabled={creating}
            className="flex-1 px-2 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:bg-slate-50 disabled:text-slate-400 text-slate-700 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1"
            title="Create new English world"
          >
            <span className="text-[10px]">🌐</span> EN
          </button>
          <button
            onClick={() => handleQuickCreate('ko')}
            disabled={creating}
            className="flex-1 px-2 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:bg-slate-50 disabled:text-slate-400 text-slate-700 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1"
            title="새로운 한국어 세계 만들기"
          >
            <span className="text-[10px]">🇰🇷</span> KO
          </button>
          <button
            onClick={() => handleQuickCreate('jp')}
            disabled={creating}
            className="flex-1 px-2 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:bg-slate-50 disabled:text-slate-400 text-slate-700 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1"
            title="新しい日本語の世界を作成"
          >
            <span className="text-[10px]">🇯🇵</span> JP
          </button>
        </div>
      </div>

      {/* Worlds List */}
      <div className="flex-1 overflow-y-auto">
        {worlds.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm p-4 text-center">
            <div>
              <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="font-medium text-slate-500">{t('worldList.noWorldsYet')}</p>
              <p className="text-xs mt-1">{t('worldList.createFirstWorld')}</p>
            </div>
          </div>
        ) : (
          worlds.map((world) => {
            const isSelected = world.id === selectedWorldId;
            const isDeleting = deletingId === world.id;
            const isResetting = resettingId === world.id;
            const isBusy = isDeleting || isResetting;

            return (
              <div
                key={world.id}
                onClick={() => !isBusy && onSelectWorld(world.id)}
                className={`group border-b border-slate-200 transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-slate-100'
                    : 'hover:bg-slate-50'
                } ${isBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`font-medium text-sm truncate ${
                          isSelected ? 'text-slate-900' : 'text-slate-800'
                        }`}>
                          {world.name}
                        </p>
                        <span className={`px-1.5 py-0.5 text-xs rounded-full shrink-0 ${getPhaseColor(world.phase)}`}>
                          {world.phase}
                        </span>
                      </div>
                      {(world.genre || world.theme) && (
                        <p className="text-xs text-slate-500 mt-0.5 truncate">
                          {world.genre}
                          {world.theme && ` - ${world.theme}`}
                        </p>
                      )}
                      <p className="text-xs text-slate-400 mt-0.5">
                        {new Date(world.created_at).toLocaleDateString()}
                      </p>
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-all">
                      {/* Reset button - only show for active worlds */}
                      {world.phase === 'active' && (
                        <button
                          onClick={(e) => handleReset(e, world.id)}
                          disabled={isBusy}
                          className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-md transition-all"
                          title={t('worldList.resetTitle')}
                        >
                          {isResetting ? (
                            <div className="animate-spin h-4 w-4 border-2 border-amber-400 border-t-transparent rounded-full" />
                          ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          )}
                        </button>
                      )}
                      {/* Delete button */}
                      <button
                        onClick={(e) => handleDelete(e, world.id)}
                        disabled={isBusy}
                        className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-all"
                        title={t('worldList.deleteTitle')}
                      >
                        {isDeleting ? (
                          <div className="animate-spin h-4 w-4 border-2 border-slate-400 border-t-transparent rounded-full" />
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Selected indicator */}
                  {isSelected && (
                    <p className="text-xs text-blue-600 mt-1.5 flex items-center gap-1">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      {t('worldList.currentlyPlaying')}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Importable Worlds Section - shown at bottom */}
      {showImportSection && importableWorlds.length > 0 && (
        <div className="border-t border-slate-300 bg-amber-50 shrink-0">
          <div className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <span className="text-xs font-medium text-amber-700">{t('worldList.loadFromDisk')}</span>
            </div>
            {loadingImportable ? (
              <div className="flex items-center justify-center py-2">
                <div className="animate-spin h-4 w-4 border-2 border-amber-400 border-t-amber-700 rounded-full" />
              </div>
            ) : (
              importableWorlds.map((world) => {
                const isImporting = importingName === world.name;
                return (
                  <div
                    key={world.name}
                    className={`flex items-center justify-between gap-2 p-2 bg-white rounded-md mb-1 border border-amber-200 ${
                      isImporting ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-slate-800 truncate">
                        {world.name}
                      </p>
                      {(world.genre || world.theme) && (
                        <p className="text-xs text-slate-500 truncate">
                          {world.genre}
                          {world.theme && ` - ${world.theme}`}
                        </p>
                      )}
                      <span className={`inline-block px-1.5 py-0.5 text-xs rounded-full mt-0.5 ${getPhaseColor(world.phase)}`}>
                        {world.phase}
                      </span>
                    </div>
                    <button
                      onClick={() => handleImport(world.name)}
                      disabled={isImporting}
                      className="shrink-0 px-2 py-1 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white rounded text-xs font-medium transition-colors flex items-center gap-1"
                      title="Load this world"
                    >
                      {isImporting ? (
                        <div className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
                      ) : (
                        <>
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                          </svg>
                          {t('worldList.load')}
                        </>
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
