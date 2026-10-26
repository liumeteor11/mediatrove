import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';

export type Theme = 'doraemon' | 'cyberpunk' | 'scandinavian';

const VALID_THEMES: Theme[] = ['doraemon', 'cyberpunk', 'scandinavian'];

// Persisted or backend-stored values may predate theme removals (e.g. the old
// 'gradient' theme); sanitize them so the CSS variables always resolve.
export const sanitizeTheme = (value: unknown): Theme =>
  VALID_THEMES.includes(value as Theme) ? (value as Theme) : 'doraemon';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  initialize: () => Promise<void>;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'doraemon',
      setTheme: (theme) => set({ theme: sanitizeTheme(theme) }),
      initialize: async () => {
        const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));
        if (!isTauri) return;
        try {
            const [_, themeConfig] = await invoke<[any, any]>('get_app_configs');
            if (themeConfig && themeConfig.theme) {
                set({ theme: sanitizeTheme(themeConfig.theme) });
            }
        } catch (e) {
            console.error("Failed to load Theme config from backend", e);
        }
      }
    }),
    {
      name: 'media-tracker-theme',
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as { theme?: unknown };
        return { ...current, theme: sanitizeTheme(stored.theme) };
      },
    }
  )
);

// Auto-save to backend
useThemeStore.subscribe((state) => {
    const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));
    if (isTauri) {
        invoke('save_theme_config', { config: { theme: state.theme } }).catch(e => console.error("Failed to save theme config", e));
    }
});
