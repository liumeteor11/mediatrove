import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import CryptoJS from 'crypto-js';
import { AIIOLogEntry, SearchDiagnostics } from '../types/types';
import type { ReasoningLevel } from '../services/modelCatalog';

// Simple encryption key (In a real app, this should not be hardcoded or should be user-provided)
// For this requirement, we use a static key to satisfy "encrypted storage" vs plain text in localStorage
const SECRET_KEY = import.meta.env.VITE_SECRET_KEY || 'media-tracker-ai-config-secret';


export type AIProvider = 'moonshot' | 'openai' | 'deepseek' | 'qwen' | 'google' | 'mistral' | 'mimo' | 'zhipu' | 'custom';
export type SearchProvider = 'google' | 'serper' | 'yandex' | 'duckduckgo';

// Trending recommendation modes for the search landing page:
// - 'recent':     time-based preset — hottest / highest-rated works of the last 3 months
// - 'preference': analyze the user's collection to infer taste, recommend related works
// - 'custom':     user-authored prompt (trendingPrompt)
export type TrendingMode = 'recent' | 'preference' | 'custom';

interface AIConfigState {
  provider: AIProvider;
  apiKey: string;
  /** Provider the stored key was last saved with; used to flag provider switches that invalidate it. */
  apiKeyProvider: AIProvider | '';
  model: string;
  baseUrl: string;
  maxTokens: number;
  systemPrompt: string;
  // Search Configuration
  enableSearch: boolean;
  searchProvider: SearchProvider;
  googleSearchApiKey: string;
  googleSearchCx: string;
  serperApiKey: string;
  yandexSearchApiKey: string;
  yandexSearchLogin: string;
  omdbApiKey: string;
  tmdbApiKey: string;
  bangumiToken: string;
  enableTmdb: boolean;
  enableBangumi: boolean;
  enableNetworking: boolean;
  reasoningEffort: ReasoningLevel;
  enableTrending: boolean;
  trendingMode: TrendingMode;
  trendingPrompt: string;
  lastSearchDurationMs: number | null;
  lastSearchAt: string | null;
  lastSearchQuery: string | null;
  enableSearchDiagnostics: boolean;
  lastSearchDiagnostics: SearchDiagnostics | null;
  authoritativeDomains: {
    movie_tv: string[];
    book: string[];
    comic: string[];
    music: string[];
    poster: string[];
  };
  
  // Proxy Configuration
  useSystemProxy: boolean;
  proxyProtocol: 'http' | 'socks5';
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  proxyPassword: string;
  
  // Cache for trending media to allow "partial" updates
  trendingCache: any[];
  setTrendingCache: (items: any[]) => void;
  setAuthoritativeDomains: (domains: Partial<AIConfigState['authoritativeDomains']>) => void;
  addDomain: (type: 'movie_tv' | 'book' | 'comic' | 'music' | 'poster', domain: string) => void;
  removeDomain: (type: 'movie_tv' | 'book' | 'comic' | 'music' | 'poster', domain: string) => void;
  
  setProvider: (provider: AIProvider) => void;
  setConfig: (config: Partial<Omit<AIConfigState, 'setProvider' | 'setConfig' | 'getDecryptedApiKey' | 'getDecryptedGoogleKey' | 'getDecryptedSerperKey' | 'getDecryptedYandexKey' | 'getDecryptedOmdbKey' | 'getDecryptedTmdbKey' | 'getDecryptedBangumiToken'>>) => void;
  getDecryptedApiKey: () => string;
  getDecryptedGoogleKey: () => string;
  getDecryptedSerperKey: () => string;
  getDecryptedYandexKey: () => string;
  getDecryptedOmdbKey: () => string;
  getDecryptedTmdbKey: () => string;
  getDecryptedBangumiToken: () => string;
  getProxyUrl: () => string;
  logs: AIIOLogEntry[];
  appendLog: (entry: AIIOLogEntry) => void;
  clearLogs: () => void;
  initialize: () => Promise<void>;
}

const encrypt = (text: string) => {
  if (!text) return '';
  return CryptoJS.AES.encrypt(text, SECRET_KEY).toString();
};

const decrypt = (ciphertext: string) => {
  if (!ciphertext) return '';
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    return '';
  }
};

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful media encyclopedia and curator.
When searching or recommending, you must return a VALID JSON array of objects.
Do not wrap the JSON in markdown code blocks. Just return the raw JSON array.
Each object must have the following fields:
- title: string
- directorOrAuthor: string
- cast: string[] (max 5 main actors, empty for books if not applicable)
- description: string (approx 150 words, covering theme and background)
- releaseDate: string (YYYY-MM-DD preferred, or YYYY)
- type: one of ["Book", "Movie", "TV Series", "Comic", "Short Drama", "Other"]
- isOngoing: boolean
- latestUpdateInfo: string (empty if completed)
- rating: string (e.g. "8.5/10")

