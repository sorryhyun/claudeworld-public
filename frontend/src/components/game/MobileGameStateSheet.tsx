import { useState, useEffect, lazy, Suspense, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useGame } from '../../contexts/GameContext';
import { useFocusTrap } from '../../hooks/useFocusTrap';

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

// Extracted icon components to prevent recreation on every render (w-5 for mobile)
const LocationIconMobile = memo(() => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
));

const StatsIconMobile = memo(() => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
  </svg>
));

const InventoryIconMobile = memo(() => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
  </svg>
));

const AgentsIconMobile = memo(() => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
  </svg>
));

type Tab = 'locations' | 'stats' | 'inventory' | 'agents';

// TABS array with stable component references
const TABS: { id: Tab; label: string; Icon: React.ComponentType }[] = [
  { id: 'locations', label: 'Places', Icon: LocationIconMobile },
  { id: 'stats', label: 'Stats', Icon: StatsIconMobile },
  { id: 'inventory', label: 'Items', Icon: InventoryIconMobile },
  { id: 'agents', label: 'NPCs', Icon: AgentsIconMobile },
];

export function MobileGameStateSheet() {
  const { t } = useTranslation();
  const { playerState, world, isChatMode, phase } = useGame();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('stats');
  const sheetRef = useFocusTrap<HTMLDivElement>(isOpen);

  // Switch to agents tab when entering chat mode
  useEffect(() => {
    if (isChatMode) {
      setActiveTab('agents');
    }
  }, [isChatMode]);

  // Handle Escape key to close sheet
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  // Don't show during onboarding
  if (phase !== 'active') return null;

  // Get a quick stat summary for the FAB badge
  const healthStat = world?.stat_definitions?.stats?.find(
    s => ['health', 'hp', 'vitality', 'life'].some(h => s.name.toLowerCase().includes(h))
  );
  const healthValue = healthStat ? (playerState?.stats?.[healthStat.name] ?? healthStat.default) : null;
  const healthMax = healthStat?.max;
  const healthPercent = healthValue !== null && healthMax ? Math.round((healthValue / healthMax) * 100) : null;

  return (
    <>
      {/* Floating Action Button - only visible on mobile */}
      <button
        onClick={() => setIsOpen(true)}
        className="lg:hidden fixed bottom-24 right-4 z-40 w-14 h-14 rounded-full bg-slate-700 hover:bg-slate-600 shadow-lg flex items-center justify-center transition-all active:scale-95"
        aria-label="Open game state"
      >
        <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
        </svg>
        {/* Health indicator badge */}
        {healthPercent !== null && (
          <div
            className={`absolute -top-1 -right-1 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center text-white ${
              healthPercent < 25 ? 'bg-red-500' : healthPercent < 50 ? 'bg-yellow-500' : 'bg-green-500'
            }`}
          >
            {healthPercent}
          </div>
        )}
      </button>

      {/* Bottom Sheet */}
      {isOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fadeIn"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />

          {/* Sheet */}
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-sheet-title"
            className="relative bg-white rounded-t-2xl shadow-2xl max-h-[75vh] flex flex-col animate-slide-in-up"
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-2" aria-hidden="true">
              <div className="w-10 h-1 bg-slate-300 rounded-full" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 pb-2">
              <h2 id="mobile-sheet-title" className="font-semibold text-slate-800">{t('gameState.title')}</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="p-2 -mr-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-400 hover:text-slate-600"
                aria-label={t('common.close')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200 px-2" role="tablist" aria-label={t('gameState.title')}>
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls={`mobile-tabpanel-${tab.id}`}
                  id={`mobile-tab-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex-1 py-3 text-xs font-medium transition-all flex flex-col items-center gap-1 min-h-[56px]
                    ${activeTab === tab.id
                      ? 'text-slate-700 border-b-2 border-slate-700'
                      : 'text-slate-400 hover:text-slate-600 border-b-2 border-transparent'
                    }`}
                >
                  <span aria-hidden="true"><tab.Icon /></span>
                  <span>{tab.label}</span>
                  {activeTab === tab.id && <span className="sr-only">{t('accessibility.selectedTab')}</span>}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto min-h-0">
              <Suspense fallback={<TabLoadingFallback />}>
                {activeTab === 'locations' && (
                  <div
                    role="tabpanel"
                    id="mobile-tabpanel-locations"
                    aria-labelledby="mobile-tab-locations"
                  >
                    <LocationListPanel />
                  </div>
                )}

                {activeTab === 'stats' && world && playerState && (
                  <div
                    role="tabpanel"
                    id="mobile-tabpanel-stats"
                    aria-labelledby="mobile-tab-stats"
                    className="p-4"
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
                    id="mobile-tabpanel-inventory"
                    aria-labelledby="mobile-tab-inventory"
                    className="p-4"
                  >
                    <InventoryList items={playerState.inventory || []} />
                  </div>
                )}

                {activeTab === 'agents' && (
                  <div
                    role="tabpanel"
                    id="mobile-tabpanel-agents"
                    aria-labelledby="mobile-tab-agents"
                    className="p-4"
                  >
                    <AgentsList />
                  </div>
                )}
              </Suspense>
            </div>

            {/* Footer with time/turn */}
            {playerState && (
              <div className="p-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs">
                {playerState.game_time && (
                  <div className="flex items-center gap-1 text-slate-600">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="font-medium tabular-nums">
                      {String(playerState.game_time.hour).padStart(2, '0')}:
                      {String(playerState.game_time.minute).padStart(2, '0')}
                    </span>
                    <span className="text-slate-400">Day {playerState.game_time.day}</span>
                  </div>
                )}
                <div className="flex items-center gap-1 text-slate-600">
                  <span className="text-slate-400">Turn</span>
                  <span className="font-bold tabular-nums">{playerState.turn_count}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
