import { searchTMDB, getTMDBDetails, getTMDBPosterUrl } from './tmdbService';
import { searchBangumi } from './bangumiService';
import { usePluginStore } from '../store/usePluginStore';
import { PluginExecutor } from './pluginService';
import OpenAI from "openai";
import { MediaType, MediaItem, SearchDiagnostics } from "../types/types";
import { v4 as uuidv4 } from 'uuid';
import { useAIStore } from "../store/useAIStore";
import { useCollectionStore } from "../store/useCollectionStore";
import i18n from '../i18n';
import type { AIProvider, TrendingMode } from '../store/useAIStore';
import { buildRequestExtras, getModelCapabilities, getNativeSearchTools } from './modelCatalog';
import { invoke } from "@tauri-apps/api/core";
import { toast } from 'react-toastify';

// Define Window interface to include Tauri API check
declare global {
  interface Window {
    __TAURI__?: any;
  }
}

let lastQuotaErrorTs = 0;
const showQuotaError = (msg: string) => {
    if (msg.includes("Quota Exceeded") || msg.includes("429")) {
        const now = Date.now();
        if (now - lastQuotaErrorTs > 60000) {
            toast.error(i18n.t('ai_config.search_quota_exceeded', { defaultValue: "Google Search Quota Exceeded. Please check your API key billing/quota." }));
            lastQuotaErrorTs = now;
        }
    }
};

const isTauriEnv = typeof window !== 'undefined' && (
  ('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window) ||
  (typeof window.location !== 'undefined' && (
    window.location.protocol === 'tauri:' ||
    (typeof window.location.origin === 'string' && window.location.origin.startsWith('http://tauri.localhost'))
  ))
);

type TauriSearchProvider = 'google' | 'serper' | 'yandex' | 'duckduckgo';

const isUnsupportedParamError = (e: any): boolean => {
    const status = e?.status ?? e?.response?.status;
    const msg = String(e?.message || e?.error?.message || '');
    return status === 400 || status === 422 ||
        /(^|\D)400(\D|$)/.test(msg) || /(^|\D)422(\D|$)/.test(msg) ||
        /unsupported|not support|unknown (parameter|field|argument)|invalid (parameter|field|argument)/i.test(msg);
};

const normalizeTauriSearchProvider = (sp: any): TauriSearchProvider => {
  const v = String(sp || '').toLowerCase();
  return (v === 'google' || v === 'serper' || v === 'yandex') ? (v as any) : 'duckduckgo';
};

const resolveTauriSearchProviderList = (input: {
  provider: any;
  googleKey?: string;
  googleCx?: string;
  serperKey?: string;
  yandexKey?: string;
  yandexUser?: string;
}): Array<{ provider: TauriSearchProvider; apiKey?: string; cx?: string; user?: string }> => {
  const clean = (v?: string): string | undefined => {
    const s = (v ?? '').trim();
    if (!s) return undefined;
    const l = s.toLowerCase();
    if (l === 'undefined' || l === 'null') return undefined;
    return s;
  };

  const requested = normalizeTauriSearchProvider(input.provider);
  const googleKey = clean(input.googleKey);
  const googleCx = clean(input.googleCx);
  const serperKey = clean(input.serperKey);
  const yandexKey = clean(input.yandexKey);
  const yandexUser = clean(input.yandexUser);

  // The user's selected engine always goes first; the remaining configured
  // engines follow as fallbacks (Google before Serper/Yandex), with keyless
  // DuckDuckGo always last.
  const candidates: TauriSearchProvider[] = [requested, 'google', 'serper', 'yandex', 'duckduckgo'];
  const uniq = Array.from(new Set(candidates));

  const out: Array<{ provider: TauriSearchProvider; apiKey?: string; cx?: string; user?: string }> = [];
  
  // Helper to split keys
  const splitKeys = (k?: string) => (k || '').split(/[;；]/).map(x => x.trim()).filter(x => x);

  for (const p of uniq) {
    if (p === 'google') {
      if (googleKey && googleCx) {
         const keys = splitKeys(googleKey);
         keys.forEach(k => out.push({ provider: 'google', apiKey: k, cx: googleCx }));
      }
      continue;
    }
    if (p === 'serper') {
      if (serperKey) {
         const keys = splitKeys(serperKey);
         keys.forEach(k => out.push({ provider: 'serper', apiKey: k }));
      }
      continue;
    }
    if (p === 'yandex') {
      if (yandexKey && yandexUser) {
         const keys = splitKeys(yandexKey);
         keys.forEach(k => out.push({ provider: 'yandex', apiKey: k, user: yandexUser }));
      }
      continue;
    }
    out.push({ provider: 'duckduckgo' });
  }

  if (out.length === 0) return [{ provider: 'duckduckgo' }];
  return out;
};

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit & { timeoutMs?: number } = {}) => {
  const ms = init.timeoutMs ?? 10000;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort('timeout'), ms);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
};

const searchCache = new Map<string, { ts: number; data: any }>();
const CACHE_TTL = 1000 * 60 * 60 * 2; // 2 hours
const testConnectionCache = new Map<string, { ts: number; res: any }>();
const TEST_CACHE_TTL = 60 * 1000; // 1 minute

// Simple Semaphore to limit concurrent API calls
class Semaphore {
    private max: number;
    private counter: number;
    private waiting: { resolve: () => void, reject: (err: any) => void }[];

    constructor(max: number) {
        this.max = max;
        this.counter = 0;
        this.waiting = [];
    }

    acquire() {
        if (this.counter < this.max) {
            this.counter++;
            return Promise.resolve();
        } else {
            return new Promise<void>((resolve, reject) => {
                this.waiting.push({ resolve, reject });
            });
        }
    }

    release() {
        this.counter--;
        if (this.waiting.length > 0) {
            this.counter++;
            const { resolve } = this.waiting.shift()!;
            resolve();
        }
    }
}

// Limit concurrent requests to avoid rate limits
const apiLimiter = new Semaphore(4);
const searchLimiter = new Semaphore(6);

const OMDB_API_KEY = import.meta.env.VITE_OMDB_API_KEY;

const FALLBACK_POSTER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900" data-placeholder="mediatrove-placeholder"><rect width="600" height="900" fill="#1a1a1a"/></svg>';
export const FALLBACK_POSTER = `data:image/svg+xml;utf8,${encodeURIComponent(FALLBACK_POSTER_SVG)}`;

const getPlaceholder = (type: string = 'Media') => {
  return FALLBACK_POSTER;
};

