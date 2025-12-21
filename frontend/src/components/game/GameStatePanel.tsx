import { useState, useEffect, lazy, Suspense, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useGame } from '../../contexts/GameContext';

// Lazy load tab content for code splitting
const StatsDisplay = lazy(() => import('./StatsDisplay').then(m => ({ default: m.StatsDisplay })));
const InventoryList = lazy(() => import('./InventoryList').then(m => ({ default: m.InventoryList })));
const AgentsList = lazy(() => import('./AgentsList').then(m => ({ default: m.AgentsList })));
const LocationListPanel = lazy(() => import('./LocationListPanel').then(m => ({ default: m.LocationListPanel })));

// Loading fallback for lazy-loaded tabs
const TabLoadingFallback = () => (
  <div className="flex items-center justify-center p-6">
    <div className="w-5 h-5 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin" />
  </div>
);

// Extracted icon components to prevent recreation on every render
const LocationIcon = memo(() => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
));

const StatsIcon = memo(() => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
  </svg>
));

const InventoryIcon = memo(() => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
  </svg>
));

const AgentsIcon = memo(() => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
  </svg>
));

type Tab = 'locations' | 'stats' | 'inventory' | 'agents';

// TABS array with stable component references - labels are translation keys
const TABS: { id: Tab; labelKey: string; Icon: React.ComponentType }[] = [
  { id: 'locations', labelKey: 'gameState.tabs.places', Icon: LocationIcon },
  { id: 'stats', labelKey: 'gameState.tabs.stats', Icon: StatsIcon },
  { id: 'inventory', labelKey: 'gameState.tabs.items', Icon: InventoryIcon },
  { id: 'agents', labelKey: 'gameState.tabs.npcs', Icon: AgentsIcon },
];

export function GameStatePanel() {
  const { t } = useTranslation();
  const { playerState, world, isChatMode } = useGame();
  const [activeTab, setActiveTab] = useState<Tab>('locations');
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('gameStatePanelCollapsed') === 'true';
  });

  // Switch to agents tab when entering chat mode
  useEffect(() => {
    if (isChatMode) {
      setActiveTab('agents');
    }
  }, [isChatMode]);

  const toggleCollapse = () => {
    const newValue = !collapsed;
    setCollapsed(newValue);
    localStorage.setItem('gameStatePanelCollapsed', String(newValue));
  };

  // Collapsed state - show expand button
  if (collapsed) {
    return (
      <button
        onClick={toggleCollapse}
        className="w-12 min-w-[48px] bg-slate-50 border-l border-slate-200 flex items-center justify-center hover:bg-slate-100 transition-colors"
        aria-label="Expand game panel"
        title="Show game state"
      >
        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
        </svg>
      </button>
    );
  }

  return (
    <div className="w-72 border-l border-slate-200 bg-slate-50 flex flex-col shrink-0 hidden lg:flex">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-slate-200 bg-white">
        <span className="font-semibold text-sm text-slate-700">{t('gameState.title')}</span>
        <button
          onClick={toggleCollapse}
          className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-slate-100 rounded-md transition-colors"
          aria-label="Collapse game panel"
          title="Hide panel"
        >
          <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white" role="tablist" aria-label={t('gameState.title')}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            id={`tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-2.5 text-xs font-medium transition-all flex flex-col items-center gap-1
              ${activeTab === tab.id
                ? 'text-slate-700 border-b-2 border-slate-700 bg-slate-50'
                : 'text-slate-400 hover:text-slate-600 border-b-2 border-transparent'
              }`}
          >
            <span aria-hidden="true"><tab.Icon /></span>
            <span>{t(tab.labelKey)}</span>
            {activeTab === tab.id && <span className="sr-only">{t('accessibility.selectedTab')}</span>}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        <Suspense fallback={<TabLoadingFallback />}>
          {activeTab === 'locations' && (
            <div
              role="tabpanel"
              id="tabpanel-locations"
              aria-labelledby="tab-locations"
            >
              <LocationListPanel />
            </div>
          )}

          {activeTab === 'stats' && world && playerState && (
            <div
              role="tabpanel"
              id="tabpanel-stats"
              aria-labelledby="tab-stats"
              className="p-3"
            >
              <StatsDisplay
                definitions={world.stat_definitions?.stats || []}
                current={playerState.stats || {}}
              />
            </div>
          )}

          {activeTab === 'inventory' && playerState && (
            <div
              role="tabpanel"
              id="tabpanel-inventory"
              aria-labelledby="tab-inventory"
              className="p-3"
            >
              <InventoryList items={playerState.inventory || []} />
            </div>
          )}

          {activeTab === 'agents' && (
            <div
              role="tabpanel"
              id="tabpanel-agents"
              aria-labelledby="tab-agents"
              className="p-3"
            >
              <AgentsList />
            </div>
          )}
        </Suspense>
      </div>

      {/* Time & Turn Counter */}
      {playerState && (
        <div className="p-3 border-t border-slate-200 bg-white space-y-2">
          {/* Game Time */}
          {playerState.game_time && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">{t('gameState.time')}</span>
              <span className="font-bold text-slate-700 tabular-nums">
                {String(playerState.game_time.hour).padStart(2, '0')}:
                {String(playerState.game_time.minute).padStart(2, '0')}
                <span className="text-slate-400 ml-1">{t('common.day', { day: playerState.game_time.day })}</span>
              </span>
            </div>
          )}
          {/* Turn Counter */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">{t('gameState.turn')}</span>
            <span className="font-bold text-slate-700 tabular-nums">{playerState.turn_count}</span>
          </div>
        </div>
      )}
    </div>
  );
}
