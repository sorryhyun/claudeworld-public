import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from './hooks/useFocusTrap';
import { useAuth } from './contexts/AuthContext';
import { RoomProvider, useRoomContext } from './contexts/RoomContext';
import { GameProvider, useGame } from './contexts/GameContext';
import { MainSidebar } from './components/sidebar/MainSidebar';
import { ChatRoom } from './components/chat-room/ChatRoom';
import { LandingPage } from './components/LandingPage';
import { OnboardingPage } from './components/onboarding';
import { GameRoom } from './components/game/GameRoom';
import { GameStatePanel } from './components/game/GameStatePanel';
import { Login } from './components/Login';
import { BREAKPOINTS } from './config/breakpoints';

function AuthenticatedApp() {
  const { t } = useTranslation();
  const roomContext = useRoomContext();
  const { loadWorld, worldsLoading, mode, phase } = useGame();

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // Desktop sidebar collapse state with localStorage persistence
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebarCollapsed');
    return saved === 'true';
  });
  const [isMobile, setIsMobile] = useState(window.innerWidth < BREAKPOINTS.lg);

  // Consolidated resize handler - combines viewport height fix and mobile detection
  useEffect(() => {
    const doc = document.documentElement;

    const handleResize = () => {
      // Update app height CSS variable
      doc.style.setProperty('--app-height', `${window.innerHeight}px`);
      // Update mobile state
      setIsMobile(window.innerWidth < BREAKPOINTS.lg);
    };

    // Debounce resize events to avoid excessive updates
    let timeoutId: number | undefined;
    const debouncedHandleResize = () => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(handleResize, 100);
    };

    // Set immediately on mount
    handleResize();
    window.addEventListener('resize', debouncedHandleResize);

    // Keep orientationchange immediate for better mobile UX
    window.addEventListener('orientationchange', handleResize);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', debouncedHandleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  // Focus trap for mobile sidebar drawer
  const sidebarRef = useFocusTrap<HTMLDivElement>(isSidebarOpen);

  // Close sidebar when a room is selected on mobile
  useEffect(() => {
    if (roomContext.selectedRoomId !== null) {
      setIsSidebarOpen(false);
    }
  }, [roomContext.selectedRoomId]);

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

  // Persist desktop sidebar collapse state and set CSS variable for header padding
  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', String(isSidebarCollapsed));
    // Set CSS variable for components to use when sidebar is collapsed on desktop
    const root = document.documentElement;
    if (!isMobile && isSidebarCollapsed) {
      root.style.setProperty('--header-left-padding', '3.5rem'); // 56px to clear hamburger
    } else {
      root.style.setProperty('--header-left-padding', '1rem'); // 16px default
    }
  }, [isSidebarCollapsed, isMobile]);

  const handleSelectWorld = async (worldId: number) => {
    await loadWorld(worldId);
    setIsSidebarOpen(false);
  };

  const handleSelectRoom = (roomId: number) => {
    roomContext.selectRoom(roomId);
  };

  if (worldsLoading || roomContext.loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-lg sm:text-xl text-gray-600">Loading...</p>
      </div>
    );
  }

  const handleToggleSidebar = () => {
    // On mobile: toggle drawer (isSidebarOpen)
    // On desktop: toggle collapse (isSidebarCollapsed)
    if (isMobile) {
      setIsSidebarOpen(!isSidebarOpen);
    } else {
      setIsSidebarCollapsed(!isSidebarCollapsed);
    }
  };

  return (
    <div className="h-full flex bg-white relative overflow-hidden">
      {/* Skip Link for keyboard navigation */}
      <a href="#main-content" className="skip-link">
        {t('accessibility.skipToMain', 'Skip to main content')}
      </a>

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

      {/* Main Sidebar with Tabs - Drawer on mobile, collapsible on desktop */}
      <div
        ref={sidebarRef}
        className={`
          fixed lg:static inset-y-0 left-0 z-40
          transform transition-all duration-300 ease-in-out
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          ${isSidebarCollapsed ? 'lg:-translate-x-full lg:w-0 lg:overflow-hidden' : 'lg:translate-x-0'}
        `}
      >
        <MainSidebar
          onSelectRoom={handleSelectRoom}
          onSelectWorld={handleSelectWorld}
        />
      </div>

      {/* Main Content Area - Mode-based routing */}
      <main id="main-content" className="flex-1 flex min-w-0">
        {mode === 'chat' && !roomContext.selectedRoomId && <LandingPage />}
        {mode === 'chat' && roomContext.selectedRoomId && (
          <ChatRoom
            roomId={roomContext.selectedRoomId}
            onRoomRead={roomContext.refreshRooms}
            onMarkRoomAsRead={roomContext.markRoomAsReadOptimistic}
            onRenameRoom={roomContext.renameRoom}
          />
        )}
        {mode === 'onboarding' && <OnboardingPage />}
        {mode === 'game' && (
          <>
            <GameRoom />
            {phase === 'active' && <GameStatePanel />}
          </>
        )}
      </main>
    </div>
  );
}

// Main App component with auth check
function App() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-lg sm:text-xl text-gray-600">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  // Only mount providers after authentication succeeds
  return (
    <RoomProvider>
      <GameProvider>
        <AuthenticatedApp />
      </GameProvider>
    </RoomProvider>
  );
}

export default App;