const normalizeImageUrl = (value: any): string | undefined => {
  let s = String(value ?? '').trim();
  if (!s) return undefined;
  s = s
    .replace(/^[<("'“‘\[]+/g, '')
    .replace(/[>"'”’\].,;:)]+$/g, '')
    .trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (lower === 'n/a' || lower === 'na' || lower === 'null' || lower === 'undefined') return undefined;
  if (lower.startsWith('x-raw-image')) return undefined;
  if (lower.includes('moviepostersgallery.com/wp-content/uploads/2020/08/movie-posters-gallery_social.jpg')) return undefined;
  if (lower.includes('m.media-amazon.com/')) return undefined;
  if (lower.includes('i.ebayimg.com/') || lower.includes('ebayimg.com/')) return undefined;
  if (lower.startsWith('data:') || lower.startsWith('blob:')) return s;
  if (lower.startsWith('http://') || lower.startsWith('https://')) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return `https://${s}`;
  return s;
};

export const isPlaceholderPosterUrl = (value?: string): boolean => {
  const s = String(value ?? '').trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  if (s === FALLBACK_POSTER) return true;
  if (lower.startsWith('x-raw-image')) return true;
  if (lower.includes('moviepostersgallery.com/wp-content/uploads/2020/08/movie-posters-gallery_social.jpg')) return true;
  if (lower.includes('placehold.co') || lower.includes('no+image') || lower.includes('image+error')) return true;
  if (lower.includes('mediatrove-placeholder')) return true;
  if (lower.includes('m.media-amazon.com/')) return true;
  if (lower.includes('i.ebayimg.com/') || lower.includes('ebayimg.com/')) return true;
  return false;
};

const isBlockedPosterUrl = (value?: string): boolean => {
  return isPlaceholderPosterUrl(value);
};

const FRANCHISE_ALIASES: Record<string, string[]> = {
  '疯狂动物城': ['动物方城市', 'Zootopia', 'Zootropolis'],
  'Zootopia': ['疯狂动物城', 'Zootropolis'],
  'Zootropolis': ['Zootopia', '疯狂动物城'],
  '速度与激情': ['速激', 'Fast & Furious', 'The Fast and the Furious'],
  'Fast & Furious': ['Fast and Furious', 'The Fast and the Furious', '速度与激情', '速激'],
  '复仇者联盟': ["Avengers", "Marvel's The Avengers"],
  'Avengers': ['复仇者联盟', "Marvel's The Avengers"],
  '哈利·波特': ['哈利波特', 'Harry Potter'],
  'Harry Potter': ['哈利·波特', '哈利波特'],
  '蜘蛛侠': ['Spiderman', 'Spider-Man'],
  'Spider-Man': ['蜘蛛侠', 'Spiderman'],
  '玩具总动员': ['Toy Story'],
  'Toy Story': ['玩具总动员']
};

const prefetchedImages = new Map<string, string>();

type PosterCacheEntry = { candidates: string[]; preferred?: string; ts: number };
export type PosterSearchResult = { picked?: string; candidates: string[] };
const POSTER_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
let posterCacheStore: Record<string, PosterCacheEntry> | null = null;

const normalizePosterKey = (v: any) => String(v ?? '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '');
const makePosterCacheKey = (title: string, year: string, type: string) => {
  const y = String(year || '').trim().slice(0, 4);
  const yKey = /^\d{4}$/.test(y) ? y : '';
  const t = normalizePosterKey(type || '');
  const n = normalizePosterKey(title || '');
  return `${t}|${n}|${yKey}`;
};

const readPosterCacheStore = () => {
  if (posterCacheStore) return posterCacheStore;
  try {
    const raw = localStorage.getItem('media_tracker_poster_cache_v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        posterCacheStore = parsed;
        return posterCacheStore;
      }
    }
  } catch {}
  posterCacheStore = {};
  return posterCacheStore;
};

const writePosterCacheStore = (store: Record<string, PosterCacheEntry>) => {
  posterCacheStore = store;
  try {
    localStorage.setItem('media_tracker_poster_cache_v1', JSON.stringify(store));
  } catch {}
};

const getPosterCacheEntry = (key: string): PosterCacheEntry | undefined => {
  const store = readPosterCacheStore();
  const entry = store[key];
  if (!entry) return undefined;
  if (Date.now() - (entry.ts || 0) > POSTER_CACHE_TTL) return undefined;
  return entry;
};

const updatePosterCacheEntry = (key: string, entry: PosterCacheEntry) => {
  const store = readPosterCacheStore();
  store[key] = entry;
  writePosterCacheStore(store);
};

const updatePosterCandidates = (key: string, incoming: string[], preferred?: string) => {
  const existing = getPosterCacheEntry(key);
  const base = existing?.candidates || [];
  const merged = [...base, ...incoming]
    .map(u => normalizeImageUrl(u))
    .filter((u): u is string => !!u && !isBlockedPosterUrl(u));
  const uniq = Array.from(new Set(merged));
  const limited = uniq.slice(0, 8);
  const next: PosterCacheEntry = {
    candidates: limited,
    preferred: preferred || existing?.preferred,
    ts: Date.now()
  };
  updatePosterCacheEntry(key, next);
};

const getPosterCandidates = (key: string) => getPosterCacheEntry(key)?.candidates || [];
const getPreferredPoster = (key: string) => getPosterCacheEntry(key)?.preferred;
const setPreferredPoster = (key: string, url: string) => {
  if (!url || isBlockedPosterUrl(url)) return;
  const existing = getPosterCacheEntry(key);
  const next: PosterCacheEntry = {
    candidates: existing?.candidates || [],
    preferred: url,
    ts: Date.now()
  };
  updatePosterCacheEntry(key, next);
};

const checkImage = async (url: string): Promise<boolean> => {
    if (!url) return false;
    return new Promise((resolve) => {
        const img = new Image();
        let timer: any = null;
        img.onload = () => {
            if (timer) clearTimeout(timer);
            resolve(true);
        };
        img.onerror = () => {
            if (timer) clearTimeout(timer);
            resolve(false);
        };
        timer = setTimeout(() => {
            img.src = "";
            resolve(false);
        }, 5000);
        img.src = url;
    });
};

const fetchPosterFromOMDB = async (title: string, year: string): Promise<string | undefined> => {
  const s = useAIStore.getState();
  const key = (s.getDecryptedOmdbKey && s.getDecryptedOmdbKey()) || OMDB_API_KEY;
  if (!key) return undefined;
  try {
    const cleanYear = year ? year.split('-')[0].trim() : '';
    const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&y=${cleanYear}&apikey=${key}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.Response === "True" && data.Poster && data.Poster !== "N/A") {
      const poster = normalizeImageUrl(data.Poster);
      if (!poster) return undefined;
      const isValid = await checkImage(poster);
      if (isValid) return poster;
    }
  } catch (error) { console.warn("OMDB fetch failed", error); }
  return undefined;
};

const isSafeContent = (_text: string): boolean => true;

export const performClientSideSearch = async (
    query: string,
    force: boolean = false,
    preferredType?: MediaType | 'All'
): Promise<string> => {
    const {
        enableSearch,
        searchProvider,
        getDecryptedGoogleKey,
        googleSearchCx,
        getDecryptedSerperKey,
        getDecryptedYandexKey,
        yandexSearchLogin
    } = useAIStore.getState();

    if (!enableSearch && !force) return "";

    // Web mode has no Rust proxy path, so engines are tried directly: the
    // user's selected engine first, then Google, then Serper, with the keyless
    // DuckDuckGo block below as the last resort.
    const googleReady = !!(getDecryptedGoogleKey() || '').trim() && !!(googleSearchCx || '').trim();
    const serperReady = !!(getDecryptedSerperKey() || '').trim();
    const serperFirst = searchProvider === 'serper' && serperReady;
    let triedGoogle = false;
    let triedSerper = false;

    try {
        const isChinese = i18n.language.startsWith('zh');
        const shortOrNumeric = query.trim().length < 3 || /^[0-9\s]+$/.test(query.trim());
        const base = query.trim();

        const inferType = (): MediaType | 'All' => {
            if (preferredType) return preferredType as MediaType | 'All';
            const l = base.toLowerCase();
            const zhMovieTv = ['电影','电视剧','短剧','第','季','集'];
            const enMovieTv = ['movie','film','tv series','season','episode','s1','s2','s3'];
            const zhBook = ['小说','书','书籍'];
            const enBook = ['novel','book'];
            const zhComic = ['漫画'];
            const enComic = ['comic','manga'];
            const zhMusic = ['专辑','音乐'];
            const enMusic = ['album','music'];
            const hasAny = (arr: string[]) => arr.some(k => l.includes(k));
            if (hasAny(isChinese ? zhMovieTv : enMovieTv)) return MediaType.TV_SERIES; // prefer series when season cues present
            if (hasAny(['movie','film','电影'])) return MediaType.MOVIE;
            if (hasAny(isChinese ? zhBook : enBook)) return MediaType.BOOK;
            if (hasAny(isChinese ? zhComic : enComic)) return MediaType.COMIC;
            if (hasAny(isChinese ? zhMusic : enMusic)) return MediaType.MUSIC;
            return 'All';
        };

        const effType = inferType();
        const domsFromStore = (() => {
            const s = useAIStore.getState();
            if (effType === MediaType.MOVIE || effType === MediaType.TV_SERIES) return s.authoritativeDomains.movie_tv || [];
            if (effType === MediaType.BOOK) return s.authoritativeDomains.book || [];
            if (effType === MediaType.COMIC) return s.authoritativeDomains.comic || [];
            if (effType === MediaType.MUSIC) return s.authoritativeDomains.music || [];
            return [];
        })();
        const normalizeDomain = (d: any): string => {
            const raw = String(d || '').trim().replace(/^site:/i, '');
            if (!raw) return '';
            let host = raw.toLowerCase();
            if (host.includes('://')) {
                try {
                    host = new URL(raw).hostname.toLowerCase();
                } catch (e) { console.warn("URL parse failed", e); }
            }
            host = host.replace(/^www\./, '').split('/')[0].trim();
            return host;
        };
        const domsUniq = new Set<string>();
        for (const d of domsFromStore) {
            const nd = normalizeDomain(d);
            if (nd) domsUniq.add(nd);
        }
        const domainOrder = (() => {
            if (effType === MediaType.TV_SERIES) return ['tvmaze.com', 'themoviedb.org', 'imdb.com', 'wikipedia.org', 'zh.wikipedia.org', 'douban.com'];
            if (effType === MediaType.MOVIE) return ['imdb.com', 'themoviedb.org', 'douban.com', 'wikipedia.org', 'zh.wikipedia.org'];
            if (effType === MediaType.BOOK) return ['goodreads.com', 'douban.com', 'wikipedia.org', 'zh.wikipedia.org'];
            if (effType === MediaType.COMIC) return ['bgm.tv', 'bangumi.tv', 'wikipedia.org', 'zh.wikipedia.org'];
            if (effType === MediaType.MUSIC) return ['musicbrainz.org', 'discogs.com', 'wikipedia.org', 'zh.wikipedia.org'];
            return [];
        })();
        const rankDomain = (d: string) => {
            const idx = domainOrder.findIndex(x => d === x || d.endsWith(`.${x}`));
            return idx === -1 ? 999 : idx;
        };
        let domsForSearch = Array.from(domsUniq.values());
        if (effType === MediaType.MOVIE) {
            domsForSearch = domsForSearch.filter(d => d !== 'tvmaze.com');
        }
        domsForSearch.sort((a, b) => rankDomain(a) - rankDomain(b));
        const precisionDomains = domsForSearch.map(d => `site:${d}`);
        const isEnglishUI = (typeof i18n?.language === 'string') && i18n.language.startsWith('en');

        const englishTypeTerm = (t: MediaType | 'All') => {
            switch (t) {
                case MediaType.MOVIE: return 'movie';
                case MediaType.TV_SERIES: return 'tv series';
                case MediaType.BOOK: return 'novel';
                case MediaType.COMIC: return 'comic';
                case MediaType.MUSIC: return 'album';
                case MediaType.SHORT_DRAMA: return 'short drama';
                default: return '';
            }
        };

        const qList = [base]; 
        // Add type-specific query to improve results (especially for DuckDuckGo fallback)
        if (effType !== 'All') {
            const typeHint = englishTypeTerm(effType);
            if (typeHint) qList.push(`${base} ${typeHint}`);
        }
        
        // Precision queries disabled to save quota
        const precisionQueries: string[] = [];
        const toEnglishBase = (text: string) => {
            const t = text.trim();
            const aliases = FRANCHISE_ALIASES[t] || [];
            const enAlias = aliases.find(a => /[a-z]/i.test(a));
            return enAlias || t;
        };
        const maxDomainQueries = (effType === MediaType.MOVIE || effType === MediaType.TV_SERIES) ? 2 : 1;
        const selectedDomains = domsForSearch.slice(0, maxDomainQueries);
        for (const dRaw of selectedDomains) {
            const d = String(dRaw || '').trim().replace(/^site:/i,'').replace(/^www\./i,'').split('/')[0];
            if (!d) continue;
            const englishDomain = d.includes('imdb.com') || d.includes('themoviedb.org') || d.includes('tvmaze.com') || (d.includes('wikipedia.org') && !d.includes('zh.wikipedia.org')) || d.includes('goodreads.com') || d.includes('discogs.com') || d.includes('musicbrainz.org');
            const baseTerm = (englishDomain && !isEnglishUI) ? toEnglishBase(base) : base;
            const typeHint = (englishDomain && effType !== 'All') ? englishTypeTerm(effType) : '';
            const qv = typeHint ? `${baseTerm} ${typeHint}` : baseTerm;
            precisionQueries.push(`site:${d} ${qv}`);
        }

        const normalizeHost = (u: string): string => {
            try {
                return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
            } catch (e) {
                console.warn("Host normalize failed", e);
                const s = String(u || '').toLowerCase();
                const m = s.match(/^https?:\/\/([^\/?#]+)/);
                if (m && m[1]) return m[1].replace(/^www\./, '');
                return s.replace(/^www\./, '').split('/')[0];
            }
        };
        const isMediaCandidate = (title: string, snippet: string, link?: string): boolean => {
            const text = `${title} ${snippet}`.toLowerCase();
            const allKeywords = isChinese
                ? ['电影','电视剧','短剧','漫画','小说','书籍','专辑','音乐','原声','ost','动漫','动画','综艺','纪录片','剧集','番剧']
                : ['movie','film','tv series','season','episode','novel','book','comic','manga','album','music','soundtrack','ost','anime','animation','documentary','drama'];
            const typeKeywords = (() => {
                if (effType === MediaType.MOVIE) return isChinese ? ['电影', '影片'] : ['movie', 'film'];
                if (effType === MediaType.TV_SERIES) return isChinese ? ['电视剧', '剧集', '季', '集', '番剧'] : ['tv series', 'season', 'episode', 'series'];
                if (effType === MediaType.BOOK) return isChinese ? ['小说', '书', '书籍'] : ['novel', 'book'];
                if (effType === MediaType.COMIC) return isChinese ? ['漫画', '番剧'] : ['comic', 'manga', 'anime'];
                if (effType === MediaType.MUSIC) return isChinese ? ['专辑', '音乐', '原声', 'ost'] : ['album', 'music', 'soundtrack', 'ost'];
                if (effType === MediaType.SHORT_DRAMA) return isChinese ? ['短剧'] : ['short drama'];
                return allKeywords;
            })();
            const matchesKeyword = (effType === 'All' ? allKeywords : typeKeywords).some(k => text.includes(k));
            if (matchesKeyword) return true;
            if (link) {
                const host = normalizeHost(link);
                if (host) {
                    if (effType === 'All') return false;
                    return domsForSearch.some(d => host === d || host.endsWith(`.${d}`));
                }
            }
            return false;
        };

        // Tauri Mode
        if (isTauriEnv) {
            try {
                // Map config to Rust struct naming conventions
                const { useSystemProxy, getProxyUrl } = useAIStore.getState();
                const providerList = resolveTauriSearchProviderList({
                    provider: searchProvider,
                    googleKey: getDecryptedGoogleKey(),
                    googleCx: googleSearchCx,
                    serperKey: getDecryptedSerperKey(),
                    yandexKey: getDecryptedYandexKey(),
                    yandexUser: yandexSearchLogin
                });
                const providers = providerList.slice(0, 2);
                
                const topN = (effType === MediaType.MOVIE || effType === MediaType.TV_SERIES) ? (shortOrNumeric ? 1 : 2) : 1;
                const ordered = [...precisionQueries.slice(0, topN), ...qList];
                const uniq = new Map<string, any>();
                
                const makeRustConfig = (
                  p: { provider: TauriSearchProvider; apiKey?: string; cx?: string; user?: string },
                  search_type: 'text' | 'image'
                ) => ({
                  provider: p.provider,
                  api_key: p.apiKey,
                  cx: p.cx,
                  user: p.user,
                  search_type,
                  proxy_url: getProxyUrl(),
                  use_system_proxy: useSystemProxy
                });

                const runTauriSearch = async (
                  p: { provider: TauriSearchProvider; apiKey?: string; cx?: string; user?: string },
                  qv: string
                ): Promise<any[]> => {
                  // Cache removed for Tauri mode as per refactoring requirements
                  // The backend (Rust) handles its own caching if needed, or we rely on fresh results.
                  
                  const rustConfig = makeRustConfig(p, 'text');
                  const start = performance.now();
                  let resultStr = "";
                  await searchLimiter.acquire();
                  try {
                    for (let i = 0; i < 2; i++) {
                      try {
                        resultStr = await invoke<string>("web_search", { query: qv, config: rustConfig });
                        if (resultStr) break;
                      } catch (e: any) {
                        const errStr = e?.message || String(e);
                        if (errStr.includes("429")) {
                          showQuotaError("Quota Exceeded");
                          throw e;
                        }
                        if (i === 1) {
                          try {
                            useAIStore.getState().appendLog({
                              id: uuidv4(),
                              ts: Date.now(),
                              channel: 'search',
                              provider: rustConfig.provider,
                              query: qv,
                              request: { config: { provider: rustConfig.provider, cx: rustConfig.cx, user: rustConfig.user, search_type: rustConfig.search_type } },
                              response: { error: errStr },
                              durationMs: Math.round(performance.now() - start),
                              searchType: 'text'
                            });
                          } catch (e) { console.warn("Log append failed", e); }
                          return [];
                        }
                        await new Promise(r => setTimeout(r, 800));
                      }
                    }
                  } finally {
                    searchLimiter.release();
                  }

                  try {
                    useAIStore.getState().appendLog({
                      id: uuidv4(),
                      ts: Date.now(),
                      channel: 'search',
                      provider: rustConfig.provider,
                      query: qv,
                      request: { config: { provider: rustConfig.provider, cx: rustConfig.cx, user: rustConfig.user, search_type: rustConfig.search_type } },
                      response: resultStr,
                      durationMs: Math.round(performance.now() - start),
                      searchType: 'text'
                    });
                  } catch (e) { console.warn("Log append failed", e); }

                  if (!resultStr) return [];
                  try {
                    const arr = JSON.parse(resultStr);
                    if (Array.isArray(arr)) {
                      // searchCache.set(cacheKey, { ts: Date.now(), data: arr }); // Cache removed
                      return arr;
                    }
                  } catch (e) { console.warn("JSON parse failed", e); }
                  return [];
                };

                const tasks: Array<{ p: { provider: TauriSearchProvider; apiKey?: string; cx?: string; user?: string }, qv: string }> = [];
                const primary = providers[0] || { provider: 'duckduckgo' as const };
                for (const qv of ordered) tasks.push({ p: primary, qv });
                for (const p of providers.slice(1)) {
                  tasks.push({ p, qv: base });
                  if (qList.length > 1) tasks.push({ p, qv: qList[1] });
                }

                const taskUniq = new Map<string, { p: any, qv: string }>();
                for (const tsk of tasks) {
                  const k = `${tsk.p.provider}|${tsk.p.cx || ''}|${tsk.p.user || ''}|${tsk.qv}`;
                  if (!taskUniq.has(k)) taskUniq.set(k, tsk);
                }

                const limitedTasks = Array.from(taskUniq.values()).slice(0, shortOrNumeric ? 4 : 5);
                const resultsArrays = await Promise.all(limitedTasks.map(t => runTauriSearch(t.p, t.qv)));
                const allResults = resultsArrays.flat();

                const candidateStep = (effType === 'All') ? allResults : allResults.filter((it: any) => isMediaCandidate(it.title || '', it.snippet || '', it.link));
                
                // Process and Score Results
                const scoredResults = candidateStep.map((it: any) => {
                    const pr = processSearchResult(it.title || '', it.snippet || '');
                    let score = 0;
                    const tLower = pr.title.toLowerCase();
                    const qLower = base.toLowerCase();
                    
                    // Exact title match bonus
                    if (tLower === qLower) score += 50;
                    else if (tLower.startsWith(qLower)) score += 30;
                    else if (tLower.includes(qLower)) score += 15;
                    
                    // Year presence bonus
                    if (pr.year) score += 10;
                    
                    // Authoritative domain bonus (simple check)
                    if (it.link && precisionDomains.some(d => it.link.includes(d.replace('site:', '')))) score += 20;
                    
                    // Penalty for very short titles if query is long
                    if (tLower.length < qLower.length && qLower.length > 5) score -= 10;

                    return { ...it, processed: pr, score };
                });
                
                // Sort by score descending
                scoredResults.sort((a: any, b: any) => b.score - a.score);

                for (const it of scoredResults) {
                    const pr = it.processed;
                    const key = `${pr.title}|${pr.year}`;
                    if (!uniq.has(key)) uniq.set(key, { title: pr.title, snippet: it.snippet, link: it.link, image: it.image });
                    if (uniq.size >= 8) break;
                }
                
                const out = Array.from(uniq.values());
                if (out.length > 0) return JSON.stringify(out);
                
                // Fallback to DuckDuckGo if no results
                const ddgConfig = {
                    provider: 'duckduckgo',
                    api_key: undefined,
                    cx: undefined,
                    user: undefined,
                    search_type: "text",
                    proxy_url: useAIStore.getState().getProxyUrl(),
                    use_system_proxy: useAIStore.getState().useSystemProxy
                };
                
                const ddgPromises = ordered.slice(0, shortOrNumeric ? 2 : 3).map(async (qv) => {
                    const start = performance.now();
                    try {
                        const resultStr = await invoke<string>("web_search", { query: qv, config: ddgConfig });
                         try {
                            useAIStore.getState().appendLog({
                                id: uuidv4(),
                                ts: Date.now(),
                                channel: 'search',
                                provider: 'duckduckgo',
                                query: qv,
                                request: { config: { provider: ddgConfig.provider, search_type: ddgConfig.search_type } },
                                response: resultStr || "",
                                durationMs: Math.round(performance.now() - start),
                                searchType: 'text'
                            });
                        } catch (e) { console.warn("Log append failed", e); }
                        if (resultStr) {
                             const arr = JSON.parse(resultStr);
                             if (Array.isArray(arr)) return arr;
                        }
                    } catch (e) { console.warn("DDG fallback failed", e); }
                    return [];
                });

                const ddgResultsArrays = await Promise.all(ddgPromises);
                const allDDGResults = ddgResultsArrays.flat();
                
                const filteredDDG = (effType === 'All') ? allDDGResults : allDDGResults.filter((it: any) => isMediaCandidate(it.title || '', it.snippet || '', it.link));
                
                 const scoredDDG = filteredDDG.map((it: any) => {
                    const pr = processSearchResult(it.title || '', it.snippet || '');
                    let score = 0;
                    const tLower = pr.title.toLowerCase();
                    const qLower = base.toLowerCase();

                    if (tLower === qLower) score += 50;
                    else if (tLower.startsWith(qLower)) score += 30;
                    else if (tLower.includes(qLower)) score += 15;

                    if (pr.year) score += 10;
                    
                    return { ...it, processed: pr, score };
                });
                scoredDDG.sort((a: any, b: any) => b.score - a.score);

                const uniqD = new Map<string, any>();
                for (const it of scoredDDG) {
                    const pr = it.processed;
                    const key = `${pr.title}|${pr.year}`;
                    if (!uniqD.has(key)) uniqD.set(key, { title: pr.title, snippet: it.snippet, link: it.link, image: it.image });
                    if (uniqD.size >= 8) break;
                }
                const outD = Array.from(uniqD.values());
                if (outD.length > 0) return JSON.stringify(outD);

            } catch (tauriError) {
                console.error("Tauri search failed:", tauriError);
                showQuotaError(String(tauriError || ''));
                try {
                    useAIStore.getState().appendLog({
                        id: uuidv4(),
                        ts: Date.now(),
                        channel: 'search',
                        provider: searchProvider,
                        query: base,
                        request: { config: { provider: searchProvider, cx: googleSearchCx, user: yandexSearchLogin, search_type: "text" } },
                        response: { error: (tauriError as any)?.message || String(tauriError) },
                        durationMs: undefined,
                        searchType: 'text'
                    });
                } catch {}
                // Fall through to web-mode Wikipedia fallback
                return "";
            }
        }
        
        // Web Mode (Limited)
        if (googleReady && (!serperFirst || triedSerper)) {
            const apiKeyStr = getDecryptedGoogleKey();
            if (apiKeyStr && googleSearchCx) {
            const apiKeys = apiKeyStr.split(/[;；]/).map(k => k.trim()).filter(k => k);
            
            // Try each key
            for (const apiKey of apiKeys) {
                let keyFailed = false;
                const topN = (effType === MediaType.MOVIE || effType === MediaType.TV_SERIES) ? 3 : 2;
                const ordered = [...precisionQueries.slice(0, topN), ...qList];
                
                // Execute queries in parallel with semaphore
                const queryPromises = ordered.map(async (qv) => {
                    const start = performance.now();
                    if (keyFailed) return [];
                    const cacheKey = `google_${googleSearchCx}_${qv}`;
                    const cached = searchCache.get(cacheKey);
                    
                    if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
                        return cached.data.items || [];
                    }

                    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${googleSearchCx}&q=${encodeURIComponent(qv)}&num=8&safe=off`;
                    
                    try {
                        await apiLimiter.acquire();
                        try {
                            const res = await fetchWithTimeout(url, { timeoutMs: 10000 });
                            
                            if (res.status === 429 || res.status === 400 || res.status === 403) {
                                console.warn(`Google Search Error ${res.status}`);
                                if (res.status === 429) showQuotaError("Quota Exceeded");
                                keyFailed = true;
                                return [];
                            }
                            
                            if (res.ok) {
                                const data = await res.json();
                                searchCache.set(cacheKey, { ts: Date.now(), data });
                                try {
                                    useAIStore.getState().appendLog({
                                        id: uuidv4(),
                                        ts: Date.now(),
                                        channel: 'search',
                                        provider: 'google',
                                        query: qv,
                                        request: { url: `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(qv)}&num=8` },
                                        response: (data.items || []).slice(0, 8),
                                        durationMs: Math.round(performance.now() - start),
                                        searchType: 'text'
                                    });
                                } catch {}
                                return data.items || [];
                            }
                        } finally {
                            apiLimiter.release();
                        }
                    } catch (e) { }
                    return [];
                });

                const resultsArrays = await Promise.all(queryPromises);
                if (keyFailed) continue;

                let merged = resultsArrays.flat().map((item: any) => ({
                    title: item.title,
                    snippet: item.snippet,
                    link: item.link,
                    image: item.pagemap?.cse_image?.[0]?.src
                }));

                const uniq = new Map<string, any>();
                const filteredStep = merged.filter((it: any) => isMediaCandidate(it.title, it.snippet, it.link));
                
                for (const it of filteredStep) {
                    const pr = processSearchResult(it.title || '', it.snippet || '');
                    const key = `${pr.title}|${pr.year}`;
                    if (!uniq.has(key)) uniq.set(key, { title: pr.title, snippet: it.snippet, link: it.link, image: it.image });
                }

                const outArray = Array.from(uniq.values());
                const scoredOut = outArray.map((it: any) => {
                    const pr = processSearchResult(it.title || '', it.snippet || '');
                    let score = 0;
                    const tLower = pr.title.toLowerCase();
                    const qLower = base.toLowerCase();
                    if (tLower === qLower) score += 50;
                    else if (tLower.startsWith(qLower)) score += 30;
                    else if (tLower.includes(qLower)) score += 15;
                    if (pr.year) score += 10;
                    if (tLower.length < qLower.length && qLower.length > 5) score -= 10;
                    return { ...it, score };
                });
                scoredOut.sort((a, b) => b.score - a.score);
                const final = scoredOut.slice(0, 8);
                if (final.length > 0) return JSON.stringify(final);
            } // end key loop
            }
            triedGoogle = true;
        }

    // Serper (Web Mode)
    if (serperReady && (serperFirst || triedGoogle || !googleReady)) {
        const apiKeyStr = getDecryptedSerperKey();
        if (apiKeyStr) {
            const apiKeys = apiKeyStr.split(/[;；]/).map(k => k.trim()).filter(k => k);
            
            for (const apiKey of apiKeys) {
                let keyFailed = false;
                const topN = (effType === MediaType.MOVIE || effType === MediaType.TV_SERIES) ? 3 : 2;
                const ordered = [...precisionQueries.slice(0, topN), ...qList];

                const queryPromises = ordered.map(async (qv) => {
                    const start = performance.now();
                    if (keyFailed) return [];
                    try {
                        const response = await fetchWithTimeout('https://google.serper.dev/search', {
                            method: 'POST',
                            headers: {
                                'X-API-KEY': apiKey,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ q: qv, num: 8, safe: "off" })
                        , timeoutMs: 12000 });
                        
                        if (response.status === 429 || response.status === 401 || response.status === 403) {
                            console.warn("Serper Search Error (Too Many Requests/Auth). Stopping.");
                            if (response.status === 429) showQuotaError("Quota Exceeded");
                            keyFailed = true;
                            return [];
                        }
                        
                        if (response.ok) {
                            const data = await response.json();
                            try {
                                useAIStore.getState().appendLog({
                                    id: uuidv4(),
                                    ts: Date.now(),
                                    channel: 'search',
                                    provider: 'serper',
                                    query: qv,
                                    request: { body: { q: qv, num: 8 } },
                                    response: (data.organic || []).slice(0, 8),
                                    durationMs: Math.round(performance.now() - start),
                                    searchType: 'text'
                                });
                            } catch {}

                            if (data.organic) {
                                return data.organic.map((item: any) => ({
                                    title: item.title,
                                    snippet: item.snippet,
                                    link: item.link,
                                    image: undefined
                                }));
                            }
                        }
                    } catch (e) { }
                    return [];
                });

                const resultsArrays = await Promise.all(queryPromises);
                if (keyFailed) continue;

                let merged = resultsArrays.flat();
                
                const uniq = new Map<string, any>();
                const filteredStep = merged.filter((it: any) => isMediaCandidate(it.title, it.snippet, it.link));
                for (const it of filteredStep) {
                    const pr = processSearchResult(it.title || '', it.snippet || '');
                    const key = `${pr.title}|${pr.year}`;
                    if (!uniq.has(key)) uniq.set(key, { title: pr.title, snippet: it.snippet, link: it.link, image: it.image });
                }
                
                const out = Array.from(uniq.values()).slice(0, 8);
                if (out.length > 0) return JSON.stringify(out);
            }
            triedSerper = true;
        }
    }

    // Fallback: DuckDuckGo (Web Mode Only - Tauri handles this above via Rust to avoid CORS)
    if (!isTauriEnv) {
        try {
            const orderedD = [...precisionQueries.slice(0, 3), ...qList];
            
            const queryPromises = orderedD.map(async (qv) => {
                const start = performance.now();
                let items: any[] = [];
                try {
                    // Note: This often fails due to CORS if not proxied
                    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(qv)}&format=json&no_redirect=1&no_html=1`;
                    const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
                    if (res.ok) {
                        const data = await res.json();
                        const rt = Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : [];
                        const results = Array.isArray(data?.Results) ? data.Results : [];
                        for (const r of results) {
                            const t = r?.Text || '';
                            const u = r?.FirstURL || '';
                            if (t && u) items.push({ title: t, snippet: t, link: u, image: undefined });
                        }
                        for (const r of rt) {
                            const t = r?.Text || '';
                            const u = r?.FirstURL || '';
                            if (t && u) items.push({ title: t, snippet: t, link: u, image: undefined });
                        }
                    }
                } catch {}
                try {
                    useAIStore.getState().appendLog({
                        id: uuidv4(),
                        ts: Date.now(),
                        channel: 'search',
                        provider: 'duckduckgo',
                        query: qv,
                        request: { url: 'https://api.duckduckgo.com', params: { q: qv } },
                        response: items.slice(0, 8),
                        durationMs: Math.round(performance.now() - start),
                        searchType: 'text'
                    });
                } catch {}
                return items;
            });

            const resultsArrays = await Promise.all(queryPromises);
            let mergedDDG = resultsArrays.flat();
            
            const uniqD = new Map<string, any>();
            const filteredD = (effType === 'All') ? mergedDDG : mergedDDG.filter((it: any) => isMediaCandidate(it.title, it.snippet, it.link));
            for (const it of filteredD) {
                const pr = processSearchResult(it.title || '', it.snippet || '');
                const key = `${pr.title}|${pr.year}`;
                if (!uniqD.has(key)) uniqD.set(key, { title: pr.title, snippet: it.snippet, link: it.link, image: it.image });
            }
            
            const outArray = Array.from(uniqD.values());
            const scoredOut = outArray.map((it: any) => {
                const pr = processSearchResult(it.title || '', it.snippet || '');
                let score = 0;
                const tLower = pr.title.toLowerCase();
                const qLower = base.toLowerCase();
                if (tLower === qLower) score += 50;
                else if (tLower.startsWith(qLower)) score += 30;
                else if (tLower.includes(qLower)) score += 15;
                if (pr.year) score += 10;
                if (tLower.length < qLower.length && qLower.length > 5) score -= 10;
                return { ...it, score };
            });
            scoredOut.sort((a, b) => b.score - a.score);
            const final = scoredOut.slice(0, 8);
            if (final.length > 0) return JSON.stringify(final);
        } catch {}
    }
        
        
    } catch (e) {
        console.warn("Search failed", e);
    }
    return "";
};

export const clearSearchCache = async (): Promise<boolean> => {
    try {
        searchCache.clear();
        prefetchedImages.clear();
        testConnectionCache.clear();

        // Clear localStorage search cache
        try {
            const keysToRemove: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('media_tracker_search_')) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(k => localStorage.removeItem(k));
        } catch (e) {
            console.warn("Failed to clear localStorage search cache", e);
            // LocalStorage failure might not be critical enough to fail the whole operation?
            // But let's log it.
        }

        if (isTauriEnv) {
            await invoke('clear_search_cache');
        }
        return true;
    } catch (e) {
        console.error("Failed to clear cache:", e);
        return false;
    }
};

export const testAuthoritativeDomain = async (domain: string, sampleQuery: string = 'test'): Promise<{ ok: boolean; count: number; items: any[]; error?: string }> => {
    const { 
        enableSearch,
        searchProvider,
        getDecryptedGoogleKey,
        googleSearchCx,
        getDecryptedSerperKey,
        getDecryptedYandexKey,
        yandexSearchLogin
    } = useAIStore.getState();
    const normalizeProvider = (sp: any): string => {
        const v = String(sp || '').toLowerCase();
        return (v === 'google' || v === 'serper' || v === 'yandex') ? v : 'duckduckgo';
    };
    if (!enableSearch) return { ok: false, count: 0, items: [], error: 'search_disabled' };
    const d = domain.trim().toLowerCase().replace(/^site:/,'');
    const query = `site:${d} ${sampleQuery}`;
    try {
        if (isTauriEnv) {
            const { useSystemProxy, getProxyUrl } = useAIStore.getState();
            
            // Use resolveTauriSearchProviderList to handle multiple keys
            const providerList = resolveTauriSearchProviderList({
                provider: searchProvider,
                googleKey: getDecryptedGoogleKey(),
                googleCx: googleSearchCx,
                serperKey: getDecryptedSerperKey(),
                yandexKey: getDecryptedYandexKey(),
                yandexUser: yandexSearchLogin
            });
            
            let lastError = 'unknown_error';
            
            // Try each provider configuration until success
            for (const eff of providerList) {
                try {
                    const rustConfig = {
                        provider: eff.provider,
                        api_key: eff.apiKey,
                        cx: eff.cx,
                        user: eff.user,
                        search_type: 'text',
                        proxy_url: getProxyUrl(),
                        use_system_proxy: useSystemProxy
                    };
                    
                    const resultStr = await invoke<string>('web_search', { query, config: rustConfig });
                    const arr = JSON.parse(resultStr);
                    const items = Array.isArray(arr) ? arr : [];
                    return { ok: items.length > 0, count: items.length, items };
                } catch (e: any) {
                    lastError = e?.message || String(e);
                    // Continue to next key/provider if error
                    console.warn("Test connection failed with current key, retrying...", lastError);
                }
            }
            return { ok: false, count: 0, items: [], error: lastError };
        }
        if (searchProvider === 'google') {
            const apiKeyStr = getDecryptedGoogleKey();
            if (apiKeyStr && googleSearchCx) {
                const apiKeys = apiKeyStr.split(/[;；]/).map(k => k.trim()).filter(k => k);
                let lastError = "";
                
                for (const apiKey of apiKeys) {
                    const cacheKey = `google_${googleSearchCx}_${query}`;
                    const cached = searchCache.get(cacheKey);
                    let data: any = null;
                    let status: any = 200;
                    let fromCache = false;

                    if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
                        data = cached.data;
                        fromCache = true;
                        status = 'cached';
                    } else {
                         const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${googleSearchCx}&q=${encodeURIComponent(query)}&num=4`;
                        let res;
                        try {
                            await apiLimiter.acquire();
                            res = await fetchWithTimeout(url, { timeoutMs: 12000 });
                        } catch(e: any) {
                            lastError = e?.message || "network_error";
                        } finally {
                            apiLimiter.release();
                        }
                        
                        if (res && res.ok) {
                            data = await res.json();
                            searchCache.set(cacheKey, { ts: Date.now(), data });
                        } else if (res) {
                            lastError = `HTTP ${res.status}`;
                            if (res.status === 400 || res.status === 403 || res.status === 429) {
                                continue;
                            }
                            continue;
                        }
                    }

                    if (data && data.items) {
                        const items = Array.isArray(data.items) ? data.items.map((item: any) => ({
                            title: item.title,
                            snippet: item.snippet,
                            link: item.link
                        })) : [];
                        return { ok: items.length > 0, count: items.length, items };
                    }
                }
                return { ok: false, count: 0, items: [], error: lastError || 'all_keys_failed' };
            }
        }
        if (searchProvider === 'serper') {
            const apiKeyStr = getDecryptedSerperKey();
            if (apiKeyStr) {
                const apiKeys = apiKeyStr.split(/[;；]/).map(k => k.trim()).filter(k => k);
                let lastError = "";

                for (const apiKey of apiKeys) {
                    try {
                        const response = await fetchWithTimeout('https://google.serper.dev/search', {
                            method: 'POST',
                            headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ q: query }),
                            timeoutMs: 12000
                        });
                        if (!response.ok) {
                            lastError = String(response.status);
                            if (response.status === 429 || response.status === 403) {
                                if (response.status === 429) lastError = 'Quota Exceeded (429)';
                                continue;
                            }
                            continue;
                        }
                        const data = await response.json();
                        const items = Array.isArray(data.organic) ? data.organic.slice(0, 4).map((item: any) => ({
                            title: item.title,
                            snippet: item.snippet,
                            link: item.link
                        })) : [];
                        return { ok: items.length > 0, count: items.length, items };
                    } catch (e: any) {
                        lastError = e?.message || "error";
                    }
                }
                return { ok: false, count: 0, items: [], error: lastError || 'all_keys_failed' };
            }
        }
        return { ok: false, count: 0, items: [], error: 'unsupported_provider_or_missing_key' };
    } catch (e: any) {
        return { ok: false, count: 0, items: [], error: e?.message || 'error' };
    }
};

export const runBackgroundSearch = async (query: string, type?: MediaType | 'All'): Promise<void> => {
    const q = (query || '').trim();
    if (!q) return;
    const t: MediaType | 'All' = type || 'All';
    const start = performance.now();
    try {
        const items = await searchMedia(q, t);
        const enriched = [] as MediaItem[];
        for (const it of items) {
            try {
                const year = it.releaseDate ? it.releaseDate.split('-')[0] : '';
                const { picked } = await fetchPosterFromSearch(it.title, year, it.type);
                if (picked && (!it.customPosterUrl)) {
                    enriched.push({ ...it, posterUrl: picked });
                } else {
                    enriched.push(it);
                }
            } catch (e) {
                console.warn("Poster enrichment failed", e);
                enriched.push(it);
            }
        }
        try {
            const langKey = i18n.language.split('-')[0];
            const key = `media_tracker_search_${langKey}_${t}_${q.toLowerCase()}`;
            const tsKey = `${key}_ts`;
            localStorage.setItem(key, JSON.stringify(enriched));
            localStorage.setItem(tsKey, Date.now().toString());
        } catch (e) { console.warn("Cache write failed", e); }
        const duration = Math.round(performance.now() - start);
        useAIStore.getState().setConfig({ lastSearchDurationMs: duration, lastSearchAt: new Date().toISOString(), lastSearchQuery: q });
    } catch (e) { console.error("Background search failed", e); }
};

export const refreshTrendingCache = async (): Promise<void> => {
    try {
        const trending = await getTrendingMedia();
        if (Array.isArray(trending) && trending.length > 0) {
            try {
                localStorage.setItem('media_tracker_trending_data', JSON.stringify(trending));
                localStorage.setItem('media_tracker_trending_ts', Date.now().toString());
                try {
                    localStorage.setItem('media_tracker_trending_prompt_key', getTrendingPromptKey());
                } catch (e) { console.warn("Prompt key save failed", e); }
            } catch (e) { console.warn("Trending cache save failed", e); }
            useAIStore.getState().setTrendingCache(trending as any[]);
        }
    } catch (e) { console.error("Refresh trending failed", e); }
};

/**
 * Classify a failed AI call so callers can tell "your key/provider is wrong"
 * (needs a config fix) apart from transient or model-side failures.
 */
export const describeAIError = (e: unknown): { auth: boolean; detail: string } => {
    const err: any = e;
    const detail = String(err?.message || e || '').trim();
    const status = Number(err?.status || err?.response?.status || 0) || Number((detail.match(/\((\d{3})\)/) || [])[1] || 0);
    const auth = status === 401 || status === 403 ||
        /unauthorized|invalid api key|authentication fails|api key.*(invalid|incorrect)|missing api key/i.test(detail);
    return { auth, detail };
};

/**
 * Temperature policy per model, learned from the provider at runtime.
 * `value` = only that temperature is accepted, `null` = the parameter is
 * rejected outright. Learned once per session so later calls skip the rejected
 * request instead of paying for it again — this is what makes models the
 * catalog does not know about (custom endpoints, new releases) work.
 */
const learnedTemperaturePolicy = new Map<string, number | null>();

/** Models that reject tool definitions at all (learned the same way). */
const learnedNoTools = new Set<string>();

const modelPolicyKey = (provider: string, model?: string | null): string => `${provider}|${model || ''}`;

/** What a model wants instead of the requested temperature. */
type TemperatureRequirement = { kind: 'value'; value: number } | { kind: 'unsupported' };

/** Read a provider's temperature complaint, e.g. "only 1 is allowed for this model". */
const parseTemperatureRequirement = (e: any): TemperatureRequirement | null => {
    const msg = String(e?.message || e?.error?.message || '');
    if (!/temperature/i.test(msg)) return null;
    const byValue = msg.match(/only\s+(\d+(?:\.\d+)?)\s+is allowed/i)
        || msg.match(/only the default \((\d+(?:\.\d+)?)\)/i)
        || msg.match(/temperature\s*(?:must be|is)\s*(\d+(?:\.\d+)?)/i);
    if (byValue) {
        const value = Number(byValue[1]);
        if (Number.isFinite(value)) return { kind: 'value', value };
    }
    if (/(unsupported|not supported|does not support)/i.test(msg)) return { kind: 'unsupported' };
    return null;
};

/** Temperature to send: a learned/catalogued value, `undefined` when the model rejects the field. */
const resolveTemperature = (provider: AIProvider, model: string | null | undefined, requested: number): number | undefined => {
    const key = modelPolicyKey(provider, model);
    if (learnedTemperaturePolicy.has(key)) {
        const learned = learnedTemperaturePolicy.get(key);
        return learned === null ? undefined : learned;
    }
    return getModelCapabilities(provider, model).fixedTemperature ?? requested;
};

const rememberTemperaturePolicy = (provider: AIProvider, model: string | null | undefined, requirement: TemperatureRequirement): void => {
    learnedTemperaturePolicy.set(modelPolicyKey(provider, model), requirement.kind === 'value' ? requirement.value : null);
};

/** True when the provider rejected the tool/function definitions we sent. */
const isToolsUnsupportedError = (e: any): boolean => {
    const msg = String(e?.message || e?.error?.message || '');
    if (!/\b(tools|tool_choice|functions|function_calling)\b/i.test(msg)) return false;
    return /unsupported|not supported|does not support|unknown (parameter|field|argument)|invalid (parameter|field|argument)/i.test(msg);
};

/**
 * Read a provider's complaint about the token budget: either its own output
 * limit ("max_tokens must be <= 16384") or the total context window, which the
 * prompt already consumes.
 */
const parseTokenLimitRequirement = (e: any): { limit?: number; shrink?: boolean } | null => {
    const msg = String(e?.message || e?.error?.message || '');
    if (!/max_?tokens|max_?completion_?tokens|context length|output (?:limit|length)/i.test(msg)) return null;
    if (/context length|too many tokens|prompt is too long/i.test(msg)) return { shrink: true };
    const m = msg.match(/(?:must be|should be|less than or equal to|<=|≤)\s*(\d+)/i)
        || msg.match(/maximum (?:output|completion|max_?tokens)[^\d]{0,24}(\d+)/i)
        || msg.match(/(\d+)\s*(?:is the maximum|max(?:imum)? (?:allowed|supported|output))/i);
    if (!m) return null;
    const limit = Number(m[1]);
    return Number.isFinite(limit) && limit > 0 ? { limit } : null;
};

/** Room a thinking model needs before it can write anything: it reasons first, then answers. */
const REASONING_TOKEN_FLOOR = 8000;
const MAX_TOKEN_CEILING = 32000;

/** Providers whose chat-completions endpoint takes tool definitions (used for web search). */
const TOOL_CALLING_PROVIDERS: AIProvider[] = ['moonshot', 'deepseek', 'openai', 'qwen', 'google', 'mistral', 'mimo', 'zhipu'];

export const providerSupportsTools = (provider: AIProvider): boolean => TOOL_CALLING_PROVIDERS.includes(provider);

// True when the model can search the web itself via its provider's native
// search tool — the same condition callAI uses to activate it. Callers use
// this to skip pre-gathering context from the search-engine APIs, so native
// search is preferred and the engines stay a fallback.
export const canUseNativeSearch = (forceSearch: boolean = false): boolean => {
    const s = useAIStore.getState();
    if (!(s.enableSearch || forceSearch) || !s.enableNetworking) return false;
    if (!providerSupportsTools(s.provider)) return false;
    return getModelCapabilities(s.provider, s.model).nativeSearch;
};

export const callAI = async (messages: any[], temperature: number = 0.7, options: { forceSearch?: boolean; disableSearch?: boolean; maxTokens?: number | 'auto'; configOverride?: { baseURL?: string; apiKey?: string; model?: string; provider?: AIProvider } } = {}): Promise<string> => {
    const state = useAIStore.getState();
    const { 
        provider,
        baseUrl: storeBaseURL, 
        model: storeModel, 
        enableSearch,
        enableNetworking,
        reasoningEffort,
        maxTokens,
        searchProvider,
        getDecryptedGoogleKey,
        googleSearchCx,
        getDecryptedSerperKey,
        getDecryptedYandexKey,
        yandexSearchLogin
    } = state;

    const override = options.configOverride || {};
    const effProvider: AIProvider = (override.provider as AIProvider) ?? (provider as AIProvider);
    const baseURL = override.baseURL ?? storeBaseURL;
    const model = override.model ?? storeModel;

    let apiKey = override.apiKey ?? state.getDecryptedApiKey();

    if (!apiKey) {
        try {
            const envKey = (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.VITE_MOONSHOT_API_KEY) ? (import.meta as any).env.VITE_MOONSHOT_API_KEY : undefined;
            if (envKey && envKey !== 'undefined') {
                apiKey = String(envKey);
            }
        } catch {}
    }

    const isTauri = typeof window !== 'undefined' && (
        ('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window) ||
        (typeof window.location !== 'undefined' && (
            window.location.protocol === 'tauri:' ||
            (typeof window.location.origin === 'string' && window.location.origin.startsWith('http://tauri.localhost'))
        ))
    );

    // Web Mode (Direct API Call) OR Tauri Mode (Custom Client)
    if (!apiKey) {
        return "";
    }

    let finalBaseURL = (baseURL || "https://api.moonshot.cn/v1")
        .trim()
        .replace(/[\s)]+$/g, "")
        .replace(/[()]/g, "")
        .replace(/^"+|"+$/g, "")
        .replace(/^'+|'+$/g, "");

    const ensureV1IfNeeded = (prov: AIProvider, url: string) => {
        const hasV1 = url.endsWith('/v1') || url.includes('/v1/');
        const isGoogleOpenAI = url.includes('/openai/');
        if (isGoogleOpenAI) return url;
        if (url.includes('api.deepseek.com')) return url;
        if ((prov === 'openai' || prov === 'mistral' || prov === 'moonshot') && !hasV1) {
            return url.endsWith('/') ? `${url}v1` : `${url}/v1`;
        }
        return url;
    };
    finalBaseURL = ensureV1IfNeeded(effProvider as AIProvider, finalBaseURL);

    // Some models accept exactly one temperature value, others reject the field
    // entirely (see modelCatalog + the runtime-learned policy above).
    const caps = getModelCapabilities(effProvider, model);
    let effTemperature = resolveTemperature(effProvider, model, temperature);
    // `'auto'` sends no cap at all (the provider's own maximum applies) — used by
    // callers like distillation that must not be cut short by our setting.
    let effMaxTokens: number | undefined = options.maxTokens === 'auto'
        ? undefined
        : (options.maxTokens ?? maxTokens);

    // Proxy handling for Web Mode to avoid CORS (only in local dev)
    const isLocalDev = typeof window !== 'undefined' && /^https?:\/\/(localhost|127\.|0\.0\.0\.0)/.test(window.location.origin || '');
    if (!isTauri && isLocalDev && finalBaseURL.includes('api.moonshot.cn')) {
        finalBaseURL = `${window.location.origin}/api/moonshot/v1`;
    } else if (!isTauri && isLocalDev && finalBaseURL.startsWith('/')) {
        finalBaseURL = `${window.location.origin}${finalBaseURL}`;
    }

    // Abstract the "completion" call
    const createCompletion = async (msgs: any[], tools: any[], baseURLOverride?: string, apiKeyOverride?: string, extraBody?: Record<string, any>) => {
        const effBaseURL = (baseURLOverride || finalBaseURL || '').trim();
        const effApiKey = apiKeyOverride || apiKey;
        
        if (isTauri) {
             const { useSystemProxy, getProxyUrl } = useAIStore.getState();
            const rustConfig = {
                model,
                baseURL: effBaseURL,
                apiKey: effApiKey,
                proxy_url: getProxyUrl(),
                use_system_proxy: useSystemProxy
            };
            // Call Rust
            const resultJson = await invoke<string>("ai_chat", { 
                messages: msgs, 
                temperature: effTemperature, 
                tools: tools.length > 0 ? tools : undefined, 
                extra_body: extraBody || {},
                config: rustConfig 
            });
            
            // Parse result to match OpenAI structure
            try {
                const response = JSON.parse(resultJson);
                return response;
            } catch(e) {
                console.error("Failed to parse Rust AI response", e);
                throw e;
            }
        } else {
            // Web Mode
             const client = new OpenAI({
                apiKey: effApiKey,
                baseURL: effBaseURL,
                dangerouslyAllowBrowser: true
            });
            
            return await client.chat.completions.create({
                model: model || "gpt-5.6-terra",
                messages: msgs,
                temperature: effTemperature,
                tools: tools.length > 0 ? tools : undefined,
                tool_choice: tools.length > 0 ? "auto" : undefined,
                ...(extraBody || {})
            } as any);
        }
    };

    try {
        const shouldSearch = (enableSearch || !!options.forceSearch) && !options.disableSearch;
        const supportsTools = providerSupportsTools(effProvider);
        const useNativeSearch = shouldSearch && supportsTools && !!enableNetworking && caps.nativeSearch;
        // A model that rejected tool definitions before is called without them.
        let toolsAllowed = !learnedNoTools.has(modelPolicyKey(effProvider, model));
        const externalTools: any[] = (shouldSearch && supportsTools) ? [
                {
                    type: "function",
                    function: {
                        name: "web_search",
                        description: "Search the internet for real-time information. Use this to get the latest media releases, news, and updates.",
                        parameters: {
                            type: "object",
                            properties: {
                                query: {
                                    type: "string",
                                    description: "The search query"
                                }
                            },
                            required: ["query"]
                        }
                    }
                }
            ] : [];
        const nativeSearchTools = getNativeSearchTools(effProvider);
        let nativeSearchBlocked = false;

        // Handle multiple API keys with retry logic
        const apiKeys = apiKey.split(/[;；]/).map(k => k.trim()).filter(k => k);
        let lastError: any = null;
        let temperatureAdjusted = false;
        
        for (let i = 0; i < apiKeys.length; i++) {
            const currentKey = apiKeys[i];
            
            try {
                let turnCount = 0;
                // How many web_search rounds the model may run before it has to
                // answer; the loop below still allows one final tool-less turn.
                const MAX_SEARCH_ROUNDS = 2;
                // Set once the search rounds are used up: the next request runs
                // without tools so the model has to produce its answer.
                let toolsDisabled = false;
                // Thinking models often close a search round with an empty message
                // when they wanted to search again; ask once more, without tools.
                let emptyAnswerNudged = false;
                // Truncated answers (reasoning ate the whole budget) get a bigger one.
                let budgetRaises = 0;
                // Providers may cap the budget themselves ("max_tokens must be <= N").
                let tokenLimitAdjusted = false;
                let currentMessages = [...messages]; // Clone for each key retry to start fresh conversation state if needed? 
                                                     // Actually we probably want to resume conversation, but if a key fails mid-way, 
                                                     // the conversation state in 'currentMessages' might be dirty if we mutated it?
                                                     // No, 'currentMessages' is only mutated by pushing new messages. 
                                                     // If createCompletion fails, 'currentMessages' is untouched for THAT turn.
                                                     // But wait, the outer loop below modifies 'currentMessages'.
                                                     // So we should reset 'currentMessages' to 'messages' at start of each key attempt?
                                                     // YES.
                currentMessages = [...messages];

                while (turnCount <= MAX_SEARCH_ROUNDS) {
                    let completion;
                    const startTs = performance.now();
                    
                    // Retry logic with Semaphore and Exponential Backoff (Per Key)
                    const MAX_RETRIES = 2; // Reduced retries per key since we have multiple keys
                    let attempt = 0;
                    let webBaseURLOverride: string | undefined = undefined;
                    let switchedOffMoonshotProxy = false;
                    let effTools: any[] = externalTools;

                    while (attempt < MAX_RETRIES) {
                        try {
                            await apiLimiter.acquire();
                            try {
                                 const nativeActive = useNativeSearch && !nativeSearchBlocked;
                                 effTools = (!toolsAllowed || toolsDisabled) ? [] : (nativeActive ? nativeSearchTools : externalTools);
                                 const extraBody = buildRequestExtras({
                                     provider: effProvider,
                                     model,
                                     reasoningEffort,
                                     maxTokens: effMaxTokens,
                                     nativeSearch: nativeActive
                                 });
                                 completion = await createCompletion(currentMessages, effTools, webBaseURLOverride, currentKey, extraBody);
                            } finally {
                                apiLimiter.release();
                            }
                            break; // Success
                        } catch (apiError: any) {
                            console.error(`AI Chat API failed (Key ${i}, Attempt ${attempt + 1}/${MAX_RETRIES})`, apiError);
                            const status = (apiError && typeof apiError.status === 'number') ? apiError.status : (apiError?.response?.status);
                            const msg = String(apiError?.message || '');
                            const is5xx = typeof status === 'number' && status >= 500 && status < 600;
                            const is429 = status === 429;
                            const isConnectionError =
                                apiError?.name === 'APIConnectionError' ||
                                msg.toLowerCase().includes('connection error') ||
                                msg.toLowerCase().includes('failed to fetch') ||
                                msg.toLowerCase().includes('network error');
                            const looksServiceUnavailable = msg.includes('503') || msg.toLowerCase().includes('service unavailable');

                            // Native search params/tools may be rejected by some models:
                            // fall back to the app's external search on the next attempt.
                            if (useNativeSearch && !nativeSearchBlocked && isUnsupportedParamError(apiError)) {
                                nativeSearchBlocked = true;
                                continue;
                            }

                            // Some endpoints reject tool definitions outright: drop
                            // them for this model and try the request again.
                            if (toolsAllowed && !toolsDisabled && isToolsUnsupportedError(apiError)) {
                                toolsAllowed = false;
                                learnedNoTools.add(modelPolicyKey(effProvider, model));
                                continue;
                            }

                            // The provider may cap the budget we asked for (or the
                            // prompt left no room); retry with a value it accepts.
                            const tokenLimit = parseTokenLimitRequirement(apiError);
                            if (tokenLimit && !tokenLimitAdjusted) {
                                tokenLimitAdjusted = true;
                                effMaxTokens = tokenLimit.shrink
                                    ? Math.max(4000, Math.floor((effMaxTokens ?? MAX_TOKEN_CEILING) / 2))
                                    : Math.min(tokenLimit.limit as number, MAX_TOKEN_CEILING);
                                continue;
                            }

                            // Models may reject the value we picked or the field itself;
                            // learn the rule so the next call sends what they accept.
                            const temperatureRequirement = parseTemperatureRequirement(apiError);
                            if (temperatureRequirement && !temperatureAdjusted) {
                                temperatureAdjusted = true;
                                rememberTemperaturePolicy(effProvider, model, temperatureRequirement);
                                effTemperature = temperatureRequirement.kind === 'value' ? temperatureRequirement.value : undefined;
                                continue;
                            }

                            if (!isTauri && !switchedOffMoonshotProxy && (effProvider === 'moonshot') && isConnectionError) {
                                const usingMoonshotDevProxy = (finalBaseURL || '').includes('/api/moonshot/');
                                if (usingMoonshotDevProxy) {
                                    switchedOffMoonshotProxy = true;
                                    webBaseURLOverride = 'https://api.moonshot.cn/v1';
                                    continue;
                                }
                            }

                            if (is429 || is5xx || looksServiceUnavailable || isConnectionError) {
                                attempt++;
                                if (attempt < MAX_RETRIES) {
                                    const delay = 1000 * Math.pow(2, attempt - 1);
                                    await new Promise(resolve => setTimeout(resolve, delay));
                                    continue;
                                }
                            }
                            throw apiError;
                        }
                    }

                    const normalizeAssistantMessage = (c: any): any => {
                        try {
                            if (!c) return { content: "" };
                            if (typeof c === 'string') return { content: c };
                            // OpenAI/Moonshot style
                            if (Array.isArray(c.choices)) {
                                if (c.choices.length > 0) {
                                    return c.choices[0].message ?? c.choices[0].delta ?? c.choices[0];
                                }
                                return { content: "" };
                            }
                            // Common wrappers
                            if (c.result) return normalizeAssistantMessage(c.result);
                            if (c.data) return normalizeAssistantMessage(c.data);
                            if (c?.message) return c.message;
                            if (typeof c?.output_text === 'string') return { content: c.output_text };
                            if (typeof c?.content === 'string') return { content: c.content };
                            if (Array.isArray(c?.content)) return { content: c.content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('') };
                            return { content: "" };
                        } catch {
                            return { content: "" };
                        }
                    };
                    const message = normalizeAssistantMessage(completion);
                    try {
                        useAIStore.getState().appendLog({
                            id: uuidv4(),
                            ts: Date.now(),
                            channel: 'ai',
                            provider: effProvider,
                            model,
                            baseURL: finalBaseURL,
                            request: { messages: currentMessages, temperature, tools: effTools },
                            response: completion,
                            durationMs: Math.round(performance.now() - startTs)
                        });
                    } catch {}

                    // If the model wants to call a tool
                    const toolCalls = (message && (message.tool_calls || (message.function_call ? [{ type: 'function', id: 'fn', function: message.function_call }] : []))) || [];
                    if (toolCalls && toolCalls.length > 0) {
                        currentMessages.push(message); // Add assistant's tool call message
                        
                        let executedAny = false;
                        for (const toolCall of toolCalls) {
                            if (toolCall.function && toolCall.function.name === 'web_search') {
                                try {
                                    const args = JSON.parse(toolCall.function.arguments || '{}');
                                    const q = args.query;
                                    if (q) {
                                        // Execute search (forced when the caller asked for it
                                        // even though the global search toggle is off).
                                        const results = await performClientSideSearch(q, !!options.forceSearch);
                                        currentMessages.push({
                                            role: "tool",
                                            tool_call_id: toolCall.id,
                                            name: "web_search",
                                            content: results || "No relevant search results found."
                                        });
                                        executedAny = true;
                                    } else {
                                        currentMessages.push({
                                            role: "tool",
                                            tool_call_id: toolCall.id,
                                            name: "web_search",
                                            content: "Error: No query provided."
                                        });
                                    }
                                } catch (e) {
                                    currentMessages.push({
                                        role: "tool",
                                        tool_call_id: toolCall.id,
                                        name: "web_search",
                                        content: "Error: Invalid arguments."
                                    });
                                }
                            }
                        }
                        
                        if (!executedAny) {
                             // Should not happen if we filtered tools correctly
                             break;
                        }
                        turnCount++;
                        // Search budget spent: let the loop run once more without
                        // tools so the model still answers instead of returning "".
                        if (turnCount >= MAX_SEARCH_ROUNDS) toolsDisabled = true;
                    } else {
                        // Final response
                        const content = message.content || "";
                        if (content) return content;

                        // Truncated before any output: thinking models can burn the
                        // whole token budget on reasoning (finish_reason=length with
                        // empty content). Raise the budget and ask again.
                        const finishReason = completion?.choices?.[0]?.finish_reason;
                        if (finishReason === 'length' && budgetRaises < 2) {
                            budgetRaises++;
                            effMaxTokens = budgetRaises === 1
                                ? Math.min(Math.max((effMaxTokens ?? 0) * 4, REASONING_TOKEN_FLOOR), MAX_TOKEN_CEILING)
                                : Math.min((effMaxTokens ?? REASONING_TOKEN_FLOOR) * 2, MAX_TOKEN_CEILING);
                            toolsDisabled = true;
                            currentMessages.push({
                                role: "user",
                                content: "Output the final answer now, in the format requested above, without calling any tools."
                            });
                            continue;
                        }

                        if (!turnCount || emptyAnswerNudged) return content;
                        emptyAnswerNudged = true;
                        toolsDisabled = true;
                        currentMessages.push({
                            role: "user",
                            content: "Output the final answer now, in the format requested above, without calling any tools."
                        });
                    }
                } // end while turns

                // If we exit loop without return, return empty string?
                return "";
                
            } catch (err: any) {
                console.warn(`API call failed with key index ${i}:`, err);
                lastError = err;
                
                const errStr = String(err).toLowerCase();
                const isAuthError = errStr.includes("401") || errStr.includes("unauthorized") || errStr.includes("invalid api key");
                const isRateLimit = errStr.includes("429") || errStr.includes("quota") || errStr.includes("rate limit") || errStr.includes("too many requests");
                const isServerOverload = errStr.includes("503") || errStr.includes("500") || errStr.includes("502");
                
                // Retry only on specific errors if there are more keys
                if ((isAuthError || isRateLimit || isServerOverload) && i < apiKeys.length - 1) {
                    continue; // Try next key
                } else {
                    throw err; // Re-throw if it's not a retryable error or last key
                }
            }
        }
        
        throw lastError || new Error("All API keys failed");

    } catch (e: any) {
        console.error("AI Call Final Error:", e);
        throw e;
    }
};

const normalizeMediaItem = (item: any): any => {
    const s = (v: any) => String(v || '').trim();
    
    // Map director/author
    let directorOrAuthor = s(item.directorOrAuthor);
    if (!directorOrAuthor || directorOrAuthor.toLowerCase() === 'unknown') {
        const alt = s(item.director || item.Director || item.author || item.Author || item.creator || item.Creator || item.artist || item.Artist);
        if (alt) directorOrAuthor = alt;
    }
    
    // Map releaseDate
    let releaseDate = s(item.releaseDate);
    if (!releaseDate || releaseDate.toLowerCase() === 'unknown') {
        const alt = s(item.release_date || item.ReleaseDate || item.publishedDate || item.year || item.Year || item.date || item.Date || item.first_air_date);
        if (alt) releaseDate = alt;
    }
    
    // Map description
    let description = s(item.description);
    if (!description || description.toLowerCase() === 'unknown') {
        const alt = s(item.desc || item.Description || item.summary || item.Summary || item.plot || item.Plot || item.overview || item.Overview || item.intro || item.synopsis);
        if (alt) description = alt;
    }
    
    // Map cast
    let cast = item.cast;
    if (!cast || !Array.isArray(cast) || cast.length === 0) {
        const c = item.cast || item.Cast || item.actors || item.Actors || item.starring || item.Starring;
        if (Array.isArray(c)) cast = c;
        else if (typeof c === 'string') cast = c.split(/[,;]/).map((x: string) => x.trim()).filter((x: string) => x);
    }
    
    return {
        ...item,
        directorOrAuthor,
        releaseDate,
        description,
        cast
    };
};

/**
 * Streaming variant of callAI for chat use-cases: forwards each content delta
 * to `onDelta` as it arrives and resolves with the full reply text. Search
 * tools are never injected here — the caller decides via extraBody-free plain
 * messages (character chat disables networking on purpose).
 */
export const callAIStream = async (
    messages: any[],
    temperature: number = 0.7,
    options: { onDelta: (text: string) => void; configOverride?: { baseURL?: string; apiKey?: string; model?: string; provider?: AIProvider } } = { onDelta: () => {} }
): Promise<string> => {
    const { onDelta } = options;
    const state = useAIStore.getState();
    const override = options.configOverride || {};
    const effProvider: AIProvider = (override.provider as AIProvider) ?? (state.provider as AIProvider);
    const baseURL = override.baseURL ?? state.baseUrl;
    const model = override.model ?? state.model;

    let apiKey = override.apiKey ?? state.getDecryptedApiKey();
    if (!apiKey) {
        try {
            const envKey = (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.VITE_MOONSHOT_API_KEY) ? (import.meta as any).env.VITE_MOONSHOT_API_KEY : undefined;
            if (envKey && envKey !== 'undefined') {
                apiKey = String(envKey);
            }
        } catch {}
    }
    if (!apiKey) return "";

    const keyList = apiKey.split(/[;；]/).map(k => k.trim()).filter(Boolean);

    const isTauri = typeof window !== 'undefined' && (
        ('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window) ||
        (typeof window.location !== 'undefined' && (
            window.location.protocol === 'tauri:' ||
            (typeof window.location.origin === 'string' && window.location.origin.startsWith('http://tauri.localhost'))
        ))
    );

    let finalBaseURL = (baseURL || "https://api.moonshot.cn/v1")
        .trim()
        .replace(/[\s)]+$/g, "")
        .replace(/[()]/g, "")
        .replace(/^"+|"+$/g, "")
        .replace(/^'+|'+$/g, "");

    const ensureV1IfNeeded = (prov: AIProvider, url: string) => {
        const hasV1 = url.endsWith('/v1') || url.includes('/v1/');
        const isGoogleOpenAI = url.includes('/openai/');
        if (isGoogleOpenAI) return url;
        if (url.includes('api.deepseek.com')) return url;
        if ((prov === 'openai' || prov === 'mistral' || prov === 'moonshot') && !hasV1) {
            return url.endsWith('/') ? `${url}v1` : `${url}/v1`;
        }
        return url;
    };
    finalBaseURL = ensureV1IfNeeded(effProvider as AIProvider, finalBaseURL);

    // Same temperature policy as the non-streaming path (catalog + learned).
    let effTemperature = resolveTemperature(effProvider, model, temperature);

    let lastError: any = null;
    let temperatureAdjusted = false;

    /** Transient failures worth another try before giving up on the reply. */
    const isTransientStreamError = (e: any): boolean => {
        const status = Number(e?.status || e?.response?.status || 0);
        const msg = String(e?.message || e || '');
        if (status === 429 || (status >= 500 && status < 600)) return true;
        if (e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError') return true;
        return /429|rate limit|too many requests|5\d\d|service unavailable|overloaded|timeout|timed out|fetch failed|failed to fetch|connection (error|reset|closed)|network error|econnreset|socket hang up|stream interrupted|error decoding|incomplete message|unexpected eof|broken pipe|aborted/i.test(msg);
    };

    for (let keyIndex = 0; keyIndex < keyList.length; keyIndex++) {
        const effApiKey = keyList[keyIndex];
        // The same key may be retried after the temperature policy is learned or
        // after a transient provider failure (a single-key setup used to fail the
        // whole reply on the first 429/network blip).
        let keyExhausted = false;
        let streamRetries = 0;
        for (let attempt = 0; attempt < 4 && !keyExhausted; attempt++) {
            let streamStarted = false;
            let full = '';

            try {
                if (isTauri) {
                    const { useSystemProxy, getProxyUrl } = useAIStore.getState();
                    const rustConfig = {
                        model,
                        baseURL: finalBaseURL,
                        apiKey: effApiKey,
                        proxy_url: getProxyUrl(),
                        use_system_proxy: useSystemProxy
                    };
                    const { Channel } = await import('@tauri-apps/api/core');
                    const channel = new Channel<any>();
                    let streamError: string | null = null;
                    channel.onmessage = (evt: any) => {
                        const event = typeof evt === 'string' ? JSON.parse(evt) : evt;
                        if (event?.type === 'delta' && event.text) {
                            streamStarted = true;
                            full += event.text;
                            onDelta(event.text);
                        } else if (event?.type === 'error') {
                            streamError = event.message || 'stream error';
                        }
                    };
                    await invoke('ai_chat_stream', {
                        messages,
                        temperature: effTemperature,
                        extra_body: {},
                        config: rustConfig,
                        on_event: channel
                    });
                    if (!full) throw new Error(streamError || 'empty-ai-response');
                    return full;
                } else {
                    const client = new OpenAI({
                        apiKey: effApiKey,
                        baseURL: finalBaseURL,
                        dangerouslyAllowBrowser: true
                    });
                    const stream = await client.chat.completions.create({
                        model: model || "gpt-5.6-terra",
                        messages,
                        temperature: effTemperature,
                        stream: true
                    } as any);
                    for await (const chunk of stream as any) {
                        const delta = chunk?.choices?.[0]?.delta?.content || '';
                        if (delta) {
                            streamStarted = true;
                            full += delta;
                            onDelta(delta);
                        }
                    }
                    if (!full) throw new Error('empty-ai-response');
                    return full;
                }
            } catch (e: any) {
                lastError = e;
                // Models may reject the temperature value or the field itself; learn
                // the rule and re-issue the request before falling back to another key.
                const temperatureRequirement = streamStarted ? null : parseTemperatureRequirement(e);
                if (temperatureRequirement && !temperatureAdjusted) {
                    temperatureAdjusted = true;
                    rememberTemperaturePolicy(effProvider, model, temperatureRequirement);
                    effTemperature = temperatureRequirement.kind === 'value' ? temperatureRequirement.value : undefined;
                    continue;
                }
                // Transient provider trouble (429 / 5xx / network) gets the same
                // backoff treatment the non-streaming path already had.
                if (!streamStarted && streamRetries < 2 && isTransientStreamError(e)) {
                    streamRetries++;
                    const delay = 1000 * Math.pow(2, streamRetries - 1);
                    console.warn(`AI stream failed (${String(e?.message || e).slice(0, 120)}), retrying in ${delay}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                // A key rotation is only safe before the first delta reached the UI;
                // afterwards the consumer already rendered partial output.
                const msg = String(e?.message || e || '');
                try {
                    useAIStore.getState().appendLog({
                        id: uuidv4(),
                        ts: Date.now(),
                        channel: 'ai',
                        provider: effProvider,
                        model,
                        baseURL: finalBaseURL,
                        request: { messages, temperature: effTemperature, stream: true },
                        response: { error: msg.slice(0, 400) },
                        durationMs: 0,
                    });
                } catch {}
                const retryable = !streamStarted && (msg.includes('401') || msg.includes('429') || msg.includes('API Error'));
                if (retryable && keyIndex < keyList.length - 1) {
                    keyExhausted = true;
                    continue;
                }
                throw e;
            }
        }
    }

    throw lastError || new Error('AI streaming failed');
};

export const searchMedia = async (query: string, type?: MediaType | 'All'): Promise<MediaItem[]> => {
  const q = query.trim();
  if (!q) return [];

  const diagEnabled = useAIStore.getState().enableSearchDiagnostics;
  const diagStartEpoch = Date.now();
  const diagStartPerf = performance.now();
  const diagSteps: SearchDiagnostics['steps'] = [];
  const diagProviders = new Set<string>();
  const diagQuota: SearchDiagnostics['quota'] = [];

  const addStep = (name: string, startPerf: number, provider?: string, details?: any) => {
    const durationMs = Math.max(0, Math.round(performance.now() - startPerf));
    diagSteps.push({ name, durationMs, provider, details });
    if (provider) diagProviders.add(provider);
  };

  const extractTokenUsage = (resp: any) => {
    const u = resp?.usage;
    if (u && typeof u === 'object') {
      const input = u.prompt_tokens ?? u.input_tokens ?? u.promptTokens;
      const output = u.completion_tokens ?? u.output_tokens ?? u.completionTokens;
      const total = u.total_tokens ?? u.totalTokens ?? (typeof input === 'number' && typeof output === 'number' ? input + output : undefined);
      return { input, output, total };
    }
    const um = resp?.usageMetadata;
    if (um && typeof um === 'object') {
      const input = um.promptTokenCount ?? um.inputTokenCount ?? um.prompt_tokens ?? um.input_tokens;
      const output = um.candidatesTokenCount ?? um.outputTokenCount ?? um.completion_tokens ?? um.output_tokens;
      const total = um.totalTokenCount ?? um.total_tokens ?? (typeof input === 'number' && typeof output === 'number' ? input + output : undefined);
      return { input, output, total };
    }
    return {};
  };

  const finalizeDiagnostics = () => {
    if (!diagEnabled) return;
    const endEpoch = Date.now();
    const logs = (useAIStore.getState().logs || []).filter(l => typeof l?.ts === 'number' && l.ts >= diagStartEpoch && l.ts <= endEpoch);

    const searchLogs = logs.filter(l => l.channel === 'search');
    const bySearchProvider = new Map<string, { count: number; durationMs: number }>();
    for (const l of searchLogs) {
      const p = String(l.provider || 'unknown');
      const cur = bySearchProvider.get(p) || { count: 0, durationMs: 0 };
      cur.count += 1;
      cur.durationMs += typeof l.durationMs === 'number' ? l.durationMs : 0;
      bySearchProvider.set(p, cur);
      diagProviders.add(p);
    }
    for (const [p, v] of bySearchProvider.entries()) {
      diagQuota.push({ provider: p, unit: 'request', amount: v.count, details: { durationMs: v.durationMs } });
    }

    const aiLogs = logs.filter(l => l.channel === 'ai');
    const latestAi = aiLogs.sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
    if (latestAi) {
      const tok = extractTokenUsage(latestAi.response);
      const total = typeof tok.total === 'number' ? tok.total : undefined;
      if (typeof total === 'number') {
        diagQuota.push({
          provider: String(latestAi.provider || 'ai'),
          unit: 'token',
          amount: total,
          details: { input: tok.input, output: tok.output, model: latestAi.model }
        });
      }
      if (latestAi.provider) diagProviders.add(String(latestAi.provider));
    }

    const diagnostics: SearchDiagnostics = {
      query: q,
      type: String(type || 'All'),
      at: new Date().toISOString(),
      totalDurationMs: Math.max(0, Math.round(performance.now() - diagStartPerf)),
      providers: Array.from(diagProviders.values()),
      steps: diagSteps,
      quota: diagQuota
    };
    try {
      useAIStore.getState().setConfig({ lastSearchDiagnostics: diagnostics });
    } catch {}
  };

  const langKey = i18n.language.split('-')[0];
  // v2: relevance gating changed result quality — don't serve pre-v2 cached garbage.
  const cacheKey = `media_tracker_search_v2_${langKey}_${type || 'All'}_${q.toLowerCase()}`;
  const cacheTsKey = `${cacheKey}_ts`;
  const cacheStepT0 = performance.now();
  try {
    const cachedData = localStorage.getItem(cacheKey);
    const cachedTs = localStorage.getItem(cacheTsKey);
    if (cachedData && cachedTs) {
      const now = Date.now();
      const last = parseInt(cachedTs, 10);
      const ttl = 2 * 60 * 60 * 1000;
      if (now - last < ttl) {
        const parsed = JSON.parse(cachedData);
        if (Array.isArray(parsed)) {
          if (diagEnabled) {
            addStep('缓存命中', cacheStepT0, 'cache', { ttlMs: ttl });
            finalizeDiagnostics();
          }
          return parsed as MediaItem[];
        }
      }
    }
  } catch {}
  if (diagEnabled) addStep('缓存检查', cacheStepT0, 'cache');

  const isChinese = i18n.language.startsWith('zh');
  const enableBangumi = useAIStore.getState().enableBangumi;

  // Parallel Execution: TMDB, Bangumi, Plugins, and AI Search Context
  const parallelT0 = performance.now();
  const timed = async <T,>(name: string, provider: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    const t0 = performance.now();
    try {
      const res = await fn();
      if (diagEnabled) addStep(name, t0, provider, { ok: true });
      return res;
    } catch (e: any) {
      if (diagEnabled) addStep(name, t0, provider, { ok: false, error: e?.message || String(e) });
      return fallback;
    }
  };

  const bangumiPromise = enableBangumi
    ? timed(
        'Bangumi 搜索',
        'bangumi',
        async () => {
          let bType = undefined;
          if (type === MediaType.BOOK) bType = 1;
          if (type === MediaType.TV_SERIES || type === MediaType.COMIC) bType = 2;
          if (type === MediaType.MUSIC) bType = 3;
          return await searchBangumi(q, bType);
        },
        []
      )
    : Promise.resolve([]);

  const [tmdbRes, bangumiRes, pluginRes] = await Promise.all([
    timed(
      'TMDB 搜索',
      'tmdb',
      async () => {
        if (!type || type === 'All' || type === MediaType.MOVIE || type === MediaType.TV_SERIES) {
          const t = (type === MediaType.MOVIE) ? 'movie' : (type === MediaType.TV_SERIES) ? 'tv' : 'multi';
          return await searchTMDB(q, t as any);
        }
        return [];
      },
      []
    ),
    bangumiPromise,
    timed(
      '插件搜索',
      'plugin',
      async () => {
        const { getEnabledPlugins } = usePluginStore.getState();
        const plugins = getEnabledPlugins();
        if (plugins.length === 0) return [];
        const results = await Promise.all(plugins.map(async p => {
          try {
            const executor = new PluginExecutor(p);
            return await executor.executeSearch(q);
          } catch {
            return [];
          }
        }));
        return results.flat();
      },
      []
    )
  ]);
  if (diagEnabled) addStep('并行阶段', parallelT0, 'parallel');

  // Convert Plugin Results
  const pluginItems: MediaItem[] = pluginRes.map((item: any) => {
      const normalizeType = (t: string | undefined): MediaType => {
          const s = (t || '').toLowerCase();
          if (s.includes('movie') || s.includes('film')) return MediaType.MOVIE;
          if (s.includes('tv') || s.includes('series')) return MediaType.TV_SERIES;
          if (s.includes('book') || s.includes('novel')) return MediaType.BOOK;
          if (s.includes('comic') || s.includes('manga')) return MediaType.COMIC;
          if (s.includes('music') || s.includes('album')) return MediaType.MUSIC;
          if (s.includes('short')) return MediaType.SHORT_DRAMA;
          return MediaType.OTHER;
      };

      return {
          id: uuidv4(),
          title: item.title,
          directorOrAuthor: item.directorOrAuthor || "",
          description: item.description || "",
          releaseDate: item.year || "",
          type: normalizeType(item.type),
          isOngoing: false,
          posterUrl: normalizeImageUrl(item.poster),
          rating: item.rating,
          status: 'To Watch',
          addedAt: new Date().toISOString()
      };
  });

  // Convert TMDB Results
  const tmdbItems: MediaItem[] = tmdbRes
    .filter((item: any) => item.media_type !== 'person')
    .map((item: any) => ({
      id: uuidv4(),
      title: item.title || item.name || query,
      directorOrAuthor: "", 
      description: item.overview || "",
      releaseDate: item.release_date || item.first_air_date || "",
      type: item.media_type === 'movie' ? MediaType.MOVIE : MediaType.TV_SERIES,
      isOngoing: false,
      posterUrl: getTMDBPosterUrl(item.poster_path) || undefined,
      tmdbId: typeof item.id === 'number' ? item.id : undefined,
      tmdbMediaType: item.media_type === 'movie' || item.media_type === 'tv' ? item.media_type : undefined,
      rating: item.vote_average ? `${item.vote_average.toFixed(1)}/10` : undefined,
      status: 'To Watch',
      addedAt: new Date().toISOString()
  }));

  // Convert Bangumi Results
  const bangumiItems: MediaItem[] = bangumiRes.map((item: any) => {
      let mType = MediaType.OTHER;
      if (item.type === 1) mType = MediaType.BOOK;
      else if (item.type === 2) mType = MediaType.TV_SERIES; 
      else if (item.type === 3) mType = MediaType.MUSIC;
      else if (item.type === 6) mType = MediaType.TV_SERIES;

      const releaseDate = String(item.date || item.air_date || '').trim();
      const rawPoster = String(item.images?.large || item.images?.common || '').trim();
      const posterUrl = rawPoster ? normalizeImageUrl(rawPoster.replace(/^http:\/\//i, 'https://')) : undefined;
      const score = (typeof item.score === 'number' ? item.score : (typeof item.rating?.score === 'number' ? item.rating.score : undefined));
      
      return {
          id: uuidv4(),
          title: item.name_cn || item.name,
          directorOrAuthor: "",
          description: item.summary || "",
          releaseDate,
          type: mType,
          isOngoing: false,
          posterUrl,
          rating: (typeof score === 'number' && !Number.isNaN(score)) ? `${score}/10` : undefined,
          status: 'To Watch',
          addedAt: new Date().toISOString()
      };
  });

  const baseItems = [...pluginItems, ...tmdbItems, ...bangumiItems];
  const baseItemsForCount = (type && type !== 'All') ? baseItems.filter(it => it.type === type) : baseItems;
  const baseUnique = new Map<string, MediaItem>();
  for (const item of baseItemsForCount) {
      const normTitle = item.title.trim().toLowerCase();
      let key = normTitle;
      if (item.releaseDate && item.releaseDate.length >= 4) {
          key = `${normTitle}|${item.releaseDate.substring(0, 4)}`;
      }
      if (!baseUnique.has(key)) baseUnique.set(key, item);
  }
  const normalizeKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();
  const qKey = normalizeKey(q);
  // Title relevance vs the query. Providers like Bangumi return loosely-related
  // entries (shared genre/keywords) that would otherwise bury the real match.
  // 100 = exact title, 90 = containment, 70/30 = token overlap, 0 = unrelated.
  const relevanceScore = (title: string): number => {
    const t = normalizeKey(title);
    if (!t || !qKey) return 0;
    if (t === qKey) return 100;
    if (t.includes(qKey) || qKey.includes(t)) return 90;
    const qTokens = q.toLowerCase().split(/[\s,，.。·:：]+/).map(normalizeKey).filter(w => w.length >= 2);
    if (qTokens.length >= 2) {
      const hits = qTokens.filter(w => t.includes(w)).length;
      if (hits === qTokens.length) return 70;
      if (hits > 0) return 30;
    }
    return 0;
  };
  const baseScores = Array.from(baseUnique.values()).map(it => relevanceScore(it.title));
  const hasExactBaseMatch = baseScores.some(s => s === 100);
  // Consult the AI unless we already have the exact work, or several
  // title-relevant hits (previously any 8+ results suppressed the AI call,
  // which let fuzzy matches bury the real one).
  const shouldUseAI = !hasExactBaseMatch && !(baseScores.filter(s => s >= 90).length >= 4);

  let searchContext = "";
  // The AI call below forces search, so when the model can search natively the
  // engine-API context is redundant — let the model's built-in search do it.
  const useSearchContext = shouldUseAI && baseUnique.size < 4 && !canUseNativeSearch(true);
  if (useSearchContext) {
      searchContext = await timed(
        '网页搜索上下文',
        String(useAIStore.getState().searchProvider || 'search'),
        async () => await performClientSideSearch(q, true, type),
        ""
      );
  }

  // Prefetch images from search context
  try {
    if (searchContext) {
      const parsedSC = JSON.parse(searchContext);
      if (Array.isArray(parsedSC)) {
        parsedSC.forEach((item: any) => {
          if (item.title && item.image) {
            const img = normalizeImageUrl(item.image);
            if (!img) return;
            if (img.toLowerCase().includes('tiktok.com/api/img')) return;
            if (img.toLowerCase().includes('m.media-amazon.com')) return;
            prefetchedImages.set(item.title.toLowerCase(), img);
            const { title } = processSearchResult(item.title, item.snippet || "");
            prefetchedImages.set(title.toLowerCase(), img);
          }
        });
      }
    }
  } catch {}
  
  const { systemPrompt, provider } = useAIStore.getState();
  
  let aiItems: MediaItem[] = [];
  if (shouldUseAI) {
      let userPrompt = "";

      const toolCallingProviders: AIProvider[] = ['moonshot', 'deepseek', 'openai', 'qwen', 'google', 'mistral', 'mimo', 'zhipu'];
      if (toolCallingProviders.includes(provider as AIProvider)) {
          if (isChinese) {
              userPrompt = `搜索符合以下查询的媒体作品: "${query}"。`;
              if (type && type !== 'All') {
                  userPrompt += ` 严格限制结果类型为: "${type}"。`;
              } else {
                  userPrompt += ` (包括书籍、电影、电视剧、漫画、短剧)`;
              }
              userPrompt += `\n[限制] 仅返回作品（小说、电影、电视剧、短剧、漫画、音乐专辑）。严禁返回新闻、产品评测、对比、参数、价格、手机/电子产品相关条目。`;
              userPrompt += `\n[系列] 若查询为系列作品（如第一部/第二部/续集），请分别返回各部作品，并给出准确年份。`;
              userPrompt += `\n[优先] 使用联网搜索工具 (web_search) 获取最新信息；如网络不可用或搜索无结果，请基于已有知识返回有效 JSON：\n${searchContext}\n请尽力补全缺失的元数据（导演、主演、简介（尽量详细，不少于50字）、上映日期）。若无法确认具体日期，可返回年份。`;
          } else {
              userPrompt = `Search for media works matching the query: "${query}".`;
              if (type && type !== 'All') {
                  userPrompt += ` Strictly limit results to type: "${type}".`;
              } else {
                  userPrompt += ` (books, movies, TV series, comics, short dramas)`;
              }
              userPrompt += `\n[Constraint] Only return works (novels, movies, TV series, short dramas, comics, music albums). Do NOT include news, product reviews, comparisons, specs, prices, or phone/electronics items.`;
              userPrompt += `\n[PREFER] Use the web search tool; if unavailable or no results, rely on your internal knowledge to return a valid JSON array:\n${searchContext}\nPlease do your best to fill in missing metadata (Director, Cast, Description (detailed, >50 words), Release Date). If exact date is unknown, year is acceptable.`;
          }
      } else {
          if (isChinese) {
              userPrompt = `搜索符合以下查询的媒体作品: "${query}"。`;
              if (type && type !== 'All') {
                  userPrompt += ` 严格限制结果类型为: "${type}"。`;
              } else {
                  userPrompt += ` (包括书籍、电影、电视剧、漫画、短剧)`;
              }
              userPrompt += `\n[系列] 若查询为系列作品（如第一部/第二部/续集），请分别返回各部作品，并给出准确年份。`;
              userPrompt += `\n请利用你的联网搜索工具或参考以下搜索结果来获取准确信息：\n${searchContext}\n如搜索结果不足，请使用你的内部知识补全信息（导演、主演、简介）。请务必返回有效JSON数组。`;
          } else {
              userPrompt = `Search for media works matching the query: "${query}".`;
              if (type && type !== 'All') {
                  userPrompt += ` Strictly limit results to type: "${type}".`;
              } else {
                  userPrompt += ` (books, movies, TV series, comics, short dramas)`;
              }
              userPrompt += `\nUse your web search tool or refer to the following search results to verify info:\n${searchContext}\nIf search results are insufficient, please use your internal knowledge to complete the metadata (especially detailed description). Return ONLY a valid JSON array.`;
          }
      }

      const messages = [
        { role: "system", content: systemPrompt + (isChinese ? " 请务必使用JSON格式返回。不要使用Markdown代码块。只返回JSON数组。" : " Please return strictly valid JSON. Do not use markdown code blocks. Return ONLY a JSON array.") },
        ...(searchContext ? [{ role: "user", content: searchContext }] : []),
        { role: "user", content: userPrompt }
      ];

      try {
        const aiT0 = performance.now();
        const text = await callAI(messages, 0.1, { forceSearch: true });
        if (diagEnabled) addStep('AI 生成候选作品', aiT0, String(provider || 'ai'));
        if (text) {
            let jsonStr = "";
            const jsonArrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
            if (jsonArrayMatch) {
                jsonStr = jsonArrayMatch[0];
            } else {
                jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
            }

            let rawData: any[] = [];
            if (jsonStr.startsWith('[') || jsonStr.startsWith('{')) {
                try {
                    rawData = JSON.parse(jsonStr);
                } catch (e) {
                    const lastBracket = jsonStr.lastIndexOf('}');
                    if (lastBracket > 0) {
                        try {
                            rawData = JSON.parse(jsonStr.substring(0, lastBracket + 1) + ']');
                        } catch {}
                    }
                }
            }

            if (rawData.length > 0) {
                 aiItems = rawData.map((rawItem) => {
                    const item = normalizeMediaItem(rawItem);
                    const id = uuidv4();
                    const placeholder = getPlaceholder(item.type || 'Media');
                    const posterUrl = prefetchedImages.get(item.title.toLowerCase()) || undefined;
                    const normalizeType = (v: any, title: string, desc?: string): MediaType => {
                        const s = String(v || '').toLowerCase();
                        if (s.includes('novel') || s.includes('book') || s.includes('小说') || s.includes('书')) return MediaType.BOOK;
                        if (s.includes('album') || s.includes('music') || s.includes('专辑') || s.includes('音乐')) return MediaType.MUSIC;
                        if (s.includes('tv') || s.includes('series') || s.includes('season') || s.includes('电视剧') || s.includes('剧集')) return MediaType.TV_SERIES;
                        if (s.includes('comic') || s.includes('manga') || s.includes('漫画')) return MediaType.COMIC;
                        if (s.includes('short') || s.includes('短剧')) return MediaType.SHORT_DRAMA;
                        if (s.includes('movie') || s.includes('film') || s.includes('电影')) return MediaType.MOVIE;
                        const inferred = processSearchResult(title, desc || '');
                        return inferred.type || MediaType.MOVIE;
                    };
                    const normalizedType = normalizeType((item as any).type, item.title, (item as any).description);
                    return {
                        ...item,
                        type: normalizedType,
                        id,
                        posterUrl: posterUrl || placeholder,
                        userRating: 0,
                        status: 'To Watch',
                        addedAt: new Date().toISOString()
                    } as MediaItem;
                });
            }
        }
        
        if (aiItems.length === 0) {
            try {
                aiItems = await createFallbackItemsFromContext(searchContext) as MediaItem[];
            } catch {}
        }
      } catch (e) {
          console.error("AI Search Failed", e);
      }
  }

  const norm = (v?: string) => String(v || '').trim();
  const isUnknownText = (v?: string) => {
      const s = norm(v);
      if (!s) return true;
      const low = s.toLowerCase();
      return low === 'unknown' || s === '未知' || low === 'n/a' || low === 'na' || s === '-';
  };
  const isFullDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(norm(v));
  const dateScore = (v?: string) => {
      const s = norm(v);
      if (!s || isUnknownText(s)) return 0;
      if (/^\d{4}$/.test(s)) return 1;
      if (/^\d{4}-\d{2}$/.test(s)) return 2;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 3;
      if (s.length >= 10) return 2;
      if (s.length >= 4) return 1;
      return 0;
  };
  const pickBetterDate = (a?: string, b?: string) => {
      const sa = dateScore(a);
      const sb = dateScore(b);
      if (sb > sa) return norm(b);
      return norm(a);
  };
  const pickText = (a?: string, b?: string) => {
      const sa = norm(a);
      const sb = norm(b);
      if (isUnknownText(sa) && !isUnknownText(sb)) return sb;
      if (!isUnknownText(sa) && isUnknownText(sb)) return sa;
      if (!isUnknownText(sa) && !isUnknownText(sb)) {
          if (sb.length > sa.length) return sb;
          return sa;
      }
      return '';
  };
  const pickCast = (a?: string[], b?: string[]) => {
      const ca = Array.isArray(a) ? a.filter(Boolean) : [];
      const cb = Array.isArray(b) ? b.filter(Boolean) : [];
      if (cb.length > ca.length) return cb.slice(0, 5);
      return ca.slice(0, 5);
  };
  const mergeMediaItems = (base: MediaItem, incoming: MediaItem): MediaItem => {
      const merged: MediaItem = { ...base };
      merged.releaseDate = pickBetterDate(base.releaseDate, incoming.releaseDate);
      merged.directorOrAuthor = pickText(base.directorOrAuthor, incoming.directorOrAuthor);

      const incomingIsTMDB = !!incoming.tmdbId || incoming.tmdbMediaType === 'movie' || incoming.tmdbMediaType === 'tv';
      if (incomingIsTMDB && !isUnknownText(incoming.description)) {
          merged.description = isUnknownText(base.description) ? incoming.description : base.description;
      } else {
          merged.description = pickText(base.description, incoming.description);
      }

      const basePoster = norm(base.posterUrl);
      const incomingPoster = norm(incoming.posterUrl);
      const basePosterMissing = isBlockedPosterUrl(basePoster);
      const incomingPosterMissing = isBlockedPosterUrl(incomingPoster);
      merged.posterUrl = (basePosterMissing && !incomingPosterMissing) ? incoming.posterUrl : (base.posterUrl || incoming.posterUrl);
      merged.rating = base.rating || incoming.rating;
      merged.cast = pickCast(base.cast, incoming.cast);
      merged.tmdbId = merged.tmdbId ?? incoming.tmdbId;
      merged.tmdbMediaType = merged.tmdbMediaType ?? incoming.tmdbMediaType;
      return merged;
  };

  // Merge Priority: Plugins > TMDB > Bangumi > AI (but fill gaps from lower-priority sources)
  const allItems = [...pluginItems, ...tmdbItems, ...bangumiItems, ...aiItems];
  const uniqueItems = new Map<string, MediaItem>();

  for (const item of allItems) {
      const normTitle = item.title.trim().toLowerCase();
      let key = normTitle;
      if (item.releaseDate && item.releaseDate.length >= 4) {
          key = `${normTitle}|${item.releaseDate.substring(0, 4)}`;
      }

      const prev = uniqueItems.get(key);
      if (!prev) uniqueItems.set(key, item);
      else uniqueItems.set(key, mergeMediaItems(prev, item));
  }

  let filtered = Array.from(uniqueItems.values()).filter(r => {
      const allowedTypes = new Set<string>(Object.values(MediaType).filter((t) => t !== MediaType.OTHER));
      return allowedTypes.has(r.type);
  });

  // Relevance gate & ranking: when at least one result is title-relevant to the
  // query, drop the zero-relevance noise and put the best matches first. For
  // queries that match no title at all (director/genre searches) keep everything.
  const bestScore = filtered.reduce((m, it) => Math.max(m, relevanceScore(it.title)), 0);
  if (bestScore > 0) {
      filtered = filtered.filter(it => relevanceScore(it.title) > 0);
  }
  filtered = filtered
      .map((it, i) => ({ it, i, score: relevanceScore(it.title) }))
      .sort((a, b) => (b.score - a.score) || (a.i - b.i))
      .map(x => x.it);

  const enrichWithTMDB = async (items: MediaItem[]): Promise<MediaItem[]> => {
      const enrichT0 = performance.now();
      let detailCalls = 0;
      const wantsFullDate = (t: MediaType) => t === MediaType.MOVIE || t === MediaType.TV_SERIES || t === MediaType.SHORT_DRAMA;
      const needsEnrich = (it: MediaItem) => {
          if (!(it.type === MediaType.MOVIE || it.type === MediaType.TV_SERIES)) return false;
          if (!it.tmdbId || !(it.tmdbMediaType === 'movie' || it.tmdbMediaType === 'tv')) return false;
          const dateNeeded = wantsFullDate(it.type) && !isFullDate(it.releaseDate);
          const directorNeeded = isUnknownText(it.directorOrAuthor);
          const descNeeded = isUnknownText(it.description) || norm(it.description).length < 60;
          const castNeeded = !it.cast || it.cast.length === 0;
          return dateNeeded || directorNeeded || descNeeded || castNeeded;
      };
      const toPatch = items.filter(needsEnrich).slice(0, 10);
      if (toPatch.length === 0) return items;

      const byId = new Map(items.map(i => [i.id, i]));
      const queue = [...toPatch];

      const applyTMDBDetails = async (it: MediaItem) => {
          const tmdbId = it.tmdbId;
          const tmdbMediaType: 'movie' | 'tv' = it.tmdbMediaType as any;
          if (!tmdbId) return;

          detailCalls += 1;
          let details = await getTMDBDetails(tmdbId, tmdbMediaType, 'zh-CN');
          if (details && isUnknownText(details.overview)) {
              const en = await getTMDBDetails(tmdbId, tmdbMediaType, 'en-US');
              if (en && !isUnknownText(en.overview)) details = { ...details, overview: en.overview };
          }
          if (!details) return;

          const next: Partial<MediaItem> = { tmdbId, tmdbMediaType };

          const rel = norm(details.release_date || details.first_air_date);
          if (rel && (isUnknownText(it.releaseDate) || (wantsFullDate(it.type) && !isFullDate(it.releaseDate)) || dateScore(rel) > dateScore(it.releaseDate))) {
              next.releaseDate = rel;
          }

          if (isUnknownText(it.directorOrAuthor)) {
              if (tmdbMediaType === 'movie') {
                  const crew = Array.isArray(details.credits?.crew) ? details.credits.crew : [];
                  const directors = crew.filter((c: any) => c && c.job === 'Director' && c.name).map((c: any) => String(c.name));
                  if (directors.length > 0) next.directorOrAuthor = directors.slice(0, 2).join(' / ');
              } else {
                  const createdBy = Array.isArray(details.created_by) ? details.created_by : [];
                  const creators = createdBy.filter((c: any) => c && c.name).map((c: any) => String(c.name));
                  if (creators.length > 0) next.directorOrAuthor = creators.slice(0, 2).join(' / ');
              }
          }

          const overview = norm(details.overview);
          if (overview && (isUnknownText(it.description) || norm(it.description).length < 60)) {
              next.description = overview;
          }

          if (!it.cast || it.cast.length === 0) {
              const cast = Array.isArray(details.credits?.cast) ? details.credits.cast : [];
              const names = cast.filter((c: any) => c && c.name).map((c: any) => String(c.name)).slice(0, 5);
              if (names.length > 0) next.cast = names;
          }

          const poster = getTMDBPosterUrl(details.poster_path) || undefined;
          if (poster && isPlaceholderPosterUrl(it.posterUrl)) {
              next.posterUrl = poster;
          }

          if (Object.keys(next).length <= 2) return;
          byId.set(it.id, { ...it, ...next });
      };

      const worker = async () => {
          while (queue.length > 0) {
              const it = queue.shift();
              if (!it) return;
              try { await applyTMDBDetails(it); } catch {}
          }
      };

      // Increased concurrency from 3 to 6 to speed up enrichment
      await Promise.all(Array(6).fill(null).map(() => worker()));
      if (diagEnabled) addStep('TMDB 详情补全', enrichT0, 'tmdb', { calls: detailCalls, items: toPatch.length });
      return items.map(i => byId.get(i.id) || i);
  };

  filtered = await enrichWithTMDB(filtered);
  if (diagEnabled) finalizeDiagnostics();

  if (type && type !== 'All') {
      filtered = filtered.filter(it => it.type === type);
  }

  const limited = filtered.slice(0, 12);

  try {
    localStorage.setItem(cacheKey, JSON.stringify(limited));
    localStorage.setItem(cacheTsKey, Date.now().toString());
  } catch {}
  return limited;
};

export const getSearchSnippets = async (query: string): Promise<string> => {
    const { 
        enableSearch,
        searchProvider,
        getDecryptedGoogleKey,
        googleSearchCx,
        getDecryptedSerperKey,
        getDecryptedYandexKey,
        yandexSearchLogin,
        useSystemProxy,
        getProxyUrl
    } = useAIStore.getState();

    if (!enableSearch) return "";

    // Web mode: the user's selected engine first, then Google, then Serper,
    // with the keyless DuckDuckGo block as the last resort.
    const googleReady = !!(getDecryptedGoogleKey() || '').trim() && !!(googleSearchCx || '').trim();
    const serperReady = !!(getDecryptedSerperKey() || '').trim();
    const serperFirst = searchProvider === 'serper' && serperReady;
    let triedGoogle = false;
    let triedSerper = false;

    try {
        if (isTauriEnv) {
            // Tauri Mode
             const providerList = resolveTauriSearchProviderList({
                provider: searchProvider,
                googleKey: getDecryptedGoogleKey(),
                googleCx: googleSearchCx,
                serperKey: getDecryptedSerperKey(),
                yandexKey: getDecryptedYandexKey(),
                yandexUser: yandexSearchLogin
            });

            for (const eff of providerList) {
                try {
                    const rustConfig = {
                        provider: eff.provider,
                        api_key: eff.apiKey,
                        cx: eff.cx,
                        user: eff.user,
                        search_type: 'text',
                        proxy_url: getProxyUrl(),
                        use_system_proxy: useSystemProxy
                    };
                    
                    const resultStr = await invoke<string>('web_search', { query, config: rustConfig });
                    const arr = JSON.parse(resultStr);
                    if (Array.isArray(arr) && arr.length > 0) {
                        return arr.slice(0, 3).map((i: any) => i.snippet || i.title).join('\n');
                    }
                } catch (e) { console.warn("Search snippet fetch failed", e); }
            }
        } else {
            // Web Mode
            if (googleReady && (!serperFirst || triedSerper)) {
                const apiKeyStr = getDecryptedGoogleKey();
                if (apiKeyStr && googleSearchCx) {
                    const apiKeys = apiKeyStr.split(/[;；]/).map(k => k.trim()).filter(k => k);
                    for (const apiKey of apiKeys) {
                        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${googleSearchCx}&q=${encodeURIComponent(query)}&num=3`;
                        try {
                            await apiLimiter.acquire();
                            try {
                                const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
                                if (res.ok) {
                                    const data = await res.json();
                                    if (data.items) {
                                        return data.items.map((i: any) => i.snippet || i.title).join('\n');
                                    }
                                }
                            } finally {
                                // Release exactly once: the old code released here *and*
                                // in the catch, leaking permits and quietly raising the
                                // concurrency limit on every failure.
                                apiLimiter.release();
                            }
                        } catch (e) {
                            console.warn('Search snippet lookup failed', e);
                        }
                    }
                }
                triedGoogle = true;
            }
            if (serperReady && (serperFirst || triedGoogle || !googleReady)) {
                 const apiKeyStr = getDecryptedSerperKey();
                 if (apiKeyStr) {
                    const apiKeys = apiKeyStr.split(/[;；]/).map(k => k.trim()).filter(k => k);
                    for (const apiKey of apiKeys) {
                        try {
                            const res = await fetchWithTimeout('https://google.serper.dev/search', {
                                method: 'POST',
                                headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ q: query, num: 3 }),
                                timeoutMs: 8000
                            });
                            if (res.ok) {
                                const data = await res.json();
                                if (data.organic) {
                                    return data.organic.map((i: any) => i.snippet || i.title).join('\n');
                                }
                            }
                        } catch {}
                    }
                 }
                triedSerper = true;
            }
            // DuckDuckGo: keyless, so it always runs as the final fallback.
            try {
                 const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
                 const res = await fetchWithTimeout(url, { timeoutMs: 5000 });
                 if (res.ok) {
                     const data = await res.json();
                     const items = [...(data.Results || []), ...(data.RelatedTopics || [])];
                     return items.slice(0, 3).map((i: any) => i.Text || i.FirstURL).join('\n');
                 }
            } catch {}
        }
    } catch (e) {
        console.warn("getSearchSnippets failed", e);
    }
    return "";
};

let updatesCheckInFlight = false;

export const checkUpdates = async (items: MediaItem[]): Promise<{ id: string; latestUpdateInfo: string; isOngoing: boolean }[]> => {
  // Singleton guard: update checks are triggered from several surfaces
  // (app mount, collection page, dashboard, media card). Never run them
  // concurrently to avoid duplicate AI calls and conflicting writes.
  if (updatesCheckInFlight) {
    console.warn("checkUpdates skipped: another update check is already running");
    return [];
  }
  updatesCheckInFlight = true;
  try {
  if (items.length === 0) return [];

  const { enableSearch } = useAIStore.getState();
  const isChinese = i18n.language.startsWith('zh');
  const formatEp = (s: number, e: number) => isChinese ? `第${s}季 第${e}集` : `Season ${s} Episode ${e}`;
  
  // Batch processing
  const BATCH_SIZE = 5;
  const allUpdates: { id: string; latestUpdateInfo: string; isOngoing: boolean }[] = [];
  
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const titleToId = new Map(batch.map(item => [item.title.toLowerCase(), item.id]));
      const norm = (v?: string) => (v || '').trim().toLowerCase();
      const normalize = (s: string) => norm(s).replace(/[^\p{L}\p{N}]+/gu, '');
      const titleNormMap = new Map(batch.map(item => [normalize(item.title), item.id]));
      const editDistance = (a: string, b: string) => {
          const m = a.length, n = b.length;
          if (m === 0) return n;
          if (n === 0) return m;
          const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
          for (let i2 = 0; i2 <= m; i2++) dp[i2][0] = i2;
          for (let j2 = 0; j2 <= n; j2++) dp[0][j2] = j2;
          for (let i2 = 1; i2 <= m; i2++) {
              for (let j2 = 1; j2 <= n; j2++) {
                  const cost = a[i2 - 1] === b[j2 - 1] ? 0 : 1;
                  dp[i2][j2] = Math.min(
                      dp[i2 - 1][j2] + 1,
                      dp[i2][j2 - 1] + 1,
                      dp[i2 - 1][j2 - 1] + cost
                  );
              }
          }
          return dp[m][n];
      };
      const similarity = (a: string, b: string) => {
          const maxLen = Math.max(a.length, b.length);
          if (maxLen === 0) return 1;
          return 1 - editDistance(a, b) / maxLen;
      };

      const authoritativeUpdates: { id: string; latestUpdateInfo: string; isOngoing: boolean }[] = [];
      const pendingForAI: MediaItem[] = [];
      for (const it of batch) {
          if (it.type === MediaType.TV_SERIES && it.tmdbId && it.tmdbMediaType === 'tv') {
              try {
                  const details = await getTMDBDetails(it.tmdbId, 'tv', isChinese ? 'zh-CN' : 'en-US');
                  if (details) {
                      const status = String(details.status || '').toLowerCase();
                      const last = details.last_episode_to_air;
                      const next = details.next_episode_to_air;
                      if (last && typeof last.season_number === 'number' && typeof last.episode_number === 'number') {
                          const info = formatEp(last.season_number, last.episode_number);
                          const ongoing = status !== 'ended' && status !== 'canceled' && !!next;
                          authoritativeUpdates.push({ id: it.id, latestUpdateInfo: info, isOngoing: ongoing });
                          continue;
                      }
                      if (Array.isArray(details.seasons)) {
                          const seasons = details.seasons.filter((s: any) => typeof s.season_number === 'number' && typeof s.episode_count === 'number');
                          if (seasons.length > 0) {
                              const maxSeason = seasons.reduce((a: any, b: any) => (a.season_number > b.season_number ? a : b));
                              const info = formatEp(maxSeason.season_number, maxSeason.episode_count);
                              const ongoing = status !== 'ended' && status !== 'canceled';
                              authoritativeUpdates.push({ id: it.id, latestUpdateInfo: info, isOngoing: ongoing });
                              continue;
                          }
                      }
                  }
              } catch {}
          }
          pendingForAI.push(it);
      }
      if (authoritativeUpdates.length > 0) {
          authoritativeUpdates.forEach(u => allUpdates.push(u));
      }
      if (pendingForAI.length === 0) {
          continue;
      }
      
      let context = "";
      let queryList = "";

      // Native-search models fetch their own fresh results; only fall back to
      // engine-API snippets when the model cannot search on its own.
      const useEngineContext = enableSearch && !canUseNativeSearch();

      if (useEngineContext) {
          // Parallel search for the batch
          const searchPromises = pendingForAI.map(async (item) => {
              const typeTerm = isChinese ? 
                  (item.type === MediaType.COMIC ? '漫画 最新话' : item.type === MediaType.BOOK ? '小说 最新章节' : '最新集 更新') : 
                  (item.type === MediaType.COMIC ? 'latest chapter' : 'latest episode');
              const q = `"${item.title}" ${typeTerm}`;
              const snippets = await getSearchSnippets(q);
              return { title: item.title, snippets };
          });
          
          const results = await Promise.all(searchPromises);
          context = results.map(r => `Work: ${r.title}\nSearch Results:\n${r.snippets || "No results"}\n---`).join('\n');
          queryList = pendingForAI.map(item => {
              const y = (item.releaseDate || '').slice(0, 4);
              const hasY = !!y && /^\d{4}$/.test(y);
              return hasY ? `"${item.title}" (${y})` : `"${item.title}"`;
          }).join(', ');
      } else {
          queryList = pendingForAI.map(item => {
              const y = (item.releaseDate || '').slice(0, 4);
              const hasY = !!y && /^\d{4}$/.test(y);
              const typeStr = `(${item.type})`;
              return hasY ? `"${item.title}" (${y}) ${typeStr}` : `"${item.title}" ${typeStr}`;
          }).join(', ');
      }

      let userPrompt = "";
      const today = new Date().toISOString().split('T')[0];
      if (isChinese) {
          userPrompt = `今天是 ${today}。请以此日期为基准检查作品的最新更新状态: ${queryList}。

          ${useEngineContext ? `参考搜索结果:\n${context}\n` : ''}
          
          请提供截至今天的最新一集/一章信息。
          返回一个包含以下对象的JSON数组:
          - title: 字符串 (完全匹配)
          - latestUpdateInfo: 字符串 (例如 "第4季 第8集" 或 "第1052章")
          - isOngoing: 布尔值 (如果仍在更新则为 true, 完结为 false)
          
          [注意] 
          1. 如果有搜索结果，请优先依据搜索结果判断。
          2. 如果搜索结果显示已完结，isOngoing 应为 false。
          3. 如果没有搜索结果，请利用你的内部知识库。
          4. 保持 JSON 格式合法。
          5. 宁可保守，不要编造：无法确认的集数/章节请返回你确信的最近一条信息，不要臆造比已知更新的进度。
          `;
      } else {
          userPrompt = `Today is ${today}. Check the latest status as of this date for: ${queryList}.

          ${useEngineContext ? `Reference Search Results:\n${context}\n` : ''}
          
          Provide the absolute latest episode/chapter as of today.
          Return a JSON array with objects containing:
          - title: string (exact match)
          - latestUpdateInfo: string (e.g. "Season 4 Episode 8" or "Chapter 1052")
          - isOngoing: boolean (true if still updating, false if ended)
          
          [Note]
          1. Prioritize the provided search results.
          2. If results indicate ended, set isOngoing to false.
          3. If no search results, use internal knowledge.
          4. Return strict JSON.
          5. Be conservative: when you cannot verify the latest number, return the most recent entry you are confident about — never fabricate a newer episode/chapter than you know of.
          `;
      }

      const messages = [
        { role: "system", content: isChinese ? "你是一个媒体更新追踪助手。仅返回原始JSON数组。不要使用Markdown。" : "You are a media update tracker. Return ONLY raw JSON array. No markdown." },
        { role: "user", content: userPrompt }
      ];

      try {
          const text = await callAI(messages, 0.1);
          if (text) {
              let jsonStr = "";
              const jsonArrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
              if (jsonArrayMatch) {
                  jsonStr = jsonArrayMatch[0];
              } else {
                  jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
              }
              
              if (jsonStr.startsWith('[') || jsonStr.startsWith('{')) {
                  let parsed: any[] = [];
                  try {
                      const raw = JSON.parse(jsonStr);
                      parsed = Array.isArray(raw) ? raw : [raw];
                  } catch (parseErr) {
                      // Try to salvage a truncated array up to the last '}'
                      const lastBracket = jsonStr.lastIndexOf('}');
                      if (lastBracket > 0) {
                          try {
                              const recovered = JSON.parse(jsonStr.substring(0, lastBracket + 1) + ']');
                              if (Array.isArray(recovered)) parsed = recovered;
                          } catch {}
                      }
                      if (parsed.length === 0) {
                          console.warn("Failed to parse AI update-check JSON", parseErr);
                      }
                  }
                  // Schema guard: only accept entries that resolve to a batch item
                  // and carry a usable update string.
                  for (const u of parsed) {
                      if (!u || typeof u !== 'object') continue;
                      const updateText = typeof u.latestUpdateInfo === 'string' ? u.latestUpdateInfo.trim() : '';
                      if (!updateText) continue;
                      let id = titleToId.get(String(u.title || '').toLowerCase());
                      if (!id) {
                          const n = normalize(String(u.title || ''));
                          id = titleNormMap.get(n);
                          if (!id) {
                              const candidates = pendingForAI.map(it => ({ id: it.id, score: similarity(n, normalize(it.title)) }));
                              candidates.sort((a, b) => b.score - a.score);
                              const best = candidates[0];
                              if (best && best.score >= 0.8) id = best.id;
                          }
                      }
                      if (id) {
                          allUpdates.push({
                              id,
                              latestUpdateInfo: updateText,
                              isOngoing: u.isOngoing === true
                          });
                      }
                  }
              }
          }
      } catch (e) {
          console.error("Batch update check failed", e);
      }
      
      // Small delay between batches to be nice to APIs
      if (enableSearch && i + BATCH_SIZE < items.length) {
          await new Promise(r => setTimeout(r, 1000));
      }
  }

  return allUpdates;
  } finally {
    updatesCheckInFlight = false;
  }
};

export const repairMediaItem = async (item: MediaItem): Promise<Partial<MediaItem> | null> => {
    const norm = (v?: string) => (v || '').trim();
    const isUnknownText = (v?: string) => {
        const s = norm(v);
        if (!s) return true;
        const low = s.toLowerCase();
        return low === 'unknown' || s === '未知' || low === 'n/a' || low === 'na' || s === '-';
    };
    const isFullDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(norm(v));
    const wantsFullDate = item.type === MediaType.MOVIE || item.type === MediaType.TV_SERIES;

    const isPosterMissing = isBlockedPosterUrl(item.posterUrl);
    const isDateMissing = wantsFullDate ? !isFullDate(item.releaseDate) : isUnknownText(item.releaseDate);
    const isDirectorMissing = isUnknownText(item.directorOrAuthor);
    const currentDesc = norm(item.description);
    const isDescShort = !isUnknownText(currentDesc) && currentDesc.length < 50;
    const isDescMissing = isUnknownText(currentDesc) || isDescShort;
    const isCastMissing = !item.cast || item.cast.length === 0;

    if (!isPosterMissing && !isDateMissing && !isDirectorMissing && !isDescMissing && !isCastMissing) return null;

    let updates: Partial<MediaItem> = {};

    if (isPosterMissing) {
        const year = !isUnknownText(item.releaseDate) ? item.releaseDate.split('-')[0] : '';
        const { picked } = await fetchPosterFromSearch(item.title, year, item.type);
        if (picked && !isPlaceholderPosterUrl(picked)) {
            updates.posterUrl = picked;
        }
    }

    if (item.type === MediaType.MOVIE || item.type === MediaType.TV_SERIES) {
        try {
            const mapType: 'movie' | 'tv' =
                (item.tmdbMediaType === 'movie' || item.tmdbMediaType === 'tv')
                    ? item.tmdbMediaType
                    : (item.type === MediaType.TV_SERIES ? 'tv' : 'movie');

            let tmdbId = item.tmdbId;
            let tmdbMediaType: 'movie' | 'tv' = mapType;

            if (!tmdbId) {
                const candidates = await searchTMDB(item.title, mapType);
                const year = norm(item.releaseDate).slice(0, 4);
                const best = (year && /^\d{4}$/.test(year))
                    ? candidates.find(c => (c.release_date || c.first_air_date || '').startsWith(year))
                    : candidates[0];
                if (best && typeof best.id === 'number') {
                    tmdbId = best.id;
                    tmdbMediaType = best.media_type === 'tv' ? 'tv' : 'movie';
                }
            }

            if (tmdbId) {
                let details = await getTMDBDetails(tmdbId, tmdbMediaType, 'zh-CN');
                if (details && isUnknownText(details.overview)) {
                    const en = await getTMDBDetails(tmdbId, tmdbMediaType, 'en-US');
                    if (en && !isUnknownText(en.overview)) details = { ...details, overview: en.overview };
                }
                if (details) {
                    updates.tmdbId = tmdbId;
                    updates.tmdbMediaType = tmdbMediaType;

                    const rel = norm(details.release_date || details.first_air_date);
                    if (rel && (!isFullDate(item.releaseDate) || isUnknownText(item.releaseDate))) {
                        updates.releaseDate = rel;
                    }

                    if (isUnknownText(item.directorOrAuthor)) {
                        if (tmdbMediaType === 'movie') {
                            const crew = Array.isArray(details.credits?.crew) ? details.credits.crew : [];
                            const directors = crew
                                .filter((c: any) => c && c.name && (c.job === 'Director' || String(c.job || '').toLowerCase().includes('director')))
                                .map((c: any) => String(c.name));
                            if (directors.length > 0) updates.directorOrAuthor = directors.slice(0, 2).join(' / ');
                        } else {
                            const createdBy = Array.isArray(details.created_by) ? details.created_by : [];
                            const creators = createdBy.filter((c: any) => c && c.name).map((c: any) => String(c.name));
                            if (creators.length > 0) updates.directorOrAuthor = creators.slice(0, 2).join(' / ');
                            else {
                                const crew = Array.isArray(details.credits?.crew) ? details.credits.crew : [];
                                const directors = crew
                                    .filter((c: any) => c && c.name && String(c.job || '').toLowerCase().includes('director'))
                                    .map((c: any) => String(c.name));
                                if (directors.length > 0) updates.directorOrAuthor = directors.slice(0, 2).join(' / ');
                            }
                        }
                    }

                    const overview = norm(details.overview);
                    if (overview && (isUnknownText(item.description) || currentDesc.length < 60)) {
                        updates.description = overview;
                    }

                    if (!item.cast || item.cast.length === 0) {
                        const cast = Array.isArray(details.credits?.cast) ? details.credits.cast : [];
                        const names = cast.filter((c: any) => c && c.name).map((c: any) => String(c.name)).slice(0, 5);
                        if (names.length > 0) updates.cast = names;
                    }

                    const poster = getTMDBPosterUrl(details.poster_path) || undefined;
                    if (poster && isPosterMissing && !updates.posterUrl) updates.posterUrl = poster;
                }
            }
        } catch {}
    }

    const effective = { ...item, ...updates } as MediaItem;

    const shouldSearch =
        (wantsFullDate ? !isFullDate(effective.releaseDate) : isUnknownText(effective.releaseDate)) ||
        isUnknownText(effective.directorOrAuthor) ||
        isUnknownText(effective.description) ||
        (norm(effective.description).length > 0 && norm(effective.description).length < 50) ||
        (!effective.cast || effective.cast.length === 0) ||
        (isPosterMissing && !updates.posterUrl);

    if (shouldSearch) {
        try {
            const results = await searchMedia(item.title, item.type);
            const exact = results.find(r => r.title.toLowerCase() === item.title.toLowerCase());
            const match = exact || results[0];
            if (match) {
                if ((wantsFullDate ? !isFullDate(effective.releaseDate) : isUnknownText(effective.releaseDate)) && !isUnknownText(match.releaseDate)) {
                    updates.releaseDate = match.releaseDate;
                }
                if ((isPosterMissing && !updates.posterUrl) && match.posterUrl && !isPlaceholderPosterUrl(match.posterUrl)) {
                    updates.posterUrl = match.posterUrl;
                }
                if (isUnknownText(effective.directorOrAuthor) && !isUnknownText(match.directorOrAuthor)) {
                    updates.directorOrAuthor = match.directorOrAuthor;
                }
                if ((isUnknownText(effective.description) || norm(effective.description).length < 60) && !isUnknownText(match.description)) {
                    updates.description = match.description;
                }
                if ((!effective.cast || effective.cast.length === 0) && match.cast && match.cast.length > 0) {
                    updates.cast = match.cast;
                }
            }
        } catch {}
    }

    return Object.keys(updates).length > 0 ? updates : null;
};



// New Helper: Fetch Poster from Search
export const fetchPosterFromSearch = async (title: string, year: string, type: string = 'movie'): Promise<PosterSearchResult> => {
    const { 
        enableSearch, 
        searchProvider, 
        getDecryptedGoogleKey, 
        googleSearchCx, 
        getDecryptedSerperKey,
        getDecryptedYandexKey,
        yandexSearchLogin
    } = useAIStore.getState();
    const normalizeProvider = (sp: any): string => {
        const v = String(sp || '').toLowerCase();
        return (v === 'google' || v === 'serper' || v === 'yandex') ? v : 'duckduckgo';
    };
    const yearToken = (() => {
        const y = String(year || '').trim().slice(0, 4);
        return /^\d{4}$/.test(y) ? y : '';
    })();
    const cacheKey = makePosterCacheKey(title, yearToken, type);
    const cachedPreferred = getPreferredPoster(cacheKey);
    const cachedCandidates = getPosterCandidates(cacheKey);
    if (cachedPreferred && await checkImage(cachedPreferred)) return { picked: cachedPreferred, candidates: cachedCandidates.length > 0 ? cachedCandidates : [cachedPreferred] };
    if (cachedCandidates.length > 0) {
        for (const url of cachedCandidates) {
            if (url && await checkImage(url)) { setPreferredPoster(cacheKey, url); return { picked: url, candidates: cachedCandidates }; }
        }
    }

    if (!enableSearch) {
        const omdb = await fetchPosterFromOMDB(title, year);
        if (omdb) {
            setPreferredPoster(cacheKey, omdb);
            updatePosterCandidates(cacheKey, [omdb], omdb);
            return { picked: omdb, candidates: [omdb] };
        }
        return { candidates: cachedCandidates };
    }

    if (searchProvider === 'yandex') {
        try {
            const first = await fetchPosterFromOMDB(title, year);
            if (first) return { picked: first, candidates: [first] };
            const langZh = i18n.language.startsWith('zh');
            if (isTauriEnv) {
                const jsonStr = await invoke<string>('wiki_pageimages', { title, lang_zh: langZh });
                const data = JSON.parse(jsonStr);
                if (data?.query?.pages) {
                    const pages = Object.values(data.query.pages);
                    if (pages.length > 0) {
                        const p: any = pages[0];
                        const img = p?.thumbnail?.source || p?.original?.source;
                        if (typeof img === 'string' && img.length > 0) return { picked: img, candidates: [img] };
                    }
                }
            } else {
                const api = langZh ? 'https://zh.wikipedia.org/w/api.php' : 'https://en.wikipedia.org/w/api.php';
                const res = await fetchWithTimeout(`${api}?action=query&prop=pageimages&piprop=thumbnail|original&pithumbsize=1024&format=json&origin=*&titles=${encodeURIComponent(title)}`, { timeoutMs: 8000 });
                if (res.ok) {
                    const data = await res.json();
                    if (data?.query?.pages) {
                        const pages = Object.values(data.query.pages);
                        if (pages.length > 0) {
                            const p: any = pages[0];
                            const img = p?.thumbnail?.source || p?.original?.source;
                            if (typeof img === 'string' && img.length > 0) return { picked: img, candidates: [img] };
                        }
                    }
                }
            }
        } catch {}
        const omdb = await fetchPosterFromOMDB(title, year);
        if (omdb) return { picked: omdb, candidates: [omdb] };
        return { candidates: [] };
    }

    // Construct a more specific query
    const isChinese = i18n.language.startsWith('zh');
    let query = "";
    
    if (isChinese) {
        // Localized query for better results with Chinese titles
        // Simplified queries to reduce latency and noise
        let typeTerm = "海报 竖版";
        switch(type.toLowerCase()) {
            case 'movie': case '电影': typeTerm = "电影海报 竖版"; break;
            case 'tv series': case '电视剧': typeTerm = "电视剧海报 竖版"; break;
            case 'book': case '书籍': typeTerm = "书封面"; break;
            case 'comic': case '漫画': typeTerm = "漫画封面"; break;
            case 'music': case '音乐': typeTerm = "专辑封面"; break;
            case 'short drama': case '短剧': typeTerm = "短剧海报 竖版"; break;
        }
        query = `${title} ${yearToken ? `${yearToken} ` : ''}${typeTerm}`; 
    } else {
        query = `"${title}" ${yearToken ? `${yearToken} ` : ''}${type} poster`;
    }
    
    // ...

    try {
        const posterDomains = (() => {
            const s = useAIStore.getState();
            const arr = (s as any)?.authoritativeDomains?.poster;
            if (Array.isArray(arr) && arr.length > 0) return arr;
            return ['moviepostersgallery.com', 'impawards.com', 'goldposter.com'];
        })();
        const queryVariants = [query, ...posterDomains.map(d => `${query} site:${d}`)];

        const normalizeHost = (u: string): string => {
            try {
                return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
            } catch {
                const s = String(u || '').toLowerCase();
                const m = s.match(/^https?:\/\/([^\/?#]+)/);
                if (m && m[1]) return m[1].replace(/^www\./, '');
                return s.replace(/^www\./, '').split('/')[0];
            }
        };
        const isImageUrl = (u: string) => {
            const normalized = normalizeImageUrl(u);
            if (!normalized) return false;
            return /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(normalized);
        };
        const isPosterDetailLink = (u: string): boolean => {
            const host = normalizeHost(u);
            if (!host) return false;
            const lower = u.toLowerCase();
            if (lower.includes('douban.com/subject/')) return true;
            return posterDomains.some(d => {
                const dom = String(d || '').toLowerCase().replace(/^www\./, '').split('/')[0];
                return host === dom || host.endsWith(`.${dom}`) || u.toLowerCase().includes(dom);
            });
        };

        const hasBannedImageKeyword = (value: string) => {
            const s = String(value || '').toLowerCase();
            return /(^|[\/_\-])(social|logo|site|default)([\/_\-]|$)/.test(s);
        };
        const pickFromResults = async (arr: any[]): Promise<{ picked?: string; candidates: string[] }> => {
            if (!Array.isArray(arr) || arr.length === 0) return { candidates: [] };
            const norm = (v: any) => String(v ?? '').toLowerCase().trim();
            const normalizeMatch = (v: any) => norm(v).replace(/[^\p{L}\p{N}]+/gu, '');
            const hasChinese = (v: any) => /[\u4e00-\u9fff]/.test(String(v || ''));
            const tokenizeLatin = (v: any) => {
                const stop = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'movie', 'film', 'tv', 'series', 'poster', 'cover']);
                return norm(v)
                    .split(/[^a-z0-9]+/g)
                    .filter(x => x.length > 1 && !stop.has(x));
            };
            const qTitle = String(title || '');
            const qNorm = normalizeMatch(qTitle);
            const qTokens = tokenizeLatin(qTitle);
            const qHasChinese = hasChinese(qTitle);
            const scoreDomain = (u: string) => {
                const url = u.toLowerCase();
                if (url.includes('image.tmdb.org') || url.includes('themoviedb.org')) return 100;
                if (url.includes('doubanio.com') || url.includes('douban.com')) return 90;
                if (url.includes('wikimedia.org') || url.includes('wikipedia.org')) return 85;
                if (url.includes('goldposter.com')) return 82;
                if (url.includes('impawards.com')) return 80;
                if (url.includes('moviepostersgallery.com')) return 55;
                if (url.includes('imdb.com')) return 78;
                if (url.includes('pinterest.com')) return 40;
                return 50;
            };
            const scoreSizeHint = (u: string) => {
                const url = u.toLowerCase();
                if (url.includes('image.tmdb.org/t/p/original')) return 60;
                if (url.includes('/t/p/w780')) return 40;
                if (url.includes('/t/p/w500')) return 25;
                if (url.includes('doubanio.com') && (url.includes('/l/') || url.includes('large'))) return 35;
                const wm = url.match(/\/(\d{3,5})px\-/);
                if (url.includes('wikimedia.org') && wm) {
                    const n = parseInt(wm[1], 10);
                    if (!isNaN(n) && n >= 1080) return 45;
                }
                const am = url.match(/UY(\d{3,4})/i);
                if (url.includes('m.media-amazon.com') && am) {
                    const n = parseInt(am[1], 10);
                    if (!isNaN(n) && n >= 1080) return 40;
                }
                return 0;
            };
            const scoreMatch = (r: any) => {
                let score = 0;
                const rt = String(r?.title || r?.snippet || '').trim();
                const pr = processSearchResult(rt || '', r?.snippet || '');
                const tRaw = pr?.title || rt || '';
                const tNorm = normalizeMatch(tRaw);
                if (tNorm && qNorm) {
                    if (tNorm === qNorm) score += 70;
                    else if (tNorm.startsWith(qNorm) || qNorm.startsWith(tNorm)) score += 45;
                    else if (tNorm.includes(qNorm) || qNorm.includes(tNorm)) score += 25;
                }
                if (!qHasChinese && qTokens.length > 0) {
                    const tTokens = tokenizeLatin(tRaw);
                    if (tTokens.length > 0) {
                        const inter = tTokens.filter(t => qTokens.includes(t));
                        const ratio = inter.length / Math.max(1, qTokens.length);
                        if (ratio >= 0.7) score += 25;
                        else if (ratio >= 0.45) score += 15;
                    }
                }
                if (yearToken) {
                    if (pr?.year && pr.year === yearToken) score += 15;
                    else if (pr?.year && pr.year !== yearToken) score -= 10;
                }
                const combined = `${r?.image || ''} ${r?.link || ''} ${r?.title || ''}`.toLowerCase();
                if (/soundtrack|ost|logo|icon|wallpaper|banner|background|album|cd/.test(combined)) score -= 25;
                if (hasBannedImageKeyword(combined)) score -= 40;
                if (/原声|配乐|壁纸|图标|徽标|专辑/.test(combined)) score -= 25;
                return score;
            };

            const candidates = arr
                .flatMap((r: any) => {
                    const out: Array<{ url: string; score: number }> = [];
                    if (typeof r?.image === 'string') out.push({ url: r.image, score: scoreMatch(r) });
                    const l = r?.link;
                    if (typeof l === 'string' && isImageUrl(l)) out.push({ url: l, score: scoreMatch(r) });
                    return out;
                })
                .filter((u: any) => typeof u?.url === 'string')
                .filter((u: { url: string }) => {
                    const url = u.url.toLowerCase();
                    if (url.includes('instagram.com') || url.includes('facebook.com') || url.includes('twitter.com') || url.includes('x.com')) return false;
                    if (url.includes('tiktok.com/api/img')) return false;
                    if (url.includes('m.media-amazon.com')) return false;
                    if (url.includes('i.ebayimg.com') || url.includes('ebayimg.com')) return false;
                    if (hasBannedImageKeyword(url)) return false;
                    return true;
                })
                .map((u: { url: string; score: number }) => ({
                    url: u.url,
                    score: u.score + scoreDomain(u.url) + scoreSizeHint(u.url)
                }))
                .sort((a: { url: string; score: number }, b: { url: string; score: number }) => b.score - a.score);

            if (candidates.length === 0) return { candidates: [] };

            const seen = new Set<string>();
            const ordered = candidates
                .map(c => normalizeImageUrl(c.url))
                .filter((u): u is string => !!u);
            const uniqueOrdered = ordered.filter(u => {
                if (seen.has(u)) return false;
                seen.add(u);
                return true;
            });
            for (const url of uniqueOrdered) {
                if (url && await checkImage(url)) return { picked: url, candidates: uniqueOrdered };
            }
            return { candidates: uniqueOrdered };
        };

        const tryPickOgImageFromPages = async (arr: any[]): Promise<string | undefined> => {
            if (!isTauriEnv) return undefined;
            if (!Array.isArray(arr) || arr.length === 0) return undefined;
            const pages = Array.from(new Set(
                arr
                    .map((r: any) => r?.link)
                    .filter((l: any) => typeof l === 'string')
                    .filter((l: string) => !isImageUrl(l))
                    .filter((l: string) => isPosterDetailLink(l))
            ));
            if (pages.length === 0) return undefined;

            const { useSystemProxy, getProxyUrl } = useAIStore.getState();
            for (const pageUrl of pages.slice(0, 4)) {
                try {
                    const t0 = performance.now();
                    const out = await invoke<string>('fetch_og_image', {
                        url: pageUrl,
                        config: { proxy_url: getProxyUrl(), use_system_proxy: useSystemProxy }
                    });
                    try {
                        useAIStore.getState().appendLog({
                            id: uuidv4(),
                            ts: Date.now(),
                            channel: 'search',
                            provider: 'og_image',
                            query: pageUrl,
                            request: { url: pageUrl },
                            response: out,
                            durationMs: Math.round(performance.now() - t0),
                            searchType: 'image'
                        });
                    } catch {}
                    let parsed: any = null;
                    try { parsed = JSON.parse(out); } catch {}
                    const img = parsed?.ok ? parsed?.image : undefined;
                    if (typeof img === 'string' && img.length > 0) {
                        if (hasBannedImageKeyword(img)) continue;
                        if (await checkImage(img)) return img;
                    }
                } catch {}
            }
            return undefined;
        };

        if (isTauriEnv) {
            const { useSystemProxy, getProxyUrl } = useAIStore.getState();
            const googleKey = getDecryptedGoogleKey();
            const serperKey = getDecryptedSerperKey();
            const yandexKey = getDecryptedYandexKey();
            const yandexUser = yandexSearchLogin;

            const baseConfig = {
                proxy_url: getProxyUrl(),
                use_system_proxy: useSystemProxy
            };

            const providerList = (() => {
                const out: Array<{ provider: TauriSearchProvider; api_key?: string; cx?: string; user?: string }> = [];
                if (googleKey && googleSearchCx) out.push({ provider: 'google', api_key: googleKey, cx: googleSearchCx });
                if (serperKey) out.push({ provider: 'serper', api_key: serperKey });
                if (yandexKey && yandexUser) out.push({ provider: 'yandex', api_key: yandexKey, user: yandexUser });
                out.push({ provider: 'duckduckgo' });
                return out;
            })();

            const imageProviders = providerList.filter(p => p.provider === 'google' || p.provider === 'serper');

            const runWebSearch = async (qv: string, p: { provider: TauriSearchProvider; api_key?: string; cx?: string; user?: string }, search_type: 'image' | 'text') => {
                const rustConfig = {
                    provider: p.provider,
                    api_key: p.api_key,
                    cx: p.cx,
                    user: p.user,
                    search_type,
                    ...baseConfig
                };
                const start = performance.now();
                const resultStr = await invoke<string>("web_search", { query: qv, config: rustConfig });
                try {
                    useAIStore.getState().appendLog({
                        id: uuidv4(),
                        ts: Date.now(),
                        channel: 'search',
                        provider: rustConfig.provider,
                        query: qv,
                        request: { config: { provider: rustConfig.provider, cx: rustConfig.cx, user: rustConfig.user, search_type: rustConfig.search_type } },
                        response: resultStr,
                        durationMs: Math.round(performance.now() - start),
                        searchType: search_type
                    });
                } catch {}
                let parsed: any[] = [];
                try {
                    const v = JSON.parse(resultStr);
                    if (Array.isArray(v)) parsed = v;
                } catch {}
                return parsed;
            };

            for (const qv of queryVariants) {
                for (const p of imageProviders) {
                    try {
                        const parsed = await runWebSearch(qv, p, 'image');
                        const { picked, candidates } = await pickFromResults(parsed);
                        if (candidates && candidates.length > 0) updatePosterCandidates(cacheKey, candidates, picked);
                        if (picked) { setPreferredPoster(cacheKey, picked); return { picked, candidates }; }
                        const ogPicked = await tryPickOgImageFromPages(parsed);
                        if (ogPicked) { setPreferredPoster(cacheKey, ogPicked); return { picked: ogPicked, candidates }; }
                    } catch {}
                }
            }

            const textQueryVariants = (() => {
                const base = isChinese ? `${title} 海报` : `"${title}" poster`;
                const byDomain = posterDomains.map(d => `${base} site:${String(d).trim()}`);
                const all = [...byDomain, ...queryVariants];
                return Array.from(new Set(all)).slice(0, 10);
            })();

            const textProviders = providerList;
            for (const qv of textQueryVariants) {
                for (const p of textProviders) {
                    try {
                        const parsed = await runWebSearch(qv, p, 'text');
                        const { picked, candidates } = await pickFromResults(parsed);
                        if (candidates && candidates.length > 0) updatePosterCandidates(cacheKey, candidates, picked);
                        if (picked) { setPreferredPoster(cacheKey, picked); return { picked, candidates }; }
                        const ogPicked = await tryPickOgImageFromPages(parsed);
                        if (ogPicked) { setPreferredPoster(cacheKey, ogPicked); return { picked: ogPicked, candidates }; }
                    } catch {}
                }
            }

            try {
                const kind = String(type || '').toLowerCase();
                const t0 = performance.now();
                const outD = await invoke<string>("douban_cover", { title, kind });
                try {
                    useAIStore.getState().appendLog({
                        id: uuidv4(),
                        ts: Date.now(),
                        channel: 'search',
                        provider: 'douban',
                        query: title,
                        request: { title, kind },
                        response: outD,
                        durationMs: Math.round(performance.now() - t0),
                        searchType: 'image'
                    });
                } catch {}
                try {
                    const v = JSON.parse(outD || '{}');
                    if (v && v.image) { setPreferredPoster(cacheKey, v.image); return { picked: v.image, candidates: [v.image] }; }
                } catch {}
            } catch {}
        }
        else {
            for (const qv of queryVariants) {
                let results: any[] = [];
                if (searchProvider === 'google') {
                    const apiKey = getDecryptedGoogleKey();
                    if (apiKey && googleSearchCx) {
                        const cacheKey = `google_img_${googleSearchCx}_${qv}`;
                        const cached = searchCache.get(cacheKey);
                        let data: any = null;
                        if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
                            data = cached.data;
                        } else {
                            const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${googleSearchCx}&q=${encodeURIComponent(qv)}&searchType=image&safe=active&imgType=photo&num=6`;
                            let res;
                            try {
                                await apiLimiter.acquire();
                                res = await fetchWithTimeout(url, { timeoutMs: 10000 });
                            } finally {
                                apiLimiter.release();
                            }
                            if (res.status === 429) {
                                console.warn("Google Custom Search quota exceeded (429).");
                                showQuotaError("Quota Exceeded");
                                if (cached) data = cached.data;
                            } else if (res.ok) {
                                data = await res.json();
                                searchCache.set(cacheKey, { ts: Date.now(), data });
                            }
                        }
                        if (data && data.items) {
                            results = data.items.map((item: any) => {
                                const img = item?.link || item?.image?.thumbnailLink || item?.pagemap?.cse_image?.[0]?.src;
                                return { image: img, link: item?.link, title: item?.title, snippet: item?.snippet };
                            });
                        }
                    }
                }

                if (results.length === 0 && searchProvider === 'serper') {
                    const apiKey = getDecryptedSerperKey();
                    if (apiKey) {
                        try {
                            const response = await fetchWithTimeout('https://google.serper.dev/images', {
                                method: 'POST',
                                headers: {
                                    'X-API-KEY': apiKey,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({ q: qv, num: 6 })
                            , timeoutMs: 12000 });
                            if (response.status === 403) {
                                console.error("Serper API 403 Forbidden: Invalid API Key or Quota Exceeded.");
                            } else if (response.status === 429) {
                                console.warn("Serper API 429 (Too Many Requests).");
                                showQuotaError("Quota Exceeded");
                            } else if (response.ok) {
                                const data = await response.json();
                                if (data.images) {
                                    results = data.images.map((img: any) => ({ image: img.imageUrl, link: img?.link, title: img?.title, snippet: img?.snippet }));
                                }
                            }
                        } catch (e) {
                            console.warn("Client-side Serper image search failed", e);
                        }
                    }
                }

                const { picked, candidates } = await pickFromResults(results);
                if (candidates && candidates.length > 0) updatePosterCandidates(cacheKey, candidates, picked);
                if (picked) { setPreferredPoster(cacheKey, picked); return { picked, candidates }; }
            }
        }

        try {
            const langZh = i18n.language.startsWith('zh');
            if (isTauriEnv) {
                const jsonStr = await invoke<string>('wiki_pageimages', { title, lang_zh: langZh });
                const data = JSON.parse(jsonStr);
                if (data?.query?.pages) {
                    const pages = Object.values(data.query.pages);
                    if (pages.length > 0) {
                        const p: any = pages[0];
                        const img = p?.thumbnail?.source || p?.original?.source;
                        if (typeof img === 'string' && img.length > 0) return { picked: img, candidates: [img] };
                    }
                }
            } else {
                // pageimages only surfaces freely-licensed (Commons) pictures,
                // while nearly all movie/series posters are non-free local
                // uploads — so also scan the article's file list for a
                // poster-ish file and resolve its real URL via imageinfo.
                // Chinese articles often carry no files at all; bridge through
                // Wikidata sitelinks to the English article, which almost
                // always embeds a theatrical poster.
                const wikiApiOf = (lang: 'zh' | 'en') => `https://${lang}.wikipedia.org/w/api.php`;

                const wikiPageImage = async (api: string, pageTitle: string): Promise<string | undefined> => {
                    const res = await fetchWithTimeout(`${api}?action=query&prop=pageimages&piprop=thumbnail|original&pithumbsize=1024&format=json&origin=*&titles=${encodeURIComponent(pageTitle)}`, { timeoutMs: 8000 });
                    if (!res.ok) return undefined;
                    const data = await res.json();
                    const pages = Object.values(data?.query?.pages || {});
                    const p: any = pages[0];
                    if (p && !p.missing) {
                        const img = p?.thumbnail?.source || p?.original?.source;
                        if (typeof img === 'string' && img.length > 0) return img;
                    }
                    return undefined;
                };

                // Returns { picked, canonical } — canonical is the redirected
                // article title, needed to look the item up on Wikidata.
                const wikiArticlePoster = async (api: string, pageTitle: string): Promise<{ picked?: string; canonical?: string } | undefined> => {
                    const listRes = await fetchWithTimeout(`${api}?action=query&prop=images&imlimit=80&redirects=1&format=json&origin=*&titles=${encodeURIComponent(pageTitle)}`, { timeoutMs: 8000 });
                    if (!listRes.ok) return undefined;
                    const listData = await listRes.json();
                    const pages = Object.values(listData?.query?.pages || {});
                    const canonical = (pages[0] as any)?.title || pageTitle;
                    const files: string[] = [];
                    for (const pg of pages as any[]) {
                        for (const im of (pg?.images || [])) {
                            const t = im?.title;
                            if (typeof t === 'string' && /^File:.+\.(jpe?g|png|webp)$/i.test(t)) files.push(t);
                        }
                    }
                    // Poster-like names first; drop logos, icons and other
                    // non-poster artwork that commonly lives on film articles.
                    // Word boundaries matter: bare "ost" would also kill every
                    // "pOSTer" filename.
                    const bad = /\b(logo|logos|icon|icons|flag|flags|map|maps|signature|soundtrack|ost|banner|wordmark|screenshot|diagram|chart|locator)s?\b/i;
                    const good = /poster|海报|封面|cover|teaser|promo|official still|key art/i;
                    const candidates = files.filter((f) => !bad.test(f) && good.test(f));
                    if (candidates.length > 0) {
                        const infoRes = await fetchWithTimeout(`${api}?action=query&prop=imageinfo&iiprop=url&format=json&origin=*&titles=${encodeURIComponent(candidates.slice(0, 20).join('|'))}`, { timeoutMs: 8000 });
                        if (infoRes.ok) {
                            const infoData = await infoRes.json();
                            const infoPages = Object.values(infoData?.query?.pages || {});
                            const urls: string[] = [];
                            for (const pg of infoPages as any[]) {
                                const u = pg?.imageinfo?.[0]?.url;
                                if (typeof u === 'string' && u.length > 0) urls.push(u);
                            }
                            for (const u of urls) {
                                if (await checkImage(u)) return { picked: u, canonical };
                            }
                        }
                    }
                    return { canonical };
                };

                const wikidataCrossLangTitle = async (site: 'zhwiki' | 'enwiki', pageTitle: string): Promise<string | undefined> => {
                    try {
                        const res = await fetchWithTimeout(`https://www.wikidata.org/w/api.php?action=wbgetentities&sites=${site}&titles=${encodeURIComponent(pageTitle)}&props=sitelinks&format=json&origin=*&normalize=1`, { timeoutMs: 8000 });
                        if (!res.ok) return undefined;
                        const data = await res.json();
                        const entities = data?.entities || {};
                        const other: 'enwiki' | 'zhwiki' = site === 'zhwiki' ? 'enwiki' : 'zhwiki';
                        const self: 'zhwiki' | 'enwiki' = site;
                        for (const ent of Object.values(entities) as any[]) {
                            const sl = ent?.sitelinks || {};
                            // Only trust the mapping when the item really links
                            // back to the requested page (guards name drift).
                            if (sl[self]?.title && sl[other]?.title) return sl[other].title;
                        }
                    } catch {}
                    return undefined;
                };

                const tryWiki = async (site: 'zh' | 'en', pageTitle: string): Promise<string | undefined> => {
                    const api = wikiApiOf(site);
                    const res = await wikiArticlePoster(api, pageTitle);
                    if (res?.picked) return res.picked;
                    const canonical = res?.canonical || pageTitle;
                    const viaPage = await wikiPageImage(api, canonical);
                    if (viaPage) return viaPage;
                    // Bridge to the other language via Wikidata sitelinks.
                    const crossTitle = await wikidataCrossLangTitle(site === 'zh' ? 'zhwiki' : 'enwiki', canonical);
                    if (crossTitle) {
                        const otherSite: 'zh' | 'en' = site === 'zh' ? 'en' : 'zh';
                        const crossRes = await wikiArticlePoster(wikiApiOf(otherSite), crossTitle);
                        if (crossRes?.picked) return crossRes.picked;
                        return await wikiPageImage(wikiApiOf(otherSite), crossTitle);
                    }
                    return undefined;
                };

                const primary: 'zh' | 'en' = langZh ? 'zh' : 'en';
                const secondary: 'zh' | 'en' = langZh ? 'en' : 'zh';
                try {
                    const picked = (await tryWiki(primary, title)) || (await tryWiki(secondary, title));
                    if (picked) {
                        setPreferredPoster(cacheKey, picked);
                        updatePosterCandidates(cacheKey, [picked], picked);
                        return { picked, candidates: [picked] };
                    }
                } catch {}
            }
        } catch {}

    } catch (e) {
        console.warn(`Failed to fetch poster from search for ${title}`, e);
    }

    // Final fallback: Try OMDB if available
    const omdb = await fetchPosterFromOMDB(title, year);
    if (omdb) { setPreferredPoster(cacheKey, omdb); return { picked: omdb, candidates: [omdb] }; }
    return { candidates: [] };
};

export const testSearchConnection = async (
    provider?: string,
    configOverride?: {
        googleSearchApiKey?: string;
        googleSearchCx?: string;
        serperApiKey?: string;
        yandexSearchApiKey?: string;
        yandexSearchLogin?: string;
    }
): Promise<{ ok: boolean; latency_ms?: number; provider?: string; count?: number; error?: string }> => {
    const s = useAIStore.getState();
    const effProvider = provider || s.searchProvider;
    const normalizeProvider = (sp: any): string => {
        const v = String(sp || '').toLowerCase();
        return (v === 'google' || v === 'serper' || v === 'yandex') ? v : 'duckduckgo';
    };
    const effGoogleKey = configOverride?.googleSearchApiKey || s.getDecryptedGoogleKey();
    const effGoogleCx = configOverride?.googleSearchCx || s.googleSearchCx;
    const effSerperKey = configOverride?.serperApiKey || s.getDecryptedSerperKey();
    const effYandexKey = configOverride?.yandexSearchApiKey || s.getDecryptedYandexKey();
    const effYandexLogin = configOverride?.yandexSearchLogin || s.yandexSearchLogin;
    const effUseSystemProxy = s.useSystemProxy;

    // Helper to split keys
    const splitKeys = (k?: string) => (k || '').split(/[;；]/).map(x => x.trim()).filter(x => x);

    // Check cache (only if single key or we accept cache for any key match - simplified for now)
    // Actually for test connection we might want to bypass cache to really test?
    // But existing logic uses cache. Let's keep cache logic simple: if inputs match exactly.
    const cacheKey = `test_conn:${effProvider}:${effGoogleKey || ''}:${effGoogleCx || ''}:${effSerperKey || ''}:${effYandexKey || ''}:${effYandexLogin || ''}`;
    const cached = testConnectionCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < TEST_CACHE_TTL)) {
        return cached.res;
    }

    if (isTauriEnv) {
        let apiKeys: string[] = [];
        let singleKeyProvider = false;

        switch (effProvider) {
            case 'google': 
                apiKeys = splitKeys(effGoogleKey); 
                break;
            case 'serper': 
                apiKeys = splitKeys(effSerperKey); 
                break;
            case 'yandex': 
                apiKeys = splitKeys(effYandexKey); 
                break;
            default: 
                singleKeyProvider = true;
                break;
        }

        if (singleKeyProvider) {
             const rustConfig = {
                provider: normalizeProvider(effProvider),
                api_key: undefined,
                cx: effGoogleCx,
                user: effYandexLogin,
                search_type: 'text',
                proxy_url: s.getProxyUrl(),
                use_system_proxy: effUseSystemProxy
            };
            try {
                const out = await invoke<string>('test_search_provider', { config: rustConfig });
                const res = JSON.parse(out);
                if (res.ok) testConnectionCache.set(cacheKey, { ts: Date.now(), res });
                return res;
            } catch (e: any) {
                return { ok: false, error: e?.message || String(e) };
            }
        }

        // Multi-key loop for Tauri
        let lastRes: any = { ok: false, error: 'no_keys_provided' };
        if (apiKeys.length === 0) return { ok: false, error: 'missing_api_key' };

        for (const apiKey of apiKeys) {
            const rustConfig = {
                provider: normalizeProvider(effProvider),
                api_key: apiKey,
                cx: effGoogleCx,
                user: effYandexLogin,
                search_type: 'text',
                proxy_url: s.getProxyUrl(),
                use_system_proxy: effUseSystemProxy
            };
            try {
                const out = await invoke<string>('test_search_provider', { config: rustConfig });
                const res = JSON.parse(out);
                if (res.ok) {
                    testConnectionCache.set(cacheKey, { ts: Date.now(), res });
                    return res; // Return immediately on success
                }
                lastRes = res;
                // If 429/Quota, try next. Else maybe stop? Let's try all for robustness in test.
            } catch (e: any) {
                lastRes = { ok: false, error: e?.message || String(e) };
            }
        }
        return lastRes;

    } else {
        // Web Mode
        try {
            if (effProvider === 'google') {
                if (!effGoogleKey || !effGoogleCx) return { ok: false, error: 'missing_google_config' };
                const apiKeys = splitKeys(effGoogleKey);
                let lastError = 'no_keys';
                
                for (const apiKey of apiKeys) {
                    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${effGoogleCx}&q=test&num=1`;
                    try {
                        const res = await fetchWithTimeout(url, { timeoutMs: 15000 });
                        if (res.ok) {
                            return { ok: true, provider: 'google' };
                        }
                        if (res.status === 429) {
                            lastError = 'Quota Exceeded (429)';
                            continue; // Try next key
                        }
                        lastError = `HTTP ${res.status}`;
                    } catch(e: any) {
                        lastError = e?.message || String(e);
                    }
                }
                return { ok: false, provider: 'google', error: lastError };
            }
            
            if (effProvider === 'serper') {
                if (!effSerperKey) return { ok: false, error: 'missing_serper_key' };
                const apiKeys = splitKeys(effSerperKey);
                let lastError = 'no_keys';

                for (const apiKey of apiKeys) {
                    try {
                        const res = await fetchWithTimeout('https://google.serper.dev/search', { 
                            method: 'POST', 
                            headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, 
                            body: JSON.stringify({ q: 'test' }), 
                            timeoutMs: 15000 
                        });
                        if (res.ok) return { ok: true, provider: 'serper' };
                        if (res.status === 429) {
                            lastError = 'Quota Exceeded (429)';
                            continue;
                        }
                        lastError = `HTTP ${res.status}`;
                    } catch(e: any) {
                        lastError = e?.message || String(e);
                    }
                }
                return { ok: false, provider: 'serper', error: lastError };
            }

            if (effProvider === 'yandex') {
                return { ok: false, error: 'web_preview_not_supported' };
            }
            return { ok: false, error: 'unsupported_provider' };
        } catch (e: any) {
             return { ok: false, error: e?.message || String(e) };
        }
    }
};

export const testOmdbConnection = async (apiKeyOverride?: string): Promise<{ ok: boolean; status?: number; latency_ms?: number; poster?: string; error?: string }> => {
    const s = useAIStore.getState();
    const key = apiKeyOverride || (s.getDecryptedOmdbKey && s.getDecryptedOmdbKey()) || OMDB_API_KEY;
    if (!key) return { ok: false, error: 'missing_omdb_key' };
    if (isTauriEnv) {
        try {
            const out = await invoke<string>('test_omdb', { apiKey: key });
            return JSON.parse(out);
        } catch (e: any) {
            return { ok: false, error: e?.message || String(e) };
        }
    } else {
        try {
            const start = performance.now();
            const res = await fetchWithTimeout(`https://www.omdbapi.com/?t=${encodeURIComponent('Inception')}&y=2010&apikey=${key}`, { timeoutMs: 8000 });
            const latency = Math.round(performance.now() - start);
            const ok = res.ok;
            const status = res.status;
            let poster = '';
            if (ok) {
                const v = await res.json();
                poster = v?.Poster || '';
            }
            return { ok, status, latency_ms: latency, poster };
        } catch (e: any) {
            return { ok: false, error: e?.message || String(e) };
        }
    }
};
// Helper to clean title and extract year from search result
export const processSearchResult = (title: string, snippet: string): { title: string, year: string, type: MediaType } => {
    let cleanTitle = title
        .replace(/ - .*$/, '')
        .replace(/ \| .*$/, '')
        .replace(/_.*$/, '') // Remove underscores common in file names or titles
        .replace(/\.\.\.$/, '') // Remove trailing dots
        .trim();

    // Extract year (prioritize title, then snippet)
    let year = ""; // Default to empty string to allow broader search if year not found
    const yearMatch = title.match(/\b(19\d{2}|20\d{2})\b/) || snippet.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
        year = yearMatch[1];
        // Remove year from title if present in parentheses to clean it up
        cleanTitle = cleanTitle.replace(new RegExp(`\\(${year}\\)`), '').trim();
    }

    // Infer type
    let type: MediaType = MediaType.MOVIE; // Default
    const lowerText = (title + " " + snippet).toLowerCase();
    if (lowerText.includes('season') || lowerText.includes('series') || lowerText.includes('episode') || lowerText.includes('tv show') || lowerText.includes('电视剧') || lowerText.includes('剧集')) {
        type = MediaType.TV_SERIES;
    } else if (lowerText.includes('game') || lowerText.includes('游戏')) {
        type = MediaType.OTHER; // Games might be "Other" or new type, but let's stick to existing types
    } else if (lowerText.includes('book') || lowerText.includes('novel') || lowerText.includes('书籍') || lowerText.includes('小说')) {
        type = MediaType.BOOK;
    }

    return { title: cleanTitle, year, type };
};

const createFallbackItemsFromContext = async (searchContext: string, limit: number = 10): Promise<MediaItem[]> => {
    try {
        if (!searchContext || typeof searchContext !== 'string') return [];
        const trimmed = searchContext.trim();
        if (!trimmed || !(trimmed.startsWith('[') || trimmed.startsWith('{'))) return [];
        const arr = JSON.parse(trimmed);
        if (!Array.isArray(arr) || arr.length === 0) return [];
        
        const uniqueMap = new Map();
        arr.forEach((item: any) => {
            const { title, year } = processSearchResult(item.title || '', item.snippet || '');
            const key = `${title}|${year}`;
            if (!uniqueMap.has(key)) {
                uniqueMap.set(key, item);
            }
        });
        
        const pick = Array.from(uniqueMap.values()).slice(0, limit);
        
        return pick.map((r: any) => {
            const { title, year, type } = processSearchResult(r.title || '', r.snippet || '');
            const id = uuidv4();
            return {
                id,
                title,
                directorOrAuthor: '',
                cast: [],
                description: r.snippet || '',
                releaseDate: year,
                type,
                isOngoing: type === MediaType.TV_SERIES,
                latestUpdateInfo: '',
                rating: '',
                posterUrl: getPlaceholder(type),
                userRating: 0,
                status: 'To Watch',
                addedAt: new Date().toISOString()
            } as MediaItem;
        });
    } catch (e) {
        console.debug("Fallback creation failed", e);
        return [];
    }
};

// ---- Trending recommendation helpers -------------------------------------
// Every recommendation round must surface different works: previously
// recommended titles are remembered here and injected into the prompt's
// exclude list on the next round.
const TRENDING_HISTORY_KEY = 'media_tracker_trending_history';
const TRENDING_HISTORY_CAP = 60;

const normalizeTitleKey = (t: string) => String(t || '').trim().toLowerCase();

export const getTrendingHistory = (): string[] => {
    try {
        const raw = localStorage.getItem(TRENDING_HISTORY_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
        return [];
    }
};

export const appendTrendingHistory = (titles: string[]): void => {
    try {
        const existing = getTrendingHistory();
        const seen = new Set(existing.map(normalizeTitleKey));
        const merged = [...existing];
        for (const t of titles) {
            const k = normalizeTitleKey(t);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            merged.push(t);
        }
        localStorage.setItem(TRENDING_HISTORY_KEY, JSON.stringify(merged.slice(-TRENDING_HISTORY_CAP)));
    } catch {}
};

export const clearTrendingHistory = (): void => {
    try { localStorage.removeItem(TRENDING_HISTORY_KEY); } catch {}
};

// Centralized cache key: switching language, mode or the custom prompt (and,
// in preference mode, a changed collection) invalidates the 7-day cache.
export const getTrendingPromptKey = (): string => {
    const s = useAIStore.getState();
    const langKey = i18n.language.split('-')[0];
    const mode: TrendingMode = s.trendingMode || 'recent';
    const parts: string[] = [langKey, mode];
    if (mode === 'custom') parts.push((s.trendingPrompt || '').trim());
    if (mode === 'preference') {
        const titles = useCollectionStore
            .getState()
            .collection.map((i) => normalizeTitleKey(i.title || ''))
            .filter(Boolean)
            .sort();
        parts.push(String(titles.length), titles.join('|').slice(0, 500));
    }
    return parts.join('::');
};

export const getTrendingMedia = async (excludeItems: MediaItem[] = []): Promise<MediaItem[]> => {
  const { systemPrompt, trendingPrompt, provider, trendingMode } = useAIStore.getState();
  const mode: TrendingMode = trendingMode || 'recent';
  const dateObj = new Date();
  const today = dateObj.toISOString().split('T')[0];
  const currentYear = dateObj.getFullYear();
  const currentMonth = dateObj.getMonth() + 1;
  const monthStr = `${currentYear}年${currentMonth}月`;

  const isChinese = i18n.language.startsWith('zh');

  // Reliability: the prompts below demand a web_search tool call. When the
  // provider has no tool support (e.g. custom/OpenAI-compatible endpoints) or
  // search is disabled, instruct the model to fall back to its own knowledge
  // instead of fabricating “trending” data.
  const { enableSearch: trendingEnableSearch, enableNetworking: trendingEnableNetworking } = useAIStore.getState();
  const toolCallingProviders: AIProvider[] = ['moonshot', 'deepseek', 'openai', 'qwen', 'google', 'mistral', 'mimo', 'zhipu'];
  const webSearchAvailable = trendingEnableSearch && trendingEnableNetworking && toolCallingProviders.includes(provider as AIProvider);
  const searchUnavailableNote = webSearchAvailable ? '' : (isChinese
      ? `\n\n[重要] 当前环境没有可用的联网搜索工具：请直接基于你的已有知识完成推荐，只推荐你确信真实存在的具体作品；不要虚构确切的上映日期（不确定时 releaseDate 返回年份），不要臆造 latestUpdateInfo。仍须返回严格合法的 JSON 数组。`
      : `\n\n[IMPORTANT] No web search tool is available in this environment: base your recommendations on your own knowledge and only recommend specific works you are confident actually exist. Do NOT fabricate exact release dates (return the year when unsure) or latestUpdateInfo. Still return a strictly valid JSON array.`);

  // We no longer perform a manual pre-search. We let the AI decide what to search based on the prompt.
  const searchContext = "";

  // Exclusion list: what is on screen right now + everything recommended in
  // previous rounds + (in preference mode) the user's own collection. This is
  // what guarantees each round recommends different works.
  const history = getTrendingHistory();
  const collectionTitles = mode === 'preference'
      ? useCollectionStore.getState().collection.map((i) => i.title || '').filter(Boolean)
      : [];
  const excludeSet = new Set<string>();
  for (const t of [...excludeItems.map((i) => i.title || ''), ...history, ...collectionTitles]) {
      const k = normalizeTitleKey(t);
      if (k) excludeSet.add(k);
  }
  const excludeList = Array.from(excludeSet).slice(0, TRENDING_HISTORY_CAP);
  const excludeReason = mode === 'preference'
      ? (isChinese ? '（含用户已收藏的作品）' : ' (including works already in the user\'s collection)')
      : '';
  const excludeStr = excludeList.length > 0
      ? (isChinese ? `\n\n[排除列表] 以下作品最近展示过或此前已推荐过${excludeReason}，严禁再次推荐，必须推荐其他不同的作品：${excludeList.join('、')}。`
                   : `\n\n[Exclude List] The following works were shown recently or recommended before${excludeReason}. Do NOT include them again; you MUST recommend DIFFERENT works: ${excludeList.join(', ')}.`)
      : "";

  let userPrompt = "";

  if (mode === 'custom' && trendingPrompt && trendingPrompt.trim()) {
      userPrompt = trendingPrompt;
      userPrompt += excludeStr;
      userPrompt += isChinese
        ? `\n\n[系统提示] 当前日期: ${today}。
        1. 你拥有一个 'web_search' 工具。**你必须先使用该工具进行联网搜索**，获取满足上述要求的最新的影视作品信息。
        2. 不要直接编造数据。请根据搜索结果进行推荐。
        3. 请务必严格遵守上述提示词中的所有要求，**特别是关于时间/日期的限制**。如果提示词包含具体日期（如”2024-01-01之后”），**必须**严格过滤掉在此日期之前的作品。
        4. 返回的数据必须准确，releaseDate 需尽量精确到年月日。
        5. 务必返回严格合法的JSON数组，不要包含Markdown格式（如 \`\`\`json）。
        6. 严禁返回任何笼统的平台名称（如”iQIYI”、”Netflix”）、国家类别（如”美国电视剧”）或非具体作品。必须是具体的电影、电视剧或动漫名称。
        7. 严禁返回任何形式的“合集”、“盘点”、“推荐列表”类文章标题（如“2025必看美剧合集”）。必须是单个的具体作品名称。`
        : `\n\n[System Note] Today's Date: ${today}.
        1. You have a 'web_search' tool. **You MUST use this tool first** to search for the latest media works matching the requirements.
        2. Do NOT fabricate data. Recommend based on search results.
        3. You MUST strictly follow all requirements in the prompt above, **especially regarding time/date limits**. If the prompt contains specific dates (e.g. “after 2024-01-01”), you MUST strictly filter out works released before that date.
        4. Ensure returned data is accurate; releaseDate should be as specific as possible.
        5. Return STRICTLY valid JSON array, do NOT use Markdown format (like \`\`\`json).
        6. Do NOT return generic platform names (e.g. “iQIYI”, “Netflix”) or categories (e.g. “US TV Series”). Must be specific movie/series/anime titles.
        7. Do NOT return collection/compilation titles (e.g. “Top 10 Movies”, “Best Series List”). Must be single, specific work titles.`;
  } else if (mode === 'preference') {
     // Taste-based preset: summarize the user's collection, let the model
     // infer preferences, then recommend related works they don't own yet.
     const collection = useCollectionStore.getState().collection;
     const summary = collection.slice(0, 40).map((i) => {
         const bits = [i.title, i.type].filter(Boolean);
         if (i.category) bits.push(String(i.category));
         return `- ${bits.join('｜')}`;
     }).join('\n');
     if (isChinese) {
         userPrompt = `今天是 ${today}。请先分析下面这份用户媒体收藏列表，总结用户的喜好（偏爱的题材、类型、风格、地区等），然后推荐 4 部与该喜好高度相关的作品。

         [用户收藏列表]（共 ${collection.length} 项${collection.length > 40 ? '，仅列出前 40 项' : ''}）
         ${summary || '（收藏为空，请按大众热门口味推荐）'}
         ${excludeStr}

         **重要执行步骤：**
         1. 先从收藏列表归纳用户的口味画像（例如：偏好科幻悬疑类剧集、日式漫画等）。
         2. **调用 web_search 工具**搜索与该画像匹配的候选作品，核实其真实存在及信息准确。
         3. 整理信息，以 JSON 格式返回推荐列表。

         要求：
         1. 优先推荐与收藏中反复出现的题材/类型相同或强相关的其他作品。
         2. 严禁推荐[用户收藏列表]或[排除列表]中已出现的任何作品。
         3. 新作与经典均可，不限于最近上映，但优先推荐口碑好、评分高的作品。
         4. releaseDate 字段必须准确。如果是电视剧，请填写 **最新一季** 的首播日期；不确定时填写年份。
         5. latestUpdateInfo 仅在确定时填写（例如 “第2季 第5集” 或 “已完结”）。
         6. 严禁返回任何笼统的平台名称（如”iQIYI”、”Netflix”）、国家类别（如”美国电视剧”）或非具体作品。
         7. 严禁返回任何形式的“合集”、“盘点”、“推荐列表”类文章标题。必须是单个的具体作品名称。`;
     } else {
         userPrompt = `Today is ${today}. First analyze the user's media collection below, infer their taste (favorite genres, types, styles, regions), then recommend 4 works strongly related to that taste.

         [User Collection] (${collection.length} items${collection.length > 40 ? ', first 40 listed' : ''})
         ${summary || '(collection is empty — recommend by general popularity)'}
         ${excludeStr}

         **Execution Steps:**
         1. Derive a taste profile from the collection (e.g. prefers sci-fi mystery series, Japanese comics).
         2. **Call the web_search tool** to find candidate works matching the profile and verify they exist.
         3. Return the list in JSON format.

         Requirements:
         1. Prioritize works of the same or closely related genres/types that recur in the collection.
         2. Do NOT recommend anything already in [User Collection] or [Exclude List].
         3. New and classic works are both fine — not limited to recent releases — but favor well-reviewed, highly rated works.
         4. releaseDate MUST be accurate. For TV series use the premiere date of the **LATEST SEASON**; use just the year when unsure.
         5. Only fill latestUpdateInfo when you are sure.
         6. Do NOT return generic platform names or categories. Must be specific titles.
         7. Do NOT return collection/compilation titles. Must be single, specific work titles.`;
     }
  } else {
     // 'recent' — time-based preset: hottest / highest-rated of the last 3 months.
     if (isChinese) {
         userPrompt = `今天是 ${today}。请推荐 4 部最近 3 个月内更新、上映或完结的最热门、评分最高的电影、电视剧或动漫。
         ${excludeStr}

         **重要执行步骤：**
         1. **调用 web_search 工具**，搜索关键词: “最热门电影电视剧 ${monthStr}” 或 “${currentYear} 高分影视排行榜”。
         2. 阅读搜索结果，筛选出在 **最近 3 个月内** 有更新、上映或完结的高热度、高评分作品。
         3. 整理信息，以 JSON 格式返回推荐列表。

         要求：
         1. 必须是 **最近 3 个月内** 有更新、上映或完结的作品，且优先选择热度最高、评分最高的。
         2. **必须** 基于联网搜索结果进行推荐。
         3. 严禁推荐几年前的老片，除非它最近有新季度更新。
         4. releaseDate 字段必须准确。如果是电视剧，请填写 **最新一季** 的首播日期。
         5. 返回字段中的 latestUpdateInfo 必须准确（例如 “第2季 第5集” 或 “已完结”）。
         6. 确保上映日期真实准确，不要捏造未来的日期，除非确有官方定档信息。
         7. 严禁返回任何笼统的平台名称（如”iQIYI”、”Netflix”）、国家类别（如”美国电视剧”）或非具体作品。
         8. 严禁返回任何形式的“合集”、“盘点”、“推荐列表”类文章标题。必须是单个的具体作品名称。`;
     } else {
         userPrompt = `Today is ${today}. Recommend 4 of the most popular and highest-rated movies, TV series, or anime that were updated, released, or completed within the last 3 months.
         ${excludeStr}

         **Execution Steps:**
         1. **Call the web_search tool** with queries like: “trending movies tv series ${monthStr}” or “best rated shows ${currentYear}”.
         2. Analyze the results and select the hottest, highest-rated works updated, released, or completed within the **last 3 months**.
         3. Return the list in JSON format.

         Requirements:
         1. Must have been updated, released, or completed within the **last 3 months**; prefer the most popular and highest rated.
         2. **MUST** prioritize selection from web search results.
         3. Do NOT recommend old content unless it has a very recent new season.
         4. releaseDate MUST be accurate. For TV Series, use the premiere date of the **LATEST SEASON**.
         5. Ensure latestUpdateInfo is accurate.
         6. Ensure release dates are factual.
         7. Do NOT return generic platform names (e.g. “iQIYI”, “Netflix”) or categories. Must be specific titles.
         8. Do NOT return collection/compilation titles. Must be single, specific work titles.`;
     }
  }

  // Fallback instructions if search fails
  userPrompt += searchUnavailableNote;
  userPrompt += `\n\nIMPORTANT: ALWAYS return a valid JSON array, even if empty or with fewer items. Do NOT return markdown text or explanations outside the JSON.`;

  const messages = [
    { role: "system", content: systemPrompt + (isChinese ? " 请务必使用JSON格式返回。不要使用Markdown代码块。只返回JSON数组。" : " Please return strictly valid JSON. Do not use markdown code blocks. Return ONLY a JSON array.") },
    { role: "user", content: userPrompt }
  ];

  const parseTrending = async (text: string): Promise<Omit<MediaItem, 'id' | 'posterUrl'>[]> => {
      if (!text) return [];
      let jsonStr = "";
      // Try to find the first '[' and last ']' to extract JSON array
      const firstBracket = text.indexOf('[');
      const lastBracket = text.lastIndexOf(']');
      
      if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
          jsonStr = text.substring(firstBracket, lastBracket + 1);
      } else {
          // Fallback to regex or cleanup
          const jsonArrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
          if (jsonArrayMatch) {
              jsonStr = jsonArrayMatch[0];
          } else {
              jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
          }
      }

      if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) return [];
      
      try {
          const parsed = JSON.parse(jsonStr);
          return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
          console.warn("Initial JSON parse failed, trying recovery", e);
          const lastBracket = jsonStr.lastIndexOf('}');
          if (lastBracket > 0) {
              try {
                  const recovered = jsonStr.substring(0, lastBracket + 1) + ']';
                  const parsed = JSON.parse(recovered);
                  return Array.isArray(parsed) ? parsed : [];
              } catch {
                  return [];
              }
          }
          return [];
      }
  };

  const text = await callAI(messages, 0.3, { forceSearch: true });
  let rawData = await parseTrending(text || "");
  // Drop empty titles and duplicates before anything else — the model
  // occasionally repeats an entry or returns blank placeholders.
  const seenTrendingTitles = new Set<string>();
  rawData = rawData.filter(item => {
      const t = String(item?.title || '').trim();
      if (!t) return false;
      const k = t.toLowerCase();
      if (seenTrendingTitles.has(k)) return false;
      seenTrendingTitles.add(k);
      return true;
  });

  // Filter out generic titles
  const isGenericTitle = (title: string) => {
      const t = title.toLowerCase();
      // 1. Generic Categories/Platforms (Only filter if title is short/almost exact match)
      const genericCategories = [
          'iqiyi', 'netflix', 'amazon', 'hulu', 'disney', 'hbo', 'apple tv', 'peacock', 'paramount',
          'us tv', 'uk tv', 'korean drama', 'japanese anime', 'chinese drama',
          '美国电视剧', '英剧', '韩剧', '日剧', '国产剧', '电视剧', '电影', '动漫',
          'top 10', 'trending', 'hot movies', 'new releases',
          '热门电影', '最新电影', '排行榜'
      ];
      
      if (genericCategories.some(g => t.includes(g) && t.length < g.length + 5)) return true;

      // 2. Banned Phrases (Filter if contained anywhere, usually indicating non-content)
      const bannedPhrases = [
          '合集', '盘点', '推荐', '必看', '片单', 
          'collection', 'compilation', 'list', 'recommendation', 'must watch',
          'ending explained', 'plot breakdown', 'full review', 'season review', 'episode review',
          '结局解析', '剧情分析', '全集解析', '深度解析', '观后感', '评价', '讨论',
          'douban', 'reddit', 'zhihu', 'discussion', 'thoughts on'
      ];
      
      if (bannedPhrases.some(g => t.includes(g))) return true;

      return false;
  };

  rawData = rawData.filter(item => item && item.title && !isGenericTitle(item.title));

  // Enforce the exclude list locally too: the model sometimes ignores it, and
  // dropping those entries here is what guarantees every round differs.
  rawData = rawData.filter(item => !excludeSet.has(normalizeTitleKey(String(item?.title || ''))));

  if (rawData.length > 4) rawData = rawData.slice(0, 4);
  // Remember what we are about to serve so the next round excludes it.
  if (rawData.length > 0) appendTrendingHistory(rawData.map((item) => String(item.title || '')));

  if (rawData.length < 4 && searchContext) {
      try {
          const fb = await createFallbackItemsFromContext(searchContext, 4);
          const uniq = new Map<string, Omit<MediaItem, 'id' | 'posterUrl'>>();
          for (const it of rawData) {
              if (it && (it as any).title) uniq.set(String((it as any).title).toLowerCase(), it);
          }
          for (const it of fb) {
              if (!it || !it.title) continue;
              const k = it.title.toLowerCase();
              if (!uniq.has(k)) {
                  const { id, posterUrl, ...rest } = it as any;
                  uniq.set(k, rest as any);
              }
              if (uniq.size >= 4) break;
          }
          rawData = Array.from(uniq.values()).slice(0, 4);
      } catch {}
  }

  // Enhance with IDs and Posters
  // Strategy: 
  // 1. Map rawData to MediaItems with placeholders.
  // 2. Fetch posters in parallel, but with a strict timeout to ensure the UI isn't blocked for too long.
  // 3. If a poster search times out, we fallback to the placeholder, allowing the text to show up.
  
  const results = rawData.map((item) => {
    const id = uuidv4();
    const placeholder = getPlaceholder(item.type || 'Media');
    return {
      ...item,
      id,
      posterUrl: placeholder,
      userRating: 0,
      status: 'To Watch',
      addedAt: new Date().toISOString()
    } as MediaItem;
  });

  if (results.length === 0) {
      return await createFallbackItemsFromContext(searchContext);
  }
  const norm = (v?: string) => String(v || '').trim();
  const isUnknownText = (v?: string) => {
      const s = norm(v);
      if (!s) return true;
      const low = s.toLowerCase();
      return low === 'unknown' || s === '未知' || low === 'n/a' || low === 'na' || s === '-';
  };
  const isFullDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(norm(v));
  const shouldEnrich = (it: MediaItem) => {
      if (!(it.type === MediaType.MOVIE || it.type === MediaType.TV_SERIES)) return false;
      const dateNeeded = !isFullDate(it.releaseDate);
      const directorNeeded = isUnknownText(it.directorOrAuthor);
      const descNeeded = isUnknownText(it.description) || norm(it.description).length < 60;
      const castNeeded = !it.cast || it.cast.length === 0;
      const posterNeeded = !it.posterUrl || isPlaceholderPosterUrl(it.posterUrl);
      return dateNeeded || directorNeeded || descNeeded || castNeeded || posterNeeded;
  };

  const toPatch = results.filter(shouldEnrich);
  if (toPatch.length === 0) return results;

  const byId = new Map(results.map(r => [r.id, r]));
  const queue = [...toPatch];

  const applyTMDBDetails = async (it: MediaItem) => {
      const tmdbType: 'movie' | 'tv' = it.type === MediaType.TV_SERIES ? 'tv' : 'movie';
      const candidates = await searchTMDB(it.title, tmdbType);
      if (!candidates || candidates.length === 0) return;

      const year = norm(it.releaseDate).slice(0, 4);
      let best: any = undefined;

      if (year && /^\d{4}$/.test(year)) {
          // Strict year match (+/- 1 year tolerance)
          const yNum = parseInt(year, 10);
          best = candidates.find(c => {
              const cDate = c.release_date || c.first_air_date || '';
              const cYear = parseInt(cDate.slice(0, 4), 10);
              return !isNaN(cYear) && Math.abs(cYear - yNum) <= 1;
          });
      } else {
          // If no year, require exact title match
          best = candidates.find(c => (c.title || c.name || '').toLowerCase() === it.title.toLowerCase());
      }

      if (!best || typeof best.id !== 'number') return;

      let details = await getTMDBDetails(best.id, tmdbType, 'zh-CN');
      if (details && isUnknownText(details.overview)) {
          const en = await getTMDBDetails(best.id, tmdbType, 'en-US');
          if (en && !isUnknownText(en.overview)) details = { ...details, overview: en.overview };
      }
      if (!details) return;

      const patch: Partial<MediaItem> = {
          tmdbId: best.id,
          tmdbMediaType: tmdbType
      };

      const rel = norm(details.release_date || details.first_air_date);
      if (rel && !isFullDate(it.releaseDate)) patch.releaseDate = rel;

      if (isUnknownText(it.directorOrAuthor)) {
          if (tmdbType === 'movie') {
              const crew = Array.isArray(details.credits?.crew) ? details.credits.crew : [];
              const directors = crew
                  .filter((c: any) => c && c.name && (c.job === 'Director' || String(c.job || '').toLowerCase().includes('director')))
                  .map((c: any) => String(c.name));
              if (directors.length > 0) patch.directorOrAuthor = directors.slice(0, 2).join(' / ');
          } else {
              const createdBy = Array.isArray(details.created_by) ? details.created_by : [];
              const creators = createdBy.filter((c: any) => c && c.name).map((c: any) => String(c.name));
              if (creators.length > 0) patch.directorOrAuthor = creators.slice(0, 2).join(' / ');
          }
      }

      const overview = norm(details.overview);
      if (overview && (isUnknownText(it.description) || norm(it.description).length < 60)) patch.description = overview;

      if (!it.cast || it.cast.length === 0) {
          const cast = Array.isArray(details.credits?.cast) ? details.credits.cast : [];
          const names = cast.filter((c: any) => c && c.name).map((c: any) => String(c.name)).slice(0, 5);
          if (names.length > 0) patch.cast = names;
      }

      const poster = getTMDBPosterUrl(details.poster_path) || undefined;
      if (poster && isPlaceholderPosterUrl(it.posterUrl)) {
          patch.posterUrl = poster;
      }

      if (Object.keys(patch).length <= 2) return;
      byId.set(it.id, { ...it, ...patch });
  };

  const worker = async () => {
      while (queue.length > 0) {
          const it = queue.shift();
          if (!it) return;
          try { await applyTMDBDetails(it); } catch {}
      }
  };

  await Promise.all([worker(), worker()]);

  const afterTmdb = results.map(r => byId.get(r.id) || r);
  const isPosterPlaceholder = (u?: string) => isPlaceholderPosterUrl(u);

  const typeToPosterQuery = (t: MediaType) => {
      switch (t) {
          case MediaType.TV_SERIES: return 'tv series';
          case MediaType.SHORT_DRAMA: return 'short drama';
          case MediaType.BOOK: return 'book';
          case MediaType.COMIC: return 'comic';
          case MediaType.MUSIC: return 'music';
          case MediaType.MOVIE:
          default:
              return 'movie';
      }
  };

  const withTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T | undefined> => {
      let timer: any = null;
      try {
          return await Promise.race([
              p,
              new Promise<T | undefined>((resolve) => {
                  timer = setTimeout(() => resolve(undefined), ms);
              })
          ]);
      } finally {
          if (timer) clearTimeout(timer);
      }
  };

  const needPoster = afterTmdb.filter(it => isPosterPlaceholder(it.posterUrl));
  if (needPoster.length === 0) return afterTmdb;

  const patched = new Map(afterTmdb.map(r => [r.id, r]));
  await Promise.all(
      needPoster.map(async (it) => {
          try {
              const year = norm(it.releaseDate).slice(0, 4);
              const posterRes = await withTimeout(
                  fetchPosterFromSearch(it.title, year, typeToPosterQuery(it.type)),
                  9000
              );
              if (posterRes?.picked) patched.set(it.id, { ...it, posterUrl: posterRes.picked });
          } catch {}
      })
  );

  return afterTmdb.map(r => patched.get(r.id) || r);
};

export const getAIDate = async (): Promise<string> => {
    const today = new Date().toISOString().split('T')[0];
    const currentLang = i18n.language.split('-')[0]; // 'en' or 'zh'
    const cacheKeyDate = `media_tracker_ai_date_${currentLang}`;
    const cacheKeyContent = `media_tracker_ai_date_content_${currentLang}`;
    
    const cachedDate = localStorage.getItem(cacheKeyDate);
    const cachedContent = localStorage.getItem(cacheKeyContent);

    if (cachedDate === today && cachedContent) {
        console.log("[getAIDate] Using cached date:", cachedContent);
        return cachedContent;
    }

    const isChinese = currentLang === 'zh';
    const systemPrompt = isChinese ? "你是一个报时助手。" : "You are a time announcement assistant.";
    const userPrompt = isChinese 
        ? `今天是 ${today}。请告诉我今天的日期，并附带一句简短的关于电影或生活的美好寄语（20字以内）。格式：YYYY年MM月DD日 | 寄语`
        : `Today is ${today}. Please tell me today's date followed by a very short inspiring quote about movies or life (max 10 words). Format: YYYY-MM-DD | Quote`;

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
    ];

    try {
        console.log("[getAIDate] Calling AI...");
        const text = await callAI(messages, 0.7);
        if (text) {
            const cleanText = text.replace(/"/g, '').trim();
            console.log("[getAIDate] Success:", cleanText);
            localStorage.setItem(cacheKeyDate, today);
            localStorage.setItem(cacheKeyContent, cleanText);
            return cleanText;
        }
    } catch (e) {
        console.warn("[getAIDate] Failed to get AI date", e);
    }
    
    return today;
};