Ensure data is accurate.`;

export const useAIStore = create<AIConfigState>()(
  persist(
    (set, get) => ({
      provider: 'moonshot',
      apiKey: '', // Stores encrypted key
      apiKeyProvider: '',
      model: 'kimi-k3',
      baseUrl: 'https://api.moonshot.cn/v1',
      maxTokens: 2000,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      enableSearch: true,
      searchProvider: 'google',
      googleSearchApiKey: '',
      googleSearchCx: '',
      serperApiKey: '',
      yandexSearchApiKey: '',
      yandexSearchLogin: '',
      omdbApiKey: '',
      tmdbApiKey: '',
      bangumiToken: '',
      enableTmdb: true,
      enableBangumi: true,
      enableNetworking: true,
      reasoningEffort: 'auto',
      enableTrending: true,
      trendingMode: 'recent',
      trendingPrompt: '',
      lastSearchDurationMs: null,
      lastSearchAt: null,
      lastSearchQuery: null,
      enableSearchDiagnostics: true,
      lastSearchDiagnostics: null,
      authoritativeDomains: {
        movie_tv: ['imdb.com','themoviedb.org','tvmaze.com','wikipedia.org','zh.wikipedia.org','douban.com'],
        book: ['goodreads.com','wikipedia.org','zh.wikipedia.org','douban.com'],
        comic: ['bgm.tv','bangumi.tv','wikipedia.org','zh.wikipedia.org'],
        music: ['discogs.com','musicbrainz.org','wikipedia.org','zh.wikipedia.org'],
        poster: ['moviepostersgallery.com','impawards.com','goldposter.com']
      },
      useSystemProxy: true,
      proxyProtocol: 'http',
      proxyHost: '',
      proxyPort: '',
      proxyUsername: '',
      proxyPassword: '',
      trendingCache: [],
      logs: [],
      
      setTrendingCache: (items) => set({ trendingCache: items }),
      setAuthoritativeDomains: (domains) => {
        const current = get().authoritativeDomains;
        set({ authoritativeDomains: { ...current, ...domains } });
      },
      addDomain: (type, domain) => {
        const raw = domain.trim().replace(/^site:/i,'');
        if (!raw) return;
        let d = raw.toLowerCase();
        if (d.includes('://')) {
          try {
            const u = new URL(raw);
            d = (u.hostname || '').toLowerCase();
          } catch {}
        }
        d = d.replace(/^www\./,'').split('/')[0].trim();
        if (!d) return;
        const cur = get().authoritativeDomains;
        const arr = cur[type] || [];
        if (arr.includes(d)) return;
        const next = { ...cur, [type]: [...arr, d] };
        set({ authoritativeDomains: next });
      },
      removeDomain: (type, domain) => {
        const raw = domain.trim().replace(/^site:/i,'');
        if (!raw) return;
        let d = raw.toLowerCase();
        if (d.includes('://')) {
          try {
            const u = new URL(raw);
            d = (u.hostname || '').toLowerCase();
          } catch {}
        }
        d = d.replace(/^www\./,'').split('/')[0].trim();
        const cur = get().authoritativeDomains;
        const arr = cur[type] || [];
        const next = { ...cur, [type]: arr.filter(x => x !== d) };
        set({ authoritativeDomains: next });
      },

      setProvider: (provider) => {
        let defaultBaseUrl = '';
        let defaultModel = '';
        
        switch (provider) {
          case 'moonshot':
            defaultBaseUrl = 'https://api.moonshot.cn/v1';
            defaultModel = 'kimi-k3';
            break;
          case 'openai':
            defaultBaseUrl = 'https://api.openai.com/v1';
            defaultModel = 'gpt-5.6-terra';
            break;
          case 'deepseek':
            defaultBaseUrl = 'https://api.deepseek.com';
            defaultModel = 'deepseek-v4-pro';
            break;
          case 'qwen':
            defaultBaseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
            defaultModel = 'qwen3.8-max';
            break;
          case 'google':
            defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';
            defaultModel = 'gemini-3.8-flash';
            break;
          case 'mistral':
            defaultBaseUrl = 'https://api.mistral.ai/v1';
            defaultModel = 'mistral-large-latest';
            break;
          case 'mimo':
            defaultBaseUrl = 'https://api.xiaomimimo.com/v1';
            defaultModel = 'mimo-v2.6-pro';
            break;
          case 'zhipu':
            defaultBaseUrl = 'https://open.bigmodel.cn/api/paas/v4';
            defaultModel = 'glm-5.3';
            break;
          case 'custom':
            defaultBaseUrl = '';
            defaultModel = '';
            break;
        }
        
        set((state) => ({ 
            provider, 
            baseUrl: defaultBaseUrl || state.baseUrl, 
            model: defaultModel || state.model 
        }));
      },
      setConfig: (config) => {
        const state = get();
        const updates: any = { ...config };
        const sanitizeBaseUrl = (url: string) => {
          if (!url) return '';
          return url.trim().replace(/[\s)]+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
        };
        
        // Encrypt keys if they are being updated. An explicitly empty key clears
        // it (and the provider it was saved for); keys are per provider, so a
        // provider switch does not silently re-use the previous one.
        if (typeof config.apiKey !== 'undefined') {
          updates.apiKey = config.apiKey ? encrypt(config.apiKey) : '';
          updates.apiKeyProvider = config.apiKey ? (config.provider ?? state.provider) : '';
        }
        if (config.googleSearchApiKey) updates.googleSearchApiKey = encrypt(config.googleSearchApiKey);
        if (config.serperApiKey) updates.serperApiKey = encrypt(config.serperApiKey);
        if (config.yandexSearchApiKey) updates.yandexSearchApiKey = encrypt(config.yandexSearchApiKey);
        if (config.omdbApiKey) updates.omdbApiKey = encrypt(config.omdbApiKey);
        if (config.tmdbApiKey) updates.tmdbApiKey = encrypt(config.tmdbApiKey);
        if (config.bangumiToken) updates.bangumiToken = encrypt(config.bangumiToken);
        if (config.proxyPassword) updates.proxyPassword = encrypt(config.proxyPassword);
        
        if (typeof config.baseUrl !== 'undefined') {
          updates.baseUrl = sanitizeBaseUrl(config.baseUrl || '');
        }
        set((state) => ({ ...state, ...updates }));
      },
      getDecryptedApiKey: () => decrypt(get().apiKey),
      getDecryptedGoogleKey: () => decrypt(get().googleSearchApiKey),
      getDecryptedSerperKey: () => decrypt(get().serperApiKey),
      getDecryptedYandexKey: () => decrypt(get().yandexSearchApiKey),
      getDecryptedOmdbKey: () => decrypt(get().omdbApiKey),
      getDecryptedTmdbKey: () => decrypt(get().tmdbApiKey),
      getDecryptedBangumiToken: () => decrypt(get().bangumiToken),
      // Helper getters
      // Note: username stored in plain (non-sensitive), password encrypted
      getProxyUrl: (): string => {
        const s = get();
        if (!s.proxyHost || !s.proxyPort) return '';
        const proto = s.proxyProtocol || 'http';
        const user = s.proxyUsername?.trim();
        const pass = decrypt(s.proxyPassword);
        const auth = user ? `${encodeURIComponent(user)}${pass ? ':' + encodeURIComponent(pass) : ''}@` : '';
        return `${proto}://${auth}${s.proxyHost}:${s.proxyPort}`;
      },
      appendLog: (entry: AIIOLogEntry) => {
        const current = get().logs || [];
        const next = [entry, ...current].slice(0, 200);
        set({ logs: next });
      },
      clearLogs: () => set({ logs: [] }),
      initialize: async () => {
        const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));
        if (!isTauri) return;
        try {
            const [aiConfig, _] = await invoke<[any, any]>('get_app_configs');
            if (aiConfig) {
                const hasLocal = (() => {
                  try {
                    if (typeof window === 'undefined' || !window.localStorage) return false;
                    const raw = window.localStorage.getItem('ai-config-storage');
                    if (!raw) return false;
                    const parsed = JSON.parse(raw);
                    return !!(parsed && typeof parsed === 'object' && parsed.state);
                  } catch {
                    return false;
                  }
                })();
                set(state => (hasLocal ? { ...aiConfig, ...state } : { ...state, ...aiConfig }));
            }
        } catch (e) {
            console.error("Failed to load AI config from backend", e);
        }
      }
    }),
    {
      name: 'ai-config-storage',
      version: 8,
      storage: createJSONStorage(() => {
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            const k = '__ai_store_test__';
            window.localStorage.setItem(k, '1');
            window.localStorage.removeItem(k);
            return window.localStorage;
          }
        } catch {}
        const mem: Record<string, string> = {};
        return {
          getItem: (name: string) => (name in mem ? mem[name] : null),
          setItem: (name: string, value: string) => { mem[name] = value; },
          removeItem: (name: string) => { delete mem[name]; }
        } as any;
      }),
      migrate: (persistedState: any, version: number) => {
        try {
          if (persistedState && typeof persistedState === 'object') {
            const sanitizeBaseUrl = (url: string) => {
              if (!url) return '';
              return url.trim().replace(/[\s)]+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
            };
            persistedState.baseUrl = sanitizeBaseUrl(persistedState.baseUrl || '');
            if (persistedState.searchProvider === 'duckduckgo') {
              persistedState.searchProvider = 'google';
            }
            if (persistedState.searchProvider === 'metaso') {
              persistedState.searchProvider = 'google';
            }
            if ('metasoApiKey' in persistedState) {
              try { delete persistedState.metasoApiKey; } catch {}
            }
            const prov = persistedState.provider;
            const url: string = persistedState.baseUrl || '';
            const ensureV1 = (u: string) => u.endsWith('/v1') || u.includes('/v1/') ? u : (u.endsWith('/') ? `${u}v1` : `${u}/v1`);
            if (prov === 'deepseek' && url && !url.includes('/openai/')) {
              if (url.includes('api.deepseek.com')) {
                persistedState.baseUrl = 'https://api.deepseek.com';
              } else {
                persistedState.baseUrl = ensureV1(url);
              }
            }
            if (prov === 'openai' && url && !url.includes('/openai/')) {
              persistedState.baseUrl = ensureV1(url);
            }
            if (prov === 'mistral' && url && !url.includes('/openai/')) {
              persistedState.baseUrl = ensureV1(url);
            }
            if (prov === 'moonshot' && url && !url.includes('/openai/')) {
              persistedState.baseUrl = ensureV1(url);
            }
            if (prov === 'moonshot' && (persistedState.model === 'kimi-latest' || persistedState.model === 'moonshot-v1-128k' || persistedState.model === 'kimi-k2-thinking-preview')) {
              persistedState.model = 'kimi-k3';
            }
            if (prov === 'deepseek' && (persistedState.model === 'deepseek-chat' || persistedState.model === 'deepseek-reasoner')) {
              persistedState.model = 'deepseek-v4-flash';
            }
            if (prov === 'openai' && (persistedState.model === 'gpt-4o' || persistedState.model === 'gpt-4.1' || persistedState.model === 'gpt-4.1-mini')) {
              persistedState.model = 'gpt-5.6-terra';
            }
            if (prov === 'openai' && (persistedState.model === 'gpt-3.5-turbo' || persistedState.model === 'gpt-4')) {
              persistedState.model = 'gpt-5.6-luna';
            }
            if (prov === 'qwen' && persistedState.model === 'qwen3-235b-a22b') {
              persistedState.model = 'qwen3.7-max';
            }
            // v7: graduate the 3.8 preview to the 0902 flagship; retire sunset models.
            if (prov === 'qwen' && persistedState.model === 'qwen3.8-max-preview') {
              persistedState.model = 'qwen3.8-max';
            }
            if (prov === 'qwen' && persistedState.model === 'qwen3.6-flash') {
              persistedState.model = 'qwen3.7-flash';
            }
            if (prov === 'google' && (persistedState.model === 'gemini-2.0-flash' || persistedState.model === 'gemini-2.0-flash-lite' || persistedState.model === 'gemini-2.5-flash' || persistedState.model === 'gemini-2.5-flash-lite')) {
              persistedState.model = 'gemini-3.6-flash';
            }
            if (prov === 'google' && (persistedState.model === 'gemini-2.5-pro' || persistedState.model === 'gemini-3.5-flash-lite')) {
              persistedState.model = persistedState.model === 'gemini-2.5-pro' ? 'gemini-3.1-pro' : 'gemini-3.8-flash-lite';
            }
            if (prov === 'mimo' && (persistedState.model === 'mimo-v2-pro' || persistedState.model === 'mimo-v2-flash' || persistedState.model === 'mimo-v2-omni')) {
              persistedState.model = 'mimo-v2.5-pro';
            }
            if (prov === 'mimo' && (persistedState.model === 'mimo-v2.5-pro' || persistedState.model === 'mimo-v2.5-pro-ultraspeed' || persistedState.model === 'mimo-v2.5')) {
              persistedState.model = persistedState.model === 'mimo-v2.5' ? 'mimo-v2.6-flash' : 'mimo-v2.6-pro';
            }
            if (prov === 'zhipu' && persistedState.model === 'glm-4.7') {
              persistedState.model = 'glm-5.1';
            }
            if (typeof persistedState.enableSearchDiagnostics !== 'boolean') {
              persistedState.enableSearchDiagnostics = true;
            }
            // v8: remember which provider the key belongs to. Legacy states keep
            // '' = unknown, so the panel asks for a connection test instead of
            // assuming the key matches the currently selected provider.
            if (typeof persistedState.apiKeyProvider !== 'string') {
              persistedState.apiKeyProvider = '';
            }
            if (!('lastSearchDiagnostics' in persistedState)) {
              persistedState.lastSearchDiagnostics = null;
            }
            // v6: replace the dead enableDeepThinking switch with reasoningEffort.
            if (typeof persistedState.reasoningEffort !== 'string') {
              persistedState.reasoningEffort = persistedState.enableDeepThinking === true ? 'high' : 'auto';
            }
            try { delete persistedState.enableDeepThinking; } catch {}
          }
        } catch {}
        return persistedState;
      },
      partialize: (state) => ({ 
        provider: state.provider,
        apiKey: state.apiKey, 
        apiKeyProvider: state.apiKeyProvider,
        model: state.model,
        baseUrl: state.baseUrl,
        maxTokens: state.maxTokens,
        systemPrompt: state.systemPrompt,
        enableSearch: state.enableSearch,
        searchProvider: state.searchProvider,
        googleSearchApiKey: state.googleSearchApiKey,
        googleSearchCx: state.googleSearchCx,
        serperApiKey: state.serperApiKey,
        yandexSearchApiKey: state.yandexSearchApiKey,
        yandexSearchLogin: state.yandexSearchLogin,
        omdbApiKey: state.omdbApiKey,
        tmdbApiKey: state.tmdbApiKey,
        bangumiToken: state.bangumiToken,
        enableTmdb: state.enableTmdb,
        enableBangumi: state.enableBangumi,
        enableNetworking: state.enableNetworking,
        reasoningEffort: state.reasoningEffort,
        enableTrending: state.enableTrending,
        trendingMode: state.trendingMode,
        trendingPrompt: state.trendingPrompt,
        lastSearchDurationMs: state.lastSearchDurationMs,
        lastSearchAt: state.lastSearchAt,
        lastSearchQuery: state.lastSearchQuery,
        enableSearchDiagnostics: state.enableSearchDiagnostics,
        lastSearchDiagnostics: state.lastSearchDiagnostics,
        authoritativeDomains: state.authoritativeDomains,
        useSystemProxy: state.useSystemProxy,
        proxyProtocol: state.proxyProtocol,
        proxyHost: state.proxyHost,
        proxyPort: state.proxyPort,
        proxyUsername: state.proxyUsername,
        proxyPassword: state.proxyPassword
      }),
    }
  )
);

