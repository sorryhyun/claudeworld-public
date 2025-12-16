import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useGame } from '../../contexts/GameContext';
import { WorldListPanel } from './WorldListPanel';

export function GameSidebar() {
  const { logout } = useAuth();
  const {
    worlds,
    world,
    worldsLoading,
    loading,
    createWorld,
    loadWorld,
    deleteWorld,
    resetWorld,
    refreshWorlds,
  } = useGame();

  const [creating, setCreating] = useState(false);

  const handleCreateWorld = async (name: string, userName?: string) => {
    setCreating(true);
    try {
      await createWorld(name, userName);
    } finally {
      setCreating(false);
    }
  };

  const handleSelectWorld = async (worldId: number) => {
    if (world?.id === worldId) return;
    await loadWorld(worldId);
  };

  return (
    <div className="w-80 sm:w-80 bg-slate-100 flex flex-col h-full border-r border-slate-300 select-none">
      {/* Header - Add left padding to avoid overlap with fixed hamburger button */}
      <div className="pl-14 pr-4 pt-2 pb-4 border-b border-slate-300 bg-white">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <h2 className="text-mobile-base font-bold text-slate-700 tracking-tight mb-1">
              ClaudeWorld
            </h2>
            <p className="text-slate-600 text-xs font-medium tracking-wider">
              TRPG Adventure
            </p>
          </div>
        </div>
      </div>

      {/* Section Header */}
      <div className="px-4 py-2 bg-white border-b border-slate-300">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Worlds
        </div>
      </div>

      {/* World List */}
      <WorldListPanel
        worlds={worlds}
        selectedWorldId={world?.id ?? null}
        onSelectWorld={handleSelectWorld}
        onDeleteWorld={deleteWorld}
        onResetWorld={resetWorld}
        onCreateWorld={handleCreateWorld}
        onWorldImported={refreshWorlds}
        loading={worldsLoading}
        creating={creating || loading}
      />

      {/* Logout Button */}
      <div className="mt-auto p-3 border-t border-slate-300 bg-white">
        <button
          onClick={() => {
            if (confirm('Are you sure you want to logout?')) {
              logout();
            }
          }}
          className="w-full px-3 py-2.5 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 rounded-lg font-medium transition-colors text-sm touch-manipulation min-h-[44px] flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Logout
        </button>
      </div>
    </div>
  );
}
