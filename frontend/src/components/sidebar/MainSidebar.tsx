import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useRoomContext } from '../../contexts/RoomContext';
import { useGame } from '../../contexts/GameContext';
import { CreateRoomForm } from './CreateRoomForm';
import { RoomListPanel } from './RoomListPanel';
import { WorldListPanel } from '../game/WorldListPanel';

interface MainSidebarProps {
  onSelectRoom: (roomId: number) => void;
  onSelectWorld: (worldId: number) => void;
}

export const MainSidebar = ({
  onSelectRoom,
  onSelectWorld,
}: MainSidebarProps) => {
  const { logout } = useAuth();
  const roomContext = useRoomContext();
  const {
    worlds,
    world,
    worldsLoading,
    loading,
    createWorld,
    deleteWorld,
    resetWorld,
    mode,
    exitToChat,
  } = useGame();
  const [activeTab, setActiveTab] = useState<'rooms' | 'worlds'>('rooms');
  const [showRoomForm, setShowRoomForm] = useState(false);
  const [creating, setCreating] = useState(false);

  // Sync tab with mode when mode changes externally
  useEffect(() => {
    if (mode === 'chat') {
      setActiveTab('rooms');
    } else if (mode === 'onboarding' || mode === 'game') {
      setActiveTab('worlds');
    }
  }, [mode]);

  const handleCreateWorld = async (name: string) => {
    setCreating(true);
    try {
      const newWorld = await createWorld(name);
      onSelectWorld(newWorld.id);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="w-80 sm:w-80 bg-slate-100 flex flex-col h-full border-r border-slate-300 select-none">
      {/* Header - Add left padding to avoid overlap with fixed hamburger button */}
      <div className="pl-14 pr-6 pt-2 pb-4 border-b border-slate-300 bg-white">
        <h2 className="text-mobile-base font-bold text-slate-700 tracking-tight mb-1">ClaudeWorld</h2>
        <p className="text-slate-600 text-xs font-medium tracking-wider">TRPG Adventure Platform</p>
      </div>

      {/* Tabs */}
      <div className="flex bg-white">
        <button
          onClick={() => {
            setActiveTab('rooms');
            // Exit to chat mode when switching to rooms tab
            if (mode !== 'chat') {
              exitToChat();
            }
          }}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === 'rooms'
              ? 'text-slate-700 border-b-2 border-slate-700'
              : 'text-slate-500 hover:text-slate-700 border-b-2 border-transparent'
          }`}
        >
          Chatrooms
        </button>
        <button
          onClick={() => setActiveTab('worlds')}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === 'worlds'
              ? 'text-slate-700 border-b-2 border-slate-700'
              : 'text-slate-500 hover:text-slate-700 border-b-2 border-transparent'
          }`}
        >
          Worlds
        </button>
      </div>

      {/* Rooms Tab Content */}
      {activeTab === 'rooms' && (
        <>
          {/* New Room Button (Desktop only) */}
          <div className="hidden lg:block p-3 border-b border-slate-300 bg-white">
            <button
              onClick={() => setShowRoomForm(!showRoomForm)}
              className="w-full px-3 py-2.5 bg-slate-700 hover:bg-slate-600 active:bg-slate-500 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2 text-sm touch-manipulation min-h-[44px]"
            >
              <span className="text-xl">+</span>
              {showRoomForm ? 'Cancel' : 'New Chatroom'}
            </button>
          </div>

          {/* Create Room Form */}
          {showRoomForm && (
            <CreateRoomForm
              onCreateRoom={roomContext.createRoom}
              onClose={() => setShowRoomForm(false)}
            />
          )}

          {/* Rooms List with FAB Container */}
          <div className="relative flex-1 min-h-0">
            <RoomListPanel
              rooms={roomContext.rooms}
              selectedRoomId={roomContext.selectedRoomId}
              onSelectRoom={onSelectRoom}
              onDeleteRoom={roomContext.deleteRoom}
            />

            {/* Floating Action Button (Mobile only) */}
            <button
              onClick={() => setShowRoomForm(!showRoomForm)}
              className="lg:hidden fixed bottom-6 right-6 w-14 h-14 bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center hover:bg-slate-600 active:scale-95 transition-transform z-30"
              title={showRoomForm ? 'Cancel' : 'New Chatroom'}
            >
              {showRoomForm ? (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              )}
            </button>
          </div>
        </>
      )}

      {/* Worlds Tab Content */}
      {activeTab === 'worlds' && (
        <WorldListPanel
          worlds={worlds}
          selectedWorldId={world?.id ?? null}
          onSelectWorld={onSelectWorld}
          onDeleteWorld={deleteWorld}
          onResetWorld={resetWorld}
          onCreateWorld={handleCreateWorld}
          loading={worldsLoading}
          creating={creating || loading}
        />
      )}

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
};
