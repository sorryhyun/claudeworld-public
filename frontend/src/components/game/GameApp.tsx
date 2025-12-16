import { useState, useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useAuth } from '../../contexts/AuthContext';
import { useGame, GameProvider } from '../../contexts/GameContext';
import { GameRoom } from './GameRoom';
import { GameSidebar } from './GameSidebar';
import { GameStatePanel } from './GameStatePanel';
import { Login } from '../Login';
import { BREAKPOINTS } from '../../config/breakpoints';

function GameAppContent() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { world, phase, loading, language, setLanguage } = useGame();

  // Mobile viewport height fix - sets CSS variable to actual window height
  useEffect(() => {
    const setAppHeight = () => {
      const doc = document.documentElement;
      doc.style.setProperty('--app-height', `${window.innerHeight}px`);
    };

    let timeoutId: number | undefined;
    const debouncedSetAppHeight = () => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(setAppHeight, 100);
    };

    setAppHeight();
    window.addEventListener('resize', debouncedSetAppHeight);
    window.addEventListener('orientationchange', setAppHeight);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', debouncedSetAppHeight);
      window.removeEventListener('orientationchange', setAppHeight);
    };
  }, []);

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem('gameSidebarCollapsed');
    return saved === 'true';
  });
  const [isMobile, setIsMobile] = useState(window.innerWidth < BREAKPOINTS.lg);

  // Track window size for responsive behavior
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < BREAKPOINTS.lg);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Focus trap for mobile sidebar drawer
  const sidebarRef = useFocusTrap<HTMLDivElement>(isSidebarOpen);

  // Close sidebar when world is selected/changed
  useEffect(() => {
    if (world) {
      setIsSidebarOpen(false);
    }
  }, [world?.id]);

  // Handle Escape key to close sidebar
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isSidebarOpen) {
        setIsSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isSidebarOpen]);

  // Persist desktop sidebar collapse state
  useEffect(() => {
    localStorage.setItem('gameSidebarCollapsed', String(isSidebarCollapsed));
  }, [isSidebarCollapsed]);

  const handleToggleSidebar = () => {
    if (isMobile) {
      setIsSidebarOpen(!isSidebarOpen);
    } else {
      setIsSidebarCollapsed(!isSidebarCollapsed);
    }
  };

  // Loading states
  if (authLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-4 border-slate-300 border-t-slate-700 rounded-full mx-auto mb-4" />
          <p className="text-lg text-slate-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  return (
    <div className="h-full flex bg-white relative overflow-hidden">
      {/* Hamburger Menu Button - Always visible, fixed position */}
      <button
        onClick={handleToggleSidebar}
        className="fixed top-2 left-2 z-50 p-2.5 min-w-[44px] min-h-[44px] bg-slate-700 text-white rounded-lg shadow-lg hover:bg-slate-600 active:bg-slate-500 transition-colors flex items-center justify-center"
        aria-label="Toggle menu"
      >
        {isMobile ? (
          isSidebarOpen ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )
        ) : (
          isSidebarCollapsed ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          )
        )}
      </button>

      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Close menu"
          className="lg:hidden fixed inset-0 bg-black/40 z-30 transition-opacity duration-300 ease-in-out"
          onClick={() => setIsSidebarOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsSidebarOpen(false);
            }
          }}
        />
      )}

      {/* Left Sidebar - Location List */}
      <div
        ref={sidebarRef}
        className={`
          fixed lg:static inset-y-0 left-0 z-40
          transform transition-all duration-300 ease-in-out
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          ${isSidebarCollapsed ? 'lg:-translate-x-full lg:w-0 lg:overflow-hidden' : 'lg:translate-x-0'}
        `}
      >
        <GameSidebar />
      </div>

      {/* Main Game Area */}
      <div className="flex-1 flex min-w-0">
        {loading ? (
          <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
            <div className="text-center">
              <div className="animate-spin h-8 w-8 border-4 border-slate-300 border-t-slate-700 rounded-full mx-auto mb-4" />
              <p className="text-lg text-slate-600">Loading world...</p>
            </div>
          </div>
        ) : !world ? (
          <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
            <div className="text-center max-w-md px-4">
              <svg className="w-20 h-20 mx-auto mb-6 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h2 className="text-2xl font-bold text-slate-700 mb-2">Welcome to ClaudeWorld</h2>
              <p className="text-slate-500 mb-4">
                Select a world from the sidebar to continue your adventure, or create a new one to begin!
              </p>

              {/* Language Selector */}
              <div className="flex justify-center gap-2 mb-4">
                <button
                  onClick={() => setLanguage('en')}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    language === 'en'
                      ? 'bg-slate-700 text-white'
                      : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                  }`}
                >
                  English
                </button>
                <button
                  onClick={() => setLanguage('ko')}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    language === 'ko'
                      ? 'bg-slate-700 text-white'
                      : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                  }`}
                >
                  한국어
                </button>
              </div>

              <button
                onClick={handleToggleSidebar}
                className="lg:hidden px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition-colors"
              >
                Open Worlds Menu
              </button>
            </div>
          </div>
        ) : (
          <>
            <GameRoom />
            {/* Right Sidebar - Game State (only in active phase) */}
            {phase === 'active' && <GameStatePanel />}
          </>
        )}
      </div>
    </div>
  );
}

// Main GameApp component with provider
export function GameApp() {
  return (
    <GameProvider>
      <GameAppContent />
    </GameProvider>
  );
}

export default GameApp;