// Auto-save to backend
useAIStore.subscribe((state) => {
    // Check for Tauri environment
    const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));
    if (isTauri) {
         const config = {
             provider: state.provider,
             apiKey: state.apiKey,
             model: state.model,
             baseUrl: state.baseUrl,
             maxTokens: state.maxTokens,
             systemPrompt: state.systemPrompt,
             enableSearch: state.enableSearch,
             searchProvider: state.searchProvider,
             googleSearchApiKey: state.googleSearchApiKey,
             googleSearchCx: state.googleSearchCx,
             serperApiKey: state.serperApiKey,
             yandexSearchApiKey: state.yandexSearchApiKey,
             yandexSearchLogin: state.yandexSearchLogin,
             omdbApiKey: state.omdbApiKey,
             tmdbApiKey: state.tmdbApiKey,
             bangumiToken: state.bangumiToken,
             enableTmdb: state.enableTmdb,
             enableBangumi: state.enableBangumi,
             enableNetworking: state.enableNetworking,
             reasoningEffort: state.reasoningEffort,
             enableTrending: state.enableTrending,
             trendingMode: state.trendingMode,
             trendingPrompt: state.trendingPrompt,
             useSystemProxy: state.useSystemProxy,
             proxyProtocol: state.proxyProtocol,
             proxyHost: state.proxyHost,
             proxyPort: state.proxyPort,
             proxyUsername: state.proxyUsername,
             proxyPassword: state.proxyPassword,
             authoritativeDomains: state.authoritativeDomains
         };
         invoke('save_ai_config', { config }).catch(e => console.error("Failed to save AI config to backend", e));
    }
});
