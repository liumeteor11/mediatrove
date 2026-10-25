import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Search, Loader2, TrendingUp, AlertCircle, RefreshCw, Edit, X, Save, RotateCcw } from 'lucide-react';
import { searchMedia, getTrendingMedia, fetchPosterFromSearch, performClientSideSearch, processSearchResult, refreshTrendingCache, isPlaceholderPosterUrl, canUseNativeSearch } from '../services/aiService';
import { MediaItem, CollectionCategory, MediaType } from '../types/types';
import { MediaCard } from '../components/MediaCard';
import { useCollectionStore } from '../store/useCollectionStore';
import { useAIStore } from '../store/useAIStore';
import { useSearchStore } from '../store/useSearchStore';
import { toast } from 'react-toastify';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { v4 as uuidv4 } from 'uuid';

export const SearchPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { trendingPrompt, setConfig, enableTrending } = useAIStore();
  
  // Use global search store
  const { 
    query, results, searchLoading, trendingLoading, error, selectedType, isTrending, currentSearchId,
    setQuery, setResults, setSearchLoading, setTrendingLoading, setError, setSelectedType, setIsTrending, setCurrentSearchId, resetSearch
  } = useSearchStore();

  const loading = searchLoading || trendingLoading;
  
  const [isPromptModalOpen, setIsPromptModalOpen] = useState(false);
  const [tempPrompt, setTempPrompt] = useState('');

  const { addToCollection } = useCollectionStore();
  
  // Refs to access latest state in async functions without dependencies
  const isTrendingRef = useRef(isTrending);
  const queryRef = useRef(query);
  const selectedTypeRef = useRef<MediaType | 'All'>(selectedType);
  const searchLoadingOpRef = useRef<string | null>(null);

  useEffect(() => { isTrendingRef.current = isTrending; }, [isTrending]);
  useEffect(() => { queryRef.current = query; }, [query]);
  useEffect(() => { selectedTypeRef.current = selectedType; }, [selectedType]);

  const startOp = () => {
    const id = uuidv4();
    setCurrentSearchId(id);
    return id;
  };

  const getRelevanceScore = (item: MediaItem, q: string) => {
    const qLower = q.trim().toLowerCase();
    if (!qLower) return 0;
    const title = (item.title || '').toLowerCase();
    const desc = (item.description || '').toLowerCase();
    const people = `${item.directorOrAuthor || ''} ${(item.cast || []).join(' ')}`.toLowerCase();
    const tokens = qLower
      .split(/[\s,，。.;:：/\\\-_|]+/)
      .map(s => s.trim())
      .filter(s => s && (s.length > 1 || /\d/.test(s)));
    if (!tokens.includes(qLower)) tokens.unshift(qLower);
    let score = 0;
    if (title === qLower) score += 200;
    if (title.includes(qLower)) score += 120;
    tokens.forEach(tk => {
      if (title.includes(tk)) score += 40;
      if (desc.includes(tk)) score += 10;
      if (people.includes(tk)) score += 8;
    });
    const year = (item.releaseDate || '').split('-')[0];
    if (year && qLower.includes(year)) score += 20;
    return score;
  };

  const sortByRelevance = (items: MediaItem[], q: string) => {
    return [...items].sort((a, b) => getRelevanceScore(b, q) - getRelevanceScore(a, q));
  };

  const cancelOps = () => {
    setCurrentSearchId(null);
  };

  // Check if the operation is still the latest one
  const isOpActive = (id: string) => useSearchStore.getState().currentSearchId === id;

  // Handle reset-search event
  useEffect(() => {
    const handleReset = () => {
        cancelOps(); // Cancel any ongoing operations
        resetSearch(); // Reset store state
        loadTrending(); // Load trending
    };
    window.addEventListener('reset-search', handleReset);
    return () => window.removeEventListener('reset-search', handleReset);
  }, []);

  const getSearchCacheKeys = (q: string) => {
    const langKey = i18n.language.split('-')[0];
    const types: Array<MediaType | 'All'> = ['All', MediaType.MOVIE, MediaType.TV_SERIES, MediaType.BOOK, MediaType.COMIC, MediaType.SHORT_DRAMA, MediaType.MUSIC];
    return types.map(t => ({
      type: t,
      key: `media_tracker_search_${langKey}_${t}_${q.trim().toLowerCase()}`,
      tsKey: `media_tracker_search_${langKey}_${t}_${q.trim().toLowerCase()}_ts`
    }));
  };

  const writeSearchCache = (q: string, type: MediaType | 'All', items: MediaItem[]) => {
    try {
      const langKey = i18n.language.split('-')[0];
      const key = `media_tracker_search_${langKey}_${type}_${q.trim().toLowerCase()}`;
      const tsKey = `${key}_ts`;
      localStorage.setItem(key, JSON.stringify(items));
      localStorage.setItem(tsKey, Date.now().toString());
    } catch {}
  };

  const filters = useMemo(() => [
    { label: t('search_page.filter_all'), value: 'All' },
    { label: t('search_page.filter_movies'), value: MediaType.MOVIE },
    { label: t('search_page.filter_tv'), value: MediaType.TV_SERIES },
    { label: t('search_page.filter_books'), value: MediaType.BOOK },
    { label: t('search_page.filter_comics'), value: MediaType.COMIC },
    { label: t('search_page.filter_short_dramas'), value: MediaType.SHORT_DRAMA },
    { label: t('search_page.filter_music'), value: MediaType.MUSIC },
    { label: t('search_page.filter_other'), value: MediaType.OTHER },
  ], [t]);

  // Initial load of trending if no results
  useEffect(() => {
    if (enableTrending) {
        if (results.length === 0 && !query.trim() && !loading) {
            loadTrending();
        }
    } else if (isTrending) {
        setIsTrending(false);
        setResults([]);
    }
  }, [enableTrending]);

  const getTrendingPromptKey = () => {
    const langKey = i18n.language.split('-')[0];
    const promptKey = (trendingPrompt || '').trim();
    return `${langKey}::${promptKey}`;
  };

  const loadTrending = async (forceRefresh = false, opts: { silent?: boolean } = {}) => {
    const opId = startOp();
    const silent = !!opts.silent;
    if (!silent) {
      setTrendingLoading(true);
    }
    if (!silent) setError(null);
    if (forceRefresh) {
      toast.info(t('search_page.refreshing_toast'));
    }
    
    try {
      // 1. Check local storage if not forcing refresh
      if (!forceRefresh) {
        const cachedData = localStorage.getItem('media_tracker_trending_data');
        const cachedTs = localStorage.getItem('media_tracker_trending_ts');
        const cachedPromptKey = localStorage.getItem('media_tracker_trending_prompt_key');
        const currentPromptKey = getTrendingPromptKey();
        
        if (cachedData && cachedTs) {
            const now = Date.now();
            const lastRefresh = parseInt(cachedTs, 10);
            const sevenDays = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
            
            if (now - lastRefresh < sevenDays && cachedPromptKey === currentPromptKey) {
                try {
                    const parsedData = JSON.parse(cachedData);
                    if (Array.isArray(parsedData) && parsedData.length > 0) {
                         const limited = parsedData.slice(0, 4);
                         if (!isOpActive(opId)) return;
                         setResults(limited);
                         setIsTrending(true);
                         hydratePosters(limited, { persistTrending: true }, opId);
                         if (!silent && isOpActive(opId)) setTrendingLoading(false);
                         return;
                    }
                } catch (e) {
                    console.error("Cache parse error", e);
                }
            }
        }
      }

      // 2. Fetch new data
      // Pass current results to exclude them if refreshing
      const excludeItems = forceRefresh ? results : [];
      const trending = await getTrendingMedia(excludeItems);
      if (!isOpActive(opId)) return;
      
      // 3. Save to local storage
      if (trending.length > 0) {
        const limited = trending.slice(0, 4);
        setResults(limited);
        setIsTrending(true);
        localStorage.setItem('media_tracker_trending_data', JSON.stringify(limited));
        localStorage.setItem('media_tracker_trending_ts', Date.now().toString());
        localStorage.setItem('media_tracker_trending_prompt_key', getTrendingPromptKey());
        if (forceRefresh) {
             await hydratePosters(limited, { force: true, persistTrending: true }, opId);
             toast.success(t('search_page.refresh_done'));
        } else {
             hydratePosters(limited, { persistTrending: true }, opId);
        }
      } else {
         const cachedData = localStorage.getItem('media_tracker_trending_data');
         if (cachedData) {
            try {
                const parsedData = JSON.parse(cachedData);
                if (Array.isArray(parsedData) && parsedData.length > 0) {
                    if (!isOpActive(opId)) return;
                    setResults(parsedData);
                    setIsTrending(true);
                    if (forceRefresh) {
                      await hydratePosters(parsedData, { force: true, persistTrending: true }, opId);
                      toast.error(t('search_page.trending_refresh_failed'));
                    } else {
                      hydratePosters(parsedData, { persistTrending: true }, opId);
                    }
                } else {
                    if (forceRefresh && isOpActive(opId)) setError(t('search_page.trending_refresh_failed'));
                }
            } catch {
                if (forceRefresh && isOpActive(opId)) setError(t('search_page.trending_refresh_failed'));
            }
         } else {
            if (forceRefresh && isOpActive(opId)) setError(t('search_page.trending_refresh_failed'));
         }
      }
      
    } catch (err) {
      if (isOpActive(opId)) setError(t('search_page.trending_load_failed'));
      if (forceRefresh) toast.error(t('search_page.trending_refresh_failed'));
    } finally {
      if (!silent && isOpActive(opId)) setTrendingLoading(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const opId = startOp();

    setSearchLoading(true);
    searchLoadingOpRef.current = opId;
    setError(null);
    setIsTrending(false);
    setResults([]);
    toast.info(t('search_page.searching_wait'));
    const startTs = performance.now();
    
    // Timeout warning
    const timeoutId = setTimeout(() => {
        // Check if this operation is still the active one and still loading
        if (isOpActive(opId) && useSearchStore.getState().searchLoading) {
            toast.warn(t('search_page.search_taking_long', { defaultValue: "Search is taking longer than expected, please wait..." }));
        }
    }, 10000); // 10 seconds

    try {
      const data = await searchMedia(q, selectedType);
      clearTimeout(timeoutId);
      
      if (!isOpActive(opId)) return;
      const duration = Math.round(performance.now() - startTs);
      const sorted = sortByRelevance(data, q);
      setResults(sorted);
      writeSearchCache(q, selectedType, sorted);
      useAIStore.getState().setConfig({ lastSearchDurationMs: duration, lastSearchAt: new Date().toISOString(), lastSearchQuery: q });
      
      const verifiedData = await verifyResults(sorted, q, opId);
      const dataForHydration = verifiedData || sorted;
      void hydratePosters(dataForHydration, {}, opId).catch(() => {});

      if (data.length === 0) {
        const cfg = useAIStore.getState();
        const hasKey = !!cfg.getDecryptedApiKey();
        if (!hasKey) {
          setError(t('search_page.network_unavailable'));
          toast.error(t('search_page.network_unavailable'));
        } else {
          setError(t('search_page.no_results_found'));
          toast.info(t('search_page.no_results_found'));
        }
      } else {
        toast.success(t('search_page.search_done', { count: data.length }));
      }
    } catch (err) {
      clearTimeout(timeoutId);
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (isOpActive(opId)) setError(`${t('search_page.search_error')} ${errorMsg}`);
      toast.error(t('search_page.search_error'));
    } finally {
      if (isOpActive(opId)) setSearchLoading(false);
    }
  };

  const verifyResults = async (items: MediaItem[], q: string, opId: string): Promise<MediaItem[] | undefined> => {
    // searchMedia's AI call runs with forced search: when the model can search
    // natively, the engine-API verification pass is redundant.
    if (canUseNativeSearch(true)) return undefined;
    try {
      const ctx = await performClientSideSearch(q, true, selectedTypeRef.current);
      if (!ctx) return undefined;
      const arr = JSON.parse(ctx);
      if (!Array.isArray(arr)) return undefined;
      const idx = new Map<string, any>();
      for (const r of arr) {
        const p = processSearchResult(r.title || '', r.snippet || '');
        // Use a composite key if year is available to avoid mismatching remakes
        const key = p.year ? `${p.title.toLowerCase()}|${p.year}` : p.title.toLowerCase();
        idx.set(key, { raw: r, meta: p });
        // Also index by title only as fallback if not already present
        if (!idx.has(p.title.toLowerCase())) {
            idx.set(p.title.toLowerCase(), { raw: r, meta: p });
        }
      }
      const pickNames = (text: string) => {
        return text
          .split(/[,，、;；\s]+/)
          .map(s => s.trim())
          .filter(Boolean)
          .slice(0, 5);
      };

      const mapped = items.map(it => {
          // Try exact match with year first
          const year = it.releaseDate ? it.releaseDate.split('-')[0] : '';
          let rec = idx.get(`${it.title.toLowerCase()}|${year}`);
          // Fallback to title only match
          if (!rec) rec = idx.get(it.title.toLowerCase());
          
          if (!rec) return it;
          const { raw, meta } = rec;
          const snip: string = (raw.snippet || '').toString();
          const lower = snip.toLowerCase();
          let director = it.directorOrAuthor || '';
          let cast: string[] = Array.isArray(it.cast) ? it.cast : [];
          let desc = it.description || '';
          const y = meta.year;
          const m1 = snip.match(/导演[:：]\s*([^。；;\n]+)/);
          const m2 = snip.match(/(Director|Directors)[:\-–—]\s*([^.;\n]+)/i);
          const m3 = snip.match(/(Author|作者)[:：\-–—]\s*([^.;。；\n]+)/i);
          const c1 = snip.match(/主演[:：]\s*([^。；;\n]+)/);
          const c2 = snip.match(/演员[:：]\s*([^。；;\n]+)/);
          const c3 = snip.match(/配音[:：]\s*([^。；;\n]+)/);
          const c4 = snip.match(/(Stars?|Cast|Starring)[:\-–—]?\s*([^.;\n]+)/i);
          if (!director) {
            if (m1 && m1[1]) director = m1[1].trim();
            else if (m2 && m2[2]) director = m2[2].trim();
            else if (m3 && m3[2]) director = m3[2].trim();
          }
          if (!cast || cast.length === 0) {
            const rawCast = c1?.[1] || c2?.[1] || c3?.[1] || c4?.[2] || '';
            if (rawCast) cast = pickNames(rawCast.replace(/^(and|with)\s+/i, ''));
          }
          if (!desc || desc.length < 60) {
            desc = snip.trim();
          }
          const next: MediaItem = { ...it };
          if (y) {
            const cur = (next.releaseDate || '').trim();
            const curIsFullDate = /^\d{4}-\d{2}-\d{2}$/.test(cur);
            const curIsYearOnly = /^\d{4}$/.test(cur);
            if (!cur || cur.length < 4) next.releaseDate = y;
            else if (!curIsFullDate && curIsYearOnly && cur !== y) next.releaseDate = y;
          }
          if (director) next.directorOrAuthor = director;
          if (cast && cast.length > 0) next.cast = cast;
          if (desc) next.description = desc;
          return next;
      });

      const sorted = sortByRelevance(mapped, q);
      setResults(prev => {
        if (!isOpActive(opId)) return prev;
        return sorted;
      });
      try { writeSearchCache(q, selectedType, sorted); } catch {}
      return sorted;
    } catch {
        return undefined;
    }
  };

  const hydratePosters = async (
    items: MediaItem[],
    opts: { force?: boolean; persistTrending?: boolean } = {}
    , opId?: string
  ) => {
    const effOpId = opId ?? startOp();
    const force = !!opts.force;
    const persistTrending = !!opts.persistTrending;
    const queue = items.filter(i => !i.customPosterUrl && (force || isPlaceholderPosterUrl(i.posterUrl)));
    const mergedById = new Map<string, MediaItem>(items.map(i => [i.id, i]));

    const persist = (arr: MediaItem[]) => {
      if (!persistTrending) return;
      try {
        localStorage.setItem('media_tracker_trending_data', JSON.stringify(arr));
        localStorage.setItem('media_tracker_trending_ts', Date.now().toString());
        localStorage.setItem('media_tracker_trending_prompt_key', getTrendingPromptKey());
      } catch {}
    };

    const applyUpdate = (id: string, expectedTitle: string, patch: Partial<MediaItem>) => {
      if (!isOpActive(effOpId)) return;
      const cur = mergedById.get(id);
      if (!cur) return;
      // Double check title to prevent mismatch
      if (cur.title !== expectedTitle) return;

      // Check if we are overwriting a valid poster with an invalid one or placeholder
      // If the current poster is valid (not placeholder), and the new one is invalid or placeholder, skip
      // Unless force is true? hydratePosters is called with force=true on manual refresh.
      // But even if force is true, we shouldn't replace a valid poster with a broken one if possible.
      // Actually, fetchPosterFromSearch returns undefined if failed.
      // fetchPosterFromSearch logic ensures it tries to return a real image.
      
      // Additional safety: if the current item ALREADY has a valid poster (and we are not in force mode, OR even if we are),
      // we should be careful. 
      // The issue description says "refreshes twice, replacing correct image with wrong one".
      // This implies multiple calls to applyUpdate or race condition.
      
      // Let's ensure we don't apply the same update redundantly or regress.
      if (patch.posterUrl && isPlaceholderPosterUrl(patch.posterUrl) && !isPlaceholderPosterUrl(cur.posterUrl)) {
          // New poster is placeholder, but old one was valid. Skip.
          return;
      }

      const next = { ...cur, ...patch } as MediaItem;
      mergedById.set(id, next);
      setResults(prev => {
        if (!isOpActive(effOpId)) return prev;
        
        // Safety: check if the item in 'prev' has changed in a way that makes this update stale?
        // 'prev' is the latest state.
        const currentInState = prev.find(r => r.id === id);
        if (currentInState && currentInState.title !== expectedTitle) return prev; // Title mismatch in state
        
        const mapped = prev.map(r => r.id === id ? { ...r, ...patch } : r);
        try {
          if (!isTrendingRef.current && queryRef.current.trim()) {
            writeSearchCache(queryRef.current, selectedTypeRef.current, mapped);
          }
        } catch {}
        if (persistTrending) persist(mapped);
        return mapped;
      });
    };

    const worker = async () => {
      while (queue.length > 0) {
        if (!isOpActive(effOpId)) return;
        const item = queue.shift()!;
        const year = item.releaseDate ? item.releaseDate.split('-')[0] : '';
        try {
          const { picked } = await fetchPosterFromSearch(item.title, year, item.type);
          if (!isOpActive(effOpId)) return;
          if (picked) applyUpdate(item.id, item.title, { posterUrl: picked });
        } catch {}
      }
    };

    await Promise.all([worker(), worker(), worker()]);
    const finalArr = items.map(i => mergedById.get(i.id) || i);
    persist(finalArr);
    return finalArr;
  };

  const showCachedTrending = (): boolean => {
    try {
      const cachedData = localStorage.getItem('media_tracker_trending_data');
      if (!cachedData) return false;
      const parsedData = JSON.parse(cachedData);
      if (!Array.isArray(parsedData) || parsedData.length === 0) return false;
      setResults(parsedData.slice(0, 4));
      return true;
    } catch {
      return false;
    }
  };

  const onAddToCollection = (item: MediaItem, category: CollectionCategory) => {
    addToCollection(item, category);
    toast.success(t('search_page.added_to_collection', { title: item.title, category }));
  };

  const openPromptModal = () => {
      if (trendingPrompt && trendingPrompt.trim()) {
          setTempPrompt(trendingPrompt);
      } else {
          setTempPrompt(t('search_page.default_prompt'));
      }
      setIsPromptModalOpen(true);
  };

  const savePrompt = async () => {
      let finalPrompt = tempPrompt;
      
      // Removed translation logic as requested
      setConfig({ trendingPrompt: finalPrompt });
      setIsPromptModalOpen(false);
      toast.success(t('common.save_success', { defaultValue: "Saved" }));
      // Reload trending with new prompt
      loadTrending(true);
  };

  const restoreDefault = () => {
      setTempPrompt(t('search_page.default_prompt'));
  };

  return (
    <div className="space-y-8 relative">
       {/* Spotlight Effect */}
       <div className="absolute top-[-100px] left-1/2 transform -translate-x-1/2 w-[600px] h-[600px] rounded-full blur-[100px] opacity-30 pointer-events-none bg-theme-accent" />

      {/* Search Header */}
      <div className="text-center mb-12 space-y-6 relative z-10">
        <h1 className="text-4xl md:text-6xl heading-strong text-theme-accent-warm">
          {t('search_page.title')}
        </h1>
        <p className="text-lg max-w-2xl mx-auto text-theme-subtext">
          {t('search_page.subtitle')}
        </p>
        
        <form onSubmit={handleSearch} className="max-w-xl mx-auto relative group">
          <div className="absolute -inset-0.5 rounded-full blur opacity-30 group-hover:opacity-100 transition duration-1000 group-hover:duration-200 bg-gradient-to-r from-theme-accent to-theme-accent-hover"></div>
          <input
            type="text"
            value={query}
            onChange={(e) => {
                const val = e.target.value;
                setQuery(val);
                if (val.trim() === '') {
                    cancelOps();
                    setError(null);
                    setSearchLoading(false);
                    setTrendingLoading(false);
                    if (enableTrending) {
                        setIsTrending(true);
                        if (!showCachedTrending()) loadTrending(false, { silent: true });
                    } else {
                        setIsTrending(false);
                        setResults([]);
                    }
                }
            }}
            placeholder={t('search_page.input_placeholder')}
            className="relative w-full pl-12 pr-40 py-4 rounded-full border-2 focus:outline-none focus:ring-2 shadow-xl text-lg transition-all bg-theme-surface border-theme-border text-theme-text focus:border-theme-accent focus:ring-theme-accent/20 placeholder-theme-subtext"
          />
          <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-6 h-6 text-theme-subtext" />

          <div className="absolute right-2 top-2 bottom-2 flex items-center gap-1 z-20">
            {query && (
              <button
                type="button"
                onClick={() => {
                  cancelOps();
                  setQuery('');
                  setError(null);
                  setSearchLoading(false);
                  setTrendingLoading(false);
                  if (enableTrending) {
                      setIsTrending(true);
                      if (!showCachedTrending()) loadTrending(false, { silent: true });
                  } else {
                      setIsTrending(false);
                      setResults([]);
                  }
                }}
                className="p-2 rounded-full text-theme-subtext hover:bg-theme-bg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            )}

            <button 
              type="submit"
              disabled={searchLoading || !query.trim()}
              className="h-full px-6 rounded-full font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 bg-theme-accent text-theme-bg hover:bg-theme-accent-hover hover:shadow-lg border-2 border-theme-accent focus:outline-none focus:ring-2 focus:ring-theme-accent flex items-center justify-center gap-2 min-w-[92px]"
            >
              {searchLoading && <Loader2 className="w-5 h-5 animate-spin" />}
              <span>{t('search_page.search_btn')}</span>
            </button>
          </div>
        </form>

        <div className="flex flex-wrap md:flex-nowrap justify-center gap-2 mt-6 max-w-4xl mx-auto overflow-x-auto pb-2 no-scrollbar px-4">
          {filters.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setSelectedType(filter.value as MediaType | 'All')}
              className={clsx(
                "px-4 py-2 rounded-full text-sm font-medium transition-all duration-300 border focus:outline-none focus:ring-2 focus:ring-theme-accent whitespace-nowrap flex-shrink-0",
                selectedType === filter.value
                  ? "bg-theme-accent text-theme-bg border-theme-accent border-2 shadow-lg"
                  : "bg-theme-surface text-theme-subtext border-theme-border hover:border-theme-accent/50 hover:text-theme-text"
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results Section */}
      <div className="space-y-6">
        <div className="flex items-center gap-2 mb-6 border-b pb-4 border-theme-border">
            {isTrending ? (
                <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2 font-bold text-xl text-theme-accent">
                        <TrendingUp className="w-6 h-6" />
                        <h2>{t('search_page.trending_title')}</h2>
                    </div>
                    
                    <div className="flex items-center gap-2">
                        <button
                            onClick={openPromptModal}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all bg-theme-surface text-theme-text border-2 border-theme-accent hover:bg-theme-bg focus:outline-none focus:ring-2 focus:ring-theme-accent"
                            title={t('search_page.edit_prompt')}
                        >
                            <Edit className="w-4 h-4" />
                            <span className="hidden sm:inline">{t('search_page.edit_prompt')}</span>
                        </button>

                        <button
                            onClick={() => loadTrending(true)}
                            disabled={trendingLoading}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all bg-theme-surface text-theme-accent hover:bg-theme-bg disabled:opacity-50 border-2 border-theme-accent focus:outline-none focus:ring-2 focus:ring-theme-accent"
                            title={t('search_page.refresh_tooltip')}
                        >
                            <RefreshCw className={clsx("w-4 h-4", trendingLoading && "animate-spin")} />
                            <span>{trendingLoading ? t('search_page.refreshing') : t('search_page.refresh')}</span>
                        </button>
                    </div>
                </div>
            ) : (
                <h2 className="text-xl font-bold text-theme-text">
                    {results.length > 0 ? `${t('search_page.results_for')} "${query}"` : ''}
                </h2>
            )}
        </div>

        {error && (
            <div className="flex items-center justify-center p-8 rounded-xl border text-red-600 bg-red-50 border-red-100">
                <AlertCircle className="w-6 h-6 mr-2" />
                {error}
            </div>
        )}

        {(searchLoading || (trendingLoading && results.length === 0)) ? (
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="rounded-xl aspect-[1/1.48] animate-pulse border p-4 bg-theme-surface border-theme-border">
                    <div className="w-full h-2/3 rounded-lg mb-4 bg-theme-bg"></div>
                    <div className="h-4 rounded w-3/4 mb-2 bg-theme-bg"></div>
                    <div className="h-4 rounded w-1/2 bg-theme-bg"></div>
                </div>
              ))}
           </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-y-8 gap-x-6">
            {results.map((item, index) => (
              <MediaCard 
                key={item.id} 
                item={item} 
                onAction={onAddToCollection}
                index={index}
              />
            ))}
          </div>
        )}
      </div>

      {/* Edit Prompt Modal */}
      {isPromptModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-theme-surface border border-theme-border rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-4 border-b border-theme-border">
                <h3 className="text-lg font-bold text-theme-text">{t('search_page.prompt_modal_title')}</h3>
                <button onClick={() => setIsPromptModalOpen(false)} className="p-1 hover:bg-theme-bg rounded-full transition-colors">
                <X className="w-5 h-5 text-theme-subtext" />
                </button>
            </div>
            
            <div className="p-4 flex-1 overflow-y-auto space-y-4">
                <div className="flex gap-2 flex-wrap">
                    <span className="text-xs text-theme-subtext self-center">{t('search_page.insert_template')}:</span>
                    <button
                        onClick={() => {
                            const d = new Date();
                            d.setMonth(d.getMonth() - 3);
                            const dateStr = d.toISOString().split('T')[0];
                            const template = t('search_page.template_date_constraint', { date: dateStr });
                            setTempPrompt(prev => `${prev} ${template}`.trim());
                        }}
                        className="px-2 py-1 text-xs rounded border border-theme-border bg-theme-bg hover:bg-theme-surface transition-colors text-theme-text"
                    >
                        + {t('search_page.template_recent_3_months')}
                    </button>
                    <button
                        onClick={() => {
                            const d = new Date();
                            d.setFullYear(d.getFullYear() - 1);
                            const dateStr = d.toISOString().split('T')[0];
                            const template = t('search_page.template_date_constraint', { date: dateStr });
                            setTempPrompt(prev => `${prev} ${template}`.trim());
                        }}
                        className="px-2 py-1 text-xs rounded border border-theme-border bg-theme-bg hover:bg-theme-surface transition-colors text-theme-text"
                    >
                        + {t('search_page.template_recent_year')}
                    </button>
                </div>
                <textarea
                value={tempPrompt}
                onChange={(e) => setTempPrompt(e.target.value)}
                className="w-full h-64 p-3 rounded-lg bg-theme-bg border border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent resize-none font-mono text-sm"
                placeholder={t('search_page.prompt_placeholder')}
                />
            </div>

            <div className="p-4 border-t border-theme-border flex justify-between items-center bg-theme-surface rounded-b-xl">
                <button
                onClick={restoreDefault}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-theme-subtext hover:text-theme-text hover:bg-theme-bg transition-colors"
                >
                <RotateCcw className="w-4 h-4" />
                {t('search_page.restore_default')}
                </button>
                <div className="flex gap-2">
                    <button
                    onClick={() => setIsPromptModalOpen(false)}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-theme-text hover:bg-theme-bg transition-colors"
                    >
                    {t('common.cancel')}
                    </button>
                    <button
                    onClick={savePrompt}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-theme-accent text-theme-bg hover:bg-theme-accent-hover transition-colors"
                    >
                    <Save className="w-4 h-4" />
                    {t('search_page.save_prompt')}
                    </button>
                </div>
            </div>
            </div>
        </div>
        )}
    </div>
  );
};
