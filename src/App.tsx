import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { SearchPage } from './pages/SearchPage';
import { CollectionPage } from './pages/CollectionPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { CharactersPage } from './pages/CharactersPage';
import { CharacterChatPage } from './pages/CharacterChatPage';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { useAuthStore } from './store/useAuthStore';
import { useCollectionStore } from './store/useCollectionStore';
import { useAIStore } from './store/useAIStore';
import { useThemeStore } from './store/useThemeStore';
import { useCharacterStore } from './store/useCharacterStore';
import { checkUpdates } from './services/aiService';
import { useTranslation } from 'react-i18next';

// Protected Route Wrapper
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuthStore();
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
};

const App: React.FC = () => {
  const { t } = useTranslation();
  const { initialize, initialized } = useCollectionStore();
  const initAI = useAIStore(s => s.initialize);
  const initTheme = useThemeStore(s => s.initialize);
  const initCharacters = useCharacterStore(s => s.initialize);

  // Initialize store on mount
  useEffect(() => {
    initialize();
    initAI();
    initTheme();
    initCharacters();
  }, [initialize, initAI, initTheme, initCharacters]);

  // Auto-refresh logic: run once when the collection store finishes initializing.
  // Watching `initialized` (instead of a fixed delay) avoids the race where a
  // slow backend load causes the startup check to be skipped entirely.
  useEffect(() => {
    if (!initialized) return;

    const refreshUpdates = async () => {
      const { collection, updateItem, bumpToFront } = useCollectionStore.getState();

      const now = Date.now();
      
      const getIntervalMs = (item: any) => {
        if (!item.isOngoing) return Number.POSITIVE_INFINITY;
        const notifOn = item.notificationEnabled !== false;
        if (!notifOn) return Number.POSITIVE_INFINITY;
        if (item.type === 'TV Series') return item.hasNewUpdate ? 6 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
        if (item.type === 'Comic') return 24 * 60 * 60 * 1000;
        return 48 * 60 * 60 * 1000;
      };
      const itemsToCheck = collection.filter(item => {
        const interval = getIntervalMs(item);
        if (!item.lastCheckedAt) return interval < Number.POSITIVE_INFINITY;
        return now - item.lastCheckedAt > interval;
      });

      if (itemsToCheck.length > 0) {
        console.log("Checking updates for:", itemsToCheck.map(i => i.title));
        const updates = await checkUpdates(itemsToCheck);
        
        let updateCount = 0;
        updates.forEach(update => {
          const originalItem = itemsToCheck.find(i => i.id === update.id);
          if (originalItem) {
             // Only update if info changed to avoid unnecessary writes
             if (update.latestUpdateInfo !== originalItem.latestUpdateInfo) {
               updateItem(update.id, {
                 latestUpdateInfo: update.latestUpdateInfo,
                 isOngoing: update.isOngoing,
                 ...(update.totalEpisodes ? { totalEpisodes: update.totalEpisodes } : {}),
                 ...(update.seasons ? { seasons: update.seasons } : {}),
                 ...(update.tmdbId ? { tmdbId: update.tmdbId, tmdbMediaType: update.tmdbMediaType } : {}),
                 lastCheckedAt: now,
                 hasNewUpdate: true
               });
               // New content floats the work to the front of the list (not a
               // pin). "Just ended" announcements change info but bring nothing
               // to catch up on, so they don't move.
               if (update.isOngoing) {
                 bumpToFront(update.id);
               }
               updateCount++;
             } else {
               updateItem(update.id, { lastCheckedAt: now });
             }
          }
        });

        if (updateCount > 0) {
          toast.info(t('app.updated_tracking_info', { count: updateCount }));
        }
      }
    };

    // Small delay to ensure store is hydrated if initialize is async
    const timer = setTimeout(refreshUpdates, 1000);
    return () => clearTimeout(timer);
  }, [initialized]); // Re-runs only when the store becomes ready.

  return (
    <HashRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route 
            path="/collection" 
            element={
              <ProtectedRoute>
                <CollectionPage />
              </ProtectedRoute>
            } 
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/characters"
            element={
              <ProtectedRoute>
                <CharactersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/characters/:characterId"
            element={
              <ProtectedRoute>
                <CharacterChatPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </Layout>

      <ToastContainer
          aria-label={t('common.notifications')}
          position="bottom-right" 
          autoClose={3000} 
          hideProgressBar={false}
          newestOnTop
          closeOnClick
          rtl={false}
          pauseOnFocusLoss
          draggable
          pauseOnHover
          theme="colored"
      />
    </HashRouter>
  );
};

export default App;
