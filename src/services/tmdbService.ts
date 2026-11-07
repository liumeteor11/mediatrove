
import { useAIStore } from "../store/useAIStore";
import i18n from '../i18n';
import { v4 as uuidv4 } from 'uuid';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// TMDB's `language` param only localizes the returned fields (titles,
// overviews, posters) — matching is unaffected. Deriving it from the UI
// language keeps fetched details and artwork consistent with the UI.
export const tmdbLanguageFromUI = (): string => (i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US');

const CJK_DIGITS: Record<string, number> = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const parseCjkNumber = (s: string): number | null => {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (CJK_DIGITS[s] !== undefined) return CJK_DIGITS[s];
    if (s === '十') return 10;
    const mTeens = s.match(/^十([一二三四五六七八九])$/); if (mTeens) return 10 + CJK_DIGITS[mTeens[1]];
    const mTens = s.match(/^([一二三四五六七八九])十$/); if (mTens) return CJK_DIGITS[mTens[1]] * 10;
    const mTensOnes = s.match(/^([一二三四五六七八九])十([一二三四五六七八九])$/); if (mTensOnes) return CJK_DIGITS[mTensOnes[1]] * 10 + CJK_DIGITS[mTensOnes[2]];
    return null;
};

// Split a season suffix off a title: "终极名单 第二季" / "The Witcher Season 5" /
// "Title S2" / "Title（第2季）" → { base, season }. TMDB search does not handle
// season suffixes (and matches only show-level entries), so callers search the
// stripped base title and can then fetch season-specific artwork.
export const parseSeasonSuffix = (title: string): { base: string; season: number | null } => {
    const t = String(title || '').trim();
    let m = t.match(/^(.+?)\s*[（(]?\s*第([零一二三四五六七八九十\d]+)季\s*[)）]?\s*$/);
    if (m && m[1]) {
        const n = parseCjkNumber(m[2]);
        if (n && n > 0) return { base: m[1].trim(), season: n };
    }
    m = t.match(/^(.+?)\s+(?:season\s*)?s(\d{1,2})\s*$/i);
    if (m) {
        const n = parseInt(m[2], 10);
        if (n > 0) return { base: m[1].trim(), season: n };
    }
    m = t.match(/^(.+?)\s+season\s*(\d{1,2})\s*$/i);
    if (m) {
        const n = parseInt(m[2], 10);
        if (n > 0) return { base: m[1].trim(), season: n };
    }
    return { base: t, season: null };
};

// Season-level poster: `/tv/{id}/season/{n}` carries the artwork for that
// season specifically, while the show-level poster is usually season 1's —
// the right pick when the user is tracking a later season.
export const getTMDBSeasonPoster = async (id: number, season: number, language: string = tmdbLanguageFromUI()): Promise<string | null> => {
    const s = useAIStore.getState();
    const key = s.getDecryptedTmdbKey && s.getDecryptedTmdbKey();
    if (!s.enableTmdb || !key) return null;
    try {
        const url = `${TMDB_BASE_URL}/tv/${id}/season/${season}?api_key=${key}&language=${encodeURIComponent(language)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.poster_path ? getTMDBPosterUrl(data.poster_path, 'w500') : null;
    } catch {
        return null;
    }
};
const TMDB_DETAILS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const tmdbDetailsMemCache = new Map<string, { ts: number; data: any }>();

export interface TMDBMedia {
  id: number;
  title?: string;
  name?: string; // for TV
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string; // for TV
  media_type: 'movie' | 'tv' | 'person';
  genre_ids: number[];
  vote_average: number;
}

export const searchTMDB = async (query: string, type: 'movie' | 'tv' | 'multi' = 'multi', language: string = tmdbLanguageFromUI()): Promise<TMDBMedia[]> => {
  const s = useAIStore.getState();
  const key = s.getDecryptedTmdbKey && s.getDecryptedTmdbKey();

  // The settings toggle must fully disable TMDB, not just cover fetching —
  // otherwise switching it off still sends searches to TMDB.
  if (!s.enableTmdb) return [];

  if (!key) {
    console.warn("TMDB API Key is missing");
    return [];
  }

  try {
    const url = `${TMDB_BASE_URL}/search/${type}?api_key=${key}&query=${encodeURIComponent(query)}&language=${encodeURIComponent(language)}&include_adult=false`;
    const t0 = performance.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB Error: ${res.statusText}`);
    const data = await res.json();
    const results = data.results || [];
    // Mirror other providers into the I/O log — TMDB lookups used to be
    // completely invisible there, which made poster failures undiagnosable.
    try {
      useAIStore.getState().appendLog({
        id: uuidv4(),
        ts: Date.now(),
        channel: 'search',
        provider: 'tmdb',
        query,
        request: { query, type, language },
        response: { count: Array.isArray(results) ? results.length : 0, firstPosterPath: results[0]?.poster_path ?? null },
        durationMs: Math.round(performance.now() - t0)
      });
    } catch {}
    return results;
  } catch (error) {
    console.error("TMDB Search Failed:", error);
    return [];
  }
};

export const getTMDBDetails = async (id: number, type: 'movie' | 'tv', language: string = tmdbLanguageFromUI()): Promise<any> => {
    const s = useAIStore.getState();
    const key = s.getDecryptedTmdbKey && s.getDecryptedTmdbKey();
    if (!s.enableTmdb || !key) return null

    try {
        const cacheKey = `tmdb_details_v1_${type}_${id}_${language}`;
        const now = Date.now();
        const mem = tmdbDetailsMemCache.get(cacheKey);
        if (mem && (now - mem.ts) < TMDB_DETAILS_CACHE_TTL_MS) return mem.data;

        if (typeof localStorage !== 'undefined') {
            const cachedTs = localStorage.getItem(`${cacheKey}_ts`);
            const cached = localStorage.getItem(cacheKey);
            if (cachedTs && cached) {
                const ts = parseInt(cachedTs, 10);
                if (!Number.isNaN(ts) && (now - ts) < TMDB_DETAILS_CACHE_TTL_MS) {
                    const data = JSON.parse(cached);
                    tmdbDetailsMemCache.set(cacheKey, { ts, data });
                    return data;
                }
            }
        }

        const url = `${TMDB_BASE_URL}/${type}/${id}?api_key=${key}&language=${encodeURIComponent(language)}&append_to_response=credits,images`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`TMDB Error: ${res.statusText}`);
        const data = await res.json();
        tmdbDetailsMemCache.set(cacheKey, { ts: now, data });
        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.setItem(cacheKey, JSON.stringify(data));
                localStorage.setItem(`${cacheKey}_ts`, now.toString());
            } catch {}
        }
        return data;
    } catch (error) {
        console.error("TMDB Details Failed:", error);
        return null;
    }
};

export const testTmdbConnection = async (apiKey: string): Promise<{ ok: boolean; error?: string }> => {
    try {
        const url = `${TMDB_BASE_URL}/authentication/token/new?api_key=${apiKey}`;
        const res = await fetch(url);
        if (res.ok) {
            return { ok: true };
        } else {
            const data = await res.json();
            return { ok: false, error: data.status_message || res.statusText };
        }
    } catch (e: any) {
        return { ok: false, error: e.message };
    }
};

export const getTMDBPosterUrl = (path: string | null, size: 'w500' | 'original' = 'w500') => {
    if (!path) return null;
    return `https://image.tmdb.org/t/p/${size}${path}`;
};
