import React, { useMemo, useState } from 'react';
import { useCollectionStore } from '../store/useCollectionStore';
import { useThemeStore } from '../store/useThemeStore';
import { AIConfigPanel } from '../components/AIConfigPanel';
import { McpPanel } from '../components/McpPanel';
import { UpdateButton } from '../components/UpdateButton';
import { ImportMediaModal } from '../components/ImportMediaModal';
import { SyncModal } from '../components/SyncModal';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { CollectionCategory, MediaType, MediaItem } from '../types/types';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { Bell, Upload, Activity, ChevronDown, ChevronUp, BarChart2, X, Wifi } from 'lucide-react';
import { useAIStore } from '../store/useAIStore';
import { toast } from 'react-toastify';
import { testAuthoritativeDomain, clearSearchCache, checkUpdates } from '../services/aiService';
import { AIIOLogEntry } from '../types/types';

const YearlyReport: React.FC<{ collection: MediaItem[] }> = ({ collection }) => {
    const { t, i18n } = useTranslation();
    const [year, setYear] = useState(new Date().getFullYear());
    const [showChart, setShowChart] = useState(false);
    
    // Generate last 5 years options
    const yearOptions = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);

    const { monthlyData, totalAdded, topMonth, topCategory } = useMemo(() => {
        // Initialize months
        const months = Array(12).fill(0).map((_, i) => {
             // Create a date object for the month name
             const d = new Date();
             d.setMonth(i);
             return { 
                name: d.toLocaleString(i18n.language, { month: 'short' }), 
                monthIndex: i,
                count: 0 
            };
        });
        
        let total = 0;
        const categoryCounts: Record<string, number> = {};

        collection.forEach(item => {
            // Use savedAt or addedAt
            let date: Date | null = null;
            if (item.savedAt) {
                date = new Date(item.savedAt);
            } else if (item.addedAt) {
                date = new Date(item.addedAt);
            }

            if (date && date.getFullYear() === year) {
                months[date.getMonth()].count++;
                total++;
                const cat = item.type;
                categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
            }
        });

        // Find top month
        const topMonthItem = months.reduce((prev, current) => (prev.count > current.count) ? prev : current);
        const topMonthName = topMonthItem.count > 0 ? topMonthItem.name : '-';
        
        // Find top category
        let topCat = '-';
        let maxCatCount = 0;
        Object.entries(categoryCounts).forEach(([cat, count]) => {
            if (count > maxCatCount) {
                maxCatCount = count;
                topCat = cat;
            }
        });

        return { monthlyData: months, totalAdded: total, topMonth: topMonthName, topCategory: topCat };
    }, [collection, year, i18n.language]);

    const chartStyles = {
        text: 'var(--text-secondary)',
        barFill: 'var(--accent-primary)',
        tooltipBg: 'var(--bg-surface)',
        tooltipBorder: 'var(--border-color)',
        tooltipText: 'var(--text-primary)',
    };

    return (
        <div className="p-4 rounded-theme shadow-theme border bg-theme-surface border-theme-border mb-8 transition-all duration-300">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <h3 className="font-bold text-theme-text whitespace-nowrap">{t('dashboard.yearly_report')}</h3>
                        <select 
                            value={year} 
                            onChange={(e) => setYear(Number(e.target.value))}
                            className="bg-theme-bg border border-theme-border rounded px-2 py-1 text-xs text-theme-text focus:outline-none focus:border-theme-accent"
                        >
                            {yearOptions.map(y => (
                                <option key={y} value={y}>{y}</option>
                            ))}
                        </select>
                    </div>
                    
                    <div className="hidden md:block h-6 w-[1px] bg-theme-border mx-2"></div>
                    
                    <div className="flex items-center gap-6 text-sm">
                        <div className="flex items-center gap-2">
                            <span className="text-theme-subtext">{t('dashboard.items_added')}:</span>
                            <span className="font-bold text-theme-text">{totalAdded}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-theme-subtext">{t('dashboard.most_active_month')}:</span>
                            <span className="font-bold text-theme-text">{topMonth}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-theme-subtext">{t('dashboard.favorite_category')}:</span>
                            <span className="font-bold text-theme-text max-w-[100px] truncate" title={topCategory === '-' ? '' : t(`media_type.${topCategory}`)}>
                                {topCategory === '-' ? '-' : t(`media_type.${topCategory}`)}
                            </span>
                        </div>
                    </div>
                </div>

                <button 
                    onClick={() => setShowChart(!showChart)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-theme-border bg-theme-bg hover:bg-theme-surface hover:text-theme-accent transition-colors ml-auto md:ml-0"
                >
                    <BarChart2 className="w-3.5 h-3.5" />
                    {showChart ? t('dashboard.hide_chart') : t('dashboard.show_chart')}
                    {showChart ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
            </div>

            {showChart && (
                <div className="mt-6 h-[250px] w-full animate-in fade-in slide-in-from-top-2">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={monthlyData}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-color)" opacity={0.5} />
                            <XAxis 
                                dataKey="name" 
                                tick={{fontSize: 11, fill: chartStyles.text}} 
                                axisLine={false}
                                tickLine={false}
                            />
                            <YAxis 
                                allowDecimals={false} 
                                tick={{fontSize: 11, fill: chartStyles.text}}
                                axisLine={false}
                                tickLine={false}
                            />
                            <Tooltip 
                                cursor={{fill: 'var(--bg-secondary)', opacity: 0.5}}
                                contentStyle={{ 
                                    backgroundColor: chartStyles.tooltipBg,
                                    borderColor: chartStyles.tooltipBorder,
                                    color: chartStyles.tooltipText,
                                    borderRadius: '8px',
                                    fontSize: '12px'
                                }}
                            />
                            <Bar dataKey="count" fill={chartStyles.barFill} radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
};

// Helper to get colors from CSS variables would be ideal, but for now we can use a map or just standard colors that work on both
// or rely on the fact that we can pass CSS variables to some SVG props.
// Recharts 2.x+ generally supports CSS variables in string props.

export const DashboardPage: React.FC = () => {
  const { getStats, collection, updateItem } = useCollectionStore();
  const { theme } = useThemeStore();
  const { t } = useTranslation();
  const stats = getStats();
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const lastSearchDurationMs = useAIStore(s => s.lastSearchDurationMs);
  const lastSearchAt = useAIStore(s => s.lastSearchAt);
  const lastSearchQuery = useAIStore(s => s.lastSearchQuery);
  const enableSearchDiagnostics = useAIStore(s => s.enableSearchDiagnostics);
  const lastSearchDiagnostics = useAIStore(s => s.lastSearchDiagnostics);
  const setAIConfig = useAIStore(s => s.setConfig);
  const logs = useAIStore(s => s.logs);
  const clearLogs = useAIStore(s => s.clearLogs);
  const [logFilter, setLogFilter] = useState<'all'|'ai'|'search'>('all');
  const filteredLogs = useMemo(() => {
    const arr = Array.isArray(logs) ? logs : [];
    return arr.filter(l => logFilter === 'all' ? true : l.channel === logFilter);
  }, [logs, logFilter]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showLogs, setShowLogs] = useState(false);
  const toggleExpand = (id: string) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success(t('dashboard.copied')); } catch {}
  };

  const pieData = [
    { name: t('dashboard.status_watched'), value: stats.watched, color: '#22c55e' },
    { name: t('dashboard.to_watch'), value: stats.toWatch, color: '#3b82f6' },
    { name: t('dashboard.status_favorites'), value: stats.favorites, color: '#ef4444' },
  ].filter(d => d.value > 0);

  // Helper for localized type names
  const getLocalizedType = (type: string) => {
    switch (type) {
      case MediaType.MOVIE: return t('search_page.filter_movies');
      case MediaType.TV_SERIES: return t('search_page.filter_tv');
      case MediaType.BOOK: return t('search_page.filter_books');
      case MediaType.COMIC: return t('search_page.filter_comics');
      case MediaType.SHORT_DRAMA: return t('search_page.filter_short_dramas');
      case MediaType.MUSIC: return t('search_page.filter_music');
      case MediaType.OTHER: return t('search_page.filter_other');
      default: return type;
    }
  };

  // Calculate types distribution
  const typeData = Object.values(collection.reduce((acc, item) => {
      const typeName = getLocalizedType(item.type);
      acc[item.type] = acc[item.type] || { name: typeName, count: 0 };
      acc[item.type].count++;
      return acc;
  }, {} as Record<string, { name: string; count: number }>));

  // Dynamic styles for charts based on CSS variables
  // We can't easily use CSS variables in JS objects for Recharts without computing them.
  // However, we can use a small mapping or just use "currentColor" where supported.
  // For simplicity and reliability, let's just use a hook to get the computed style or simple conditional.
  // Since we have specific themes, let's just use a simple lookup for chart specific colors if needed,
  // or use CSS variables directly in string props which usually works for SVG attributes.
  
  const chartStyles = {
    text: 'var(--text-secondary)',
    grid: 'var(--border-color)',
    tooltipBg: 'var(--bg-surface)',
    tooltipBorder: 'var(--border-color)',
    tooltipText: 'var(--text-primary)',
    barFill: 'var(--accent-primary)',
    pieStroke: 'var(--bg-surface)'
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold text-theme-accent">{t('dashboard.title')}</h1>
        <div className="flex items-center gap-2">
            <button
               onClick={async () => {
                   if (isCheckingUpdates) return;
                   const ongoing = collection.filter(item => item.isOngoing && item.notificationEnabled !== false);
                   if (ongoing.length === 0) {
                       toast.info(t('dashboard.no_ongoing_items'));
                       return;
                   }
                   setIsCheckingUpdates(true);
                   try {
                       toast.info(t('dashboard.checking_updates'));
                       const now = Date.now();
                       const updates = await checkUpdates(ongoing);
                       let count = 0;
                       updates.forEach(u => {
                           const original = ongoing.find(i => i.id === u.id);
                           if (!original) return;
                           const changed = u.latestUpdateInfo !== original.latestUpdateInfo;
                           updateItem(u.id, {
                               latestUpdateInfo: u.latestUpdateInfo,
                               isOngoing: u.isOngoing,
                               lastCheckedAt: now,
                               hasNewUpdate: changed ? true : original.hasNewUpdate
                           });
                           if (changed) count++;
                       });
                       if (count > 0) {
                           toast.success(t('dashboard.updates_found', { count }));
                       } else {
                           toast.info(t('dashboard.no_new_updates'));
                       }
                   } catch {
                       toast.error(t('dashboard.update_check_failed'));
                   } finally {
                       setIsCheckingUpdates(false);
                   }
               }}
               className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50 focus:outline-none focus:ring-2 focus:ring-theme-accent"
               title={t('dashboard.check_updates')}
            >
               <Bell className={clsx("w-4 h-4", isCheckingUpdates && "animate-pulse")} />
               <span className="hidden sm:inline">{t('dashboard.check_updates')}</span>
            </button>
            <button
               onClick={async () => {
                   const success = await clearSearchCache();
                   if (success) {
                       toast.success(t('dashboard.cache_cleared'));
                   } else {
                       toast.error(t('dashboard.cache_clear_failed'));
                   }
               }}
               className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50 focus:outline-none focus:ring-2 focus:ring-theme-accent"
               title={t('dashboard.clear_cache')}
             >
               <Activity className="w-4 h-4" />
               <span className="hidden sm:inline">{t('dashboard.clear_cache')}</span>
             </button>
            <button
              onClick={() => setIsSyncOpen(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50 focus:outline-none focus:ring-2 focus:ring-theme-accent"
              title={t('dashboard.sync')}
            >
              <Wifi className="w-4 h-4" />
              <span className="hidden sm:inline">{t('dashboard.sync')}</span>
            </button>
            <UpdateButton />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="p-6 rounded-theme shadow-theme border bg-theme-surface border-theme-border">
            <h3 className="text-sm font-medium text-theme-subtext">{t('dashboard.total_collection')}</h3>
            <p className="text-4xl font-bold mt-2 text-theme-text">{stats.total}</p>
        </div>
        <div className="p-6 rounded-theme shadow-theme border bg-theme-surface border-theme-border">
            <h3 className="text-sm font-medium text-theme-subtext">{t('dashboard.completed')}</h3>
            <p className="text-4xl font-bold text-green-600 mt-2">{stats.watched}</p>
        </div>
        <div className="p-6 rounded-theme shadow-theme border bg-theme-surface border-theme-border">
            <h3 className="text-sm font-medium text-theme-subtext">{t('dashboard.to_watch')}</h3>
            <p className="text-4xl font-bold text-blue-600 mt-2">{stats.toWatch}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="p-3 rounded-theme shadow-sm border bg-theme-surface border-theme-border flex flex-col">
          <div className="flex items-center justify-between mb-2">
             <h3 className="text-sm font-medium text-theme-subtext">{t('dashboard.last_search')}</h3>
             <div className="flex items-center gap-2">
                <label className="relative inline-flex items-center cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={enableSearchDiagnostics}
                    onChange={(e) =>
                      setAIConfig({
                        enableSearchDiagnostics: e.target.checked,
                        ...(!e.target.checked ? { lastSearchDiagnostics: null } : {})
                      })
                    }
                    className="sr-only peer"
                    aria-label={t('dashboard.search_diag_toggle')}
                  />
                  <div className="w-10 h-5 bg-theme-border border border-theme-subtext/20 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-theme-accent rounded-full peer after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border after:border-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full peer-checked:bg-theme-accent/70" />
                  <span className="ms-2 text-[11px] font-medium text-theme-subtext">
                    {enableSearchDiagnostics ? t('dashboard.search_diag_on') : t('dashboard.search_diag_off')}
                  </span>
                </label>
                <span className="text-xs text-theme-subtext">{lastSearchAt || ''}</span>
             </div>
          </div>
          {enableSearchDiagnostics && (lastSearchDurationMs != null ? (
            <div className="flex items-center justify-between text-sm text-theme-text bg-theme-bg/50 px-3 py-2 rounded-md border border-theme-border/50">
              <span className="truncate font-medium max-w-[200px]" title={lastSearchQuery || ''}>{lastSearchQuery || '-'}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-theme-accent/10 text-theme-accent">{lastSearchDurationMs}ms</span>
            </div>
          ) : (
            <p className="text-sm text-theme-subtext text-center py-2">{t('dashboard.no_recent_search')}</p>
          ))}

          {enableSearchDiagnostics && lastSearchDiagnostics && (
            <div className="mt-2 text-xs text-theme-subtext bg-theme-bg/30 border border-theme-border/50 rounded-md p-2 space-y-2">
              {Array.isArray(lastSearchDiagnostics.providers) && lastSearchDiagnostics.providers.length > 0 && (
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0">{t('dashboard.search_diag_providers')}</span>
                  <span className="text-theme-text text-right break-words">
                    {lastSearchDiagnostics.providers
                      .filter(p => p && !['parallel', 'cache'].includes(p))
                      .map(p => {
                        const k = String(p).toLowerCase();
                        if (k === 'tmdb') return 'TMDB';
                        if (k === 'bangumi') return 'Bangumi';
                        if (k === 'duckduckgo') return 'DuckDuckGo';
                        if (k === 'serper') return 'Serper';
                        if (k === 'yandex') return 'Yandex';
                        if (k === 'google') return 'Google';
                        if (k === 'plugin') return t('dashboard.search_diag_plugin');
                        return p;
                      })
                      .join(' · ')}
                  </span>
                </div>
              )}

              {Array.isArray(lastSearchDiagnostics.quota) && lastSearchDiagnostics.quota.length > 0 && (
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0">{t('dashboard.search_diag_quota')}</span>
                  <span className="text-theme-text text-right break-words">
                    {lastSearchDiagnostics.quota.map((q, idx) => {
                      const prov = String(q?.provider || '');
                      const unit = q?.unit === 'token' ? t('dashboard.search_diag_tokens') : t('dashboard.search_diag_requests');
                      const amount = typeof q?.amount === 'number' ? q.amount : 0;
                      return `${prov}:${amount} ${unit}${idx === lastSearchDiagnostics.quota.length - 1 ? '' : ' · '}`;
                    })}
                  </span>
                </div>
              )}

              {Array.isArray(lastSearchDiagnostics.steps) && lastSearchDiagnostics.steps.length > 0 && (
                <div>
                  <div className="flex items-center justify-between">
                    <span className="shrink-0">{t('dashboard.search_diag_steps')}</span>
                    <span className="text-[10px] text-theme-subtext">{lastSearchDiagnostics.totalDurationMs}ms</span>
                  </div>
                  <div className="mt-1 max-h-[140px] overflow-auto custom-scrollbar space-y-1">
                    {lastSearchDiagnostics.steps.slice(0, 12).map((s, idx) => (
                      <div key={`${s.name}-${idx}`} className="flex items-center justify-between gap-2">
                        <span className="truncate">{s.name}</span>
                        <span className="shrink-0 text-theme-text">{s.durationMs}ms</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="p-3 rounded-theme shadow-sm border bg-theme-surface border-theme-border">
          <h3 className="text-sm font-medium text-theme-subtext mb-2">{t('dashboard.authoritative_domains')}</h3>
          <AuthoritativeDomainsPanel />
        </div>
      </div>

      <div className="mb-8">
        <YearlyReport collection={collection} />
      </div>

      {/* AI Configuration Panel */}
      <div className="mb-6">
        <AIConfigPanel />
      </div>

      {/* MCP Server (external AI agents) */}
      <div className="mb-6">
        <McpPanel />
      </div>

      <div className="mb-8 transition-all duration-300">
        {!showLogs ? (
            <button 
                onClick={() => setShowLogs(true)}
                className="w-full py-3 border-2 border-dashed border-theme-border rounded-theme text-theme-subtext hover:border-theme-accent hover:text-theme-accent hover:bg-theme-surface transition-all flex items-center justify-center gap-2 group"
            >
                <Activity className="w-4 h-4 group-hover:scale-110 transition-transform" />
                <span className="font-medium">{t('dashboard.show_logs')}</span>
            </button>
        ) : (
            <div className="p-6 rounded-theme shadow-theme border bg-theme-surface border-theme-border relative animate-in fade-in slide-in-from-top-4">
                <button 
                    onClick={() => setShowLogs(false)} 
                    className="absolute top-4 right-4 p-1 rounded-md text-theme-subtext hover:bg-theme-bg hover:text-theme-text transition-colors"
                    title={t('common.close', { defaultValue: '关闭' })}
                >
                    <X className="w-5 h-5" />
                </button>

                <div className="flex items-center justify-between mb-4 pr-8">
                    <h3 className="text-lg font-bold text-theme-text flex items-center gap-2">
                        <Activity className="w-5 h-5 text-theme-accent" />
                        {t('dashboard.io_logs')}
                    </h3>
                    <div className="flex items-center gap-2">
                        <div className="flex gap-1">
                        <button className={clsx('px-2 py-1 text-xs rounded-md border', logFilter==='all'?'bg-theme-accent text-theme-bg border-theme-accent':'bg-theme-surface text-theme-subtext border-theme-border hover:text-theme-text')} onClick={()=>setLogFilter('all')}>{t('dashboard.filter_all')}</button>
                        <button className={clsx('px-2 py-1 text-xs rounded-md border', logFilter==='ai'?'bg-theme-accent text-theme-bg border-theme-accent':'bg-theme-surface text-theme-subtext border-theme-border hover:text-theme-text')} onClick={()=>setLogFilter('ai')}>{t('dashboard.filter_ai')}</button>
                        <button className={clsx('px-2 py-1 text-xs rounded-md border', logFilter==='search'?'bg-theme-accent text-theme-bg border-theme-accent':'bg-theme-surface text-theme-subtext border-theme-border hover:text-theme-text')} onClick={()=>setLogFilter('search')}>{t('dashboard.filter_search')}</button>
                        </div>
                        <button className="px-2 py-1 text-xs rounded-md border-2 border-theme-accent bg-theme-accent text-theme-bg hover:bg-theme-accent-hover transition-colors" onClick={clearLogs}>{t('dashboard.clear_logs')}</button>
                    </div>
                </div>
                {filteredLogs.length === 0 ? (
                <div className="text-sm text-theme-subtext py-8 text-center bg-theme-bg/30 rounded-lg border border-theme-border/30 border-dashed">{t('dashboard.no_logs')}</div>
                ) : (
                <div className="space-y-3 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                    {filteredLogs.map((l: AIIOLogEntry) => {
                    const ts = new Date(l.ts || Date.now()).toLocaleString();
                    const head = `${ts} | ${l.channel === 'ai' ? t('dashboard.filter_ai') : t('dashboard.filter_search')} | ${l.provider || '-'}${l.searchType ? ' · ' + l.searchType : ''}${l.model ? ' · ' + l.model : ''}`;
                    const reqStr = typeof l.request === 'string' ? l.request : JSON.stringify(l.request ?? {}, null, 2);
                    const resStr = typeof l.response === 'string' ? l.response : JSON.stringify(l.response ?? {}, null, 2);
                    const isExp = !!expanded[l.id];
                    return (
                        <div key={l.id} className="rounded-md border bg-theme-bg/50 border-theme-border/50 hover:border-theme-border transition-colors">
                        <div className="flex items-center justify-between px-3 py-2 cursor-pointer" onClick={()=>toggleExpand(l.id)}>
                            <div className="text-xs font-mono text-theme-subtext truncate flex-1 mr-4" title={head}>{head}</div>
                            <div className="flex gap-2 flex-shrink-0">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-theme-surface text-theme-subtext border border-theme-border/50">{(l.durationMs ?? 0) + 'ms'}</span>
                            <button className={clsx('text-[11px] px-2 py-0.5 rounded border', 'bg-theme-surface text-theme-accent hover:bg-theme-accent hover:text-theme-bg transition-colors')} onClick={(e) => { e.stopPropagation(); toggleExpand(l.id); }}>{isExp ? t('dashboard.collapse') : t('dashboard.expand')}</button>
                            </div>
                        </div>
                        {isExp && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 px-3 pb-3 animate-in fade-in slide-in-from-top-1">
                                <div className="bg-theme-surface/50 border border-theme-border/50 rounded p-2">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs text-theme-subtext">Request</span>
                                    <button className="text-[11px] px-2 py-0.5 rounded border bg-theme-surface text-theme-accent hover:bg-theme-accent hover:text-theme-bg transition-colors" onClick={()=>copyText(reqStr)}>{t('dashboard.copy')}</button>
                                </div>
                                <pre className="text-[11px] whitespace-pre-wrap break-all max-h-[300px] overflow-auto custom-scrollbar">{reqStr}</pre>
                                </div>
                                <div className="bg-theme-surface/50 border border-theme-border/50 rounded p-2">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs text-theme-subtext">Response</span>
                                    <button className="text-[11px] px-2 py-0.5 rounded border bg-theme-surface text-theme-accent hover:bg-theme-accent hover:text-theme-bg transition-colors" onClick={()=>copyText(resStr)}>{t('dashboard.copy')}</button>
                                </div>
                                <pre className="text-[11px] whitespace-pre-wrap break-all max-h-[300px] overflow-auto custom-scrollbar">{resStr}</pre>
                                </div>
                            </div>
                        )}
                        </div>
                    );
                    })}
                </div>
                )}
            </div>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Status Distribution */}
        <div className="p-6 rounded-theme shadow-theme border h-[400px] bg-theme-surface border-theme-border min-w-0">
            <h3 className="text-lg font-bold mb-6 text-theme-text">{t('dashboard.collection_status')}</h3>
            {pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height={360}>
                    <PieChart>
                        <Pie
                            data={pieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={60}
                            outerRadius={100}
                            paddingAngle={5}
                            dataKey="value"
                            stroke={chartStyles.pieStroke}
                        >
                            {pieData.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                        </Pie>
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: chartStyles.tooltipBg,
                            borderColor: chartStyles.tooltipBorder,
                            color: chartStyles.tooltipText
                          }}
                          itemStyle={{ color: chartStyles.tooltipText }}
                        />
                        <Legend verticalAlign="bottom" height={36}/>
                    </PieChart>
                </ResponsiveContainer>
            ) : (
                <div className="h-full flex items-center justify-center text-theme-subtext">
                    {t('dashboard.no_data')}
                </div>
            )}
        </div>

        {/* Type Distribution */}
        <div className="p-6 rounded-theme shadow-theme border h-[400px] bg-theme-surface border-theme-border min-w-0">
             <h3 className="text-lg font-bold mb-6 text-theme-text">{t('dashboard.media_types')}</h3>
             {typeData.length > 0 ? (
                 <ResponsiveContainer width="100%" height={360}>
                    <BarChart data={typeData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartStyles.grid} />
                        <XAxis 
                          dataKey="name" 
                          tick={{fontSize: 12, fill: chartStyles.text}} 
                          interval={0} 
                          angle={-30} 
                          textAnchor="end" 
                          height={60}
                        />
                        <YAxis 
                          allowDecimals={false} 
                          tick={{fill: chartStyles.text}}
                        />
                        <Tooltip 
                          cursor={{fill: 'var(--bg-secondary)'}}
                          contentStyle={{ 
                            backgroundColor: chartStyles.tooltipBg,
                            borderColor: chartStyles.tooltipBorder,
                            color: chartStyles.tooltipText
                          }}
                          itemStyle={{ color: chartStyles.tooltipText }}
                        />
                        <Bar dataKey="count" fill={chartStyles.barFill} radius={[4, 4, 0, 0]} />
                    </BarChart>
                 </ResponsiveContainer>
             ) : (
                <div className="h-full flex items-center justify-center text-theme-subtext">
                    {t('dashboard.no_data')}
                </div>
             )}
        </div>
      </div>
      {isImportModalOpen && <ImportMediaModal onClose={() => setIsImportModalOpen(false)} />}
      <SyncModal isOpen={isSyncOpen} onClose={() => setIsSyncOpen(false)} />
    </div>
  );
};

const AuthoritativeDomainsPanel: React.FC = () => {
  const { authoritativeDomains, addDomain, removeDomain } = useAIStore();
  const { t } = useTranslation();
  const [active, setActive] = useState<'movie_tv'|'book'|'comic'|'music'|'poster'>('movie_tv');
  const [newDomain, setNewDomain] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const list = authoritativeDomains[active] || [];

  const handleAdd = () => {
    const d = newDomain.trim();
    if (!d) return;
    addDomain(active, d);
    setNewDomain('');
  };

  const handleTest = async (domain: string) => {
    setTesting(domain);
    try {
      const r = await testAuthoritativeDomain(domain);
      if (r.ok) {
        toast.success(t('dashboard.domain_connected', { domain, count: r.count }));
      } else {
        toast.error(t('dashboard.domain_failed', { domain, error: r.error ? '(' + r.error + ')' : '' }));
      }
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-2 mt-1">
      <div className="flex gap-2 flex-wrap">
        <button className={clsx('px-2 py-1 text-xs rounded-md border-2 transition-colors', active==='movie_tv'?'bg-theme-accent text-theme-bg border-theme-accent':'bg-theme-surface text-theme-subtext border-theme-border hover:text-theme-text')} onClick={()=>setActive('movie_tv')}>{t('search_page.filter_movies')}/{t('search_page.filter_tv')}</button>
        <button className={clsx('px-2 py-1 text-xs rounded-md border-2 transition-colors', active==='book'?'bg-theme-accent text-theme-bg border-theme-accent':'bg-theme-surface text-theme-subtext border-theme-border hover:text-theme-text')} onClick={()=>setActive('book')}>{t('search_page.filter_books')}</button>
        <button className={clsx('px-2 py-1 text-xs rounded-md border-2 transition-colors', active==='comic'?'bg-theme-accent text-theme-bg border-theme-accent':'bg-theme-surface text-theme-subtext border-theme-border hover:text-theme-text')} onClick={()=>setActive('comic')}>{t('search_page.filter_comics')}</button>
        <button className={clsx('px-2 py-1 text-xs rounded-md border-2 transition-colors', active==='music'?'bg-theme-accent text-theme-bg border-theme-accent':'bg-theme-surface text-theme-subtext border-theme-border hover:text-theme-text')} onClick={()=>setActive('music')}>{t('search_page.filter_music')}</button>
        <button className={clsx('px-2 py-1 text-xs rounded-md border-2 transition-colors', active==='poster'?'bg-theme-accent text-theme-bg border-theme-accent':'bg-theme-surface text-theme-subtext border-theme-border hover:text-theme-text')} onClick={()=>setActive('poster')}>{t('dashboard.poster_sources')}</button>
      </div>
      
      <div className="flex gap-2">
        <input 
            className="flex-1 px-2 py-1 text-xs rounded-md border bg-theme-bg border-theme-border text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent" 
            placeholder={t('dashboard.domain_placeholder')} 
            value={newDomain} 
            onChange={e=>setNewDomain(e.target.value)} 
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <button className="px-2 py-1 text-xs rounded-md border-2 border-theme-accent bg-theme-accent text-theme-bg hover:bg-theme-accent-hover transition-colors" onClick={handleAdd}>{t('dashboard.add')}</button>
      </div>

      <div className="space-y-1 max-h-[150px] overflow-y-auto pr-1 custom-scrollbar">
        {list.map(d => (
          <div key={d} className="flex items-center justify-between px-2 py-1 rounded-md border bg-theme-bg/50 border-theme-border/50 hover:border-theme-border transition-colors group">
            <span className="text-xs text-theme-text font-mono truncate max-w-[150px]" title={d}>{d}</span>
            <div className="flex gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
              <button className={clsx('px-2 py-0.5 text-[10px] rounded border', 'bg-theme-surface text-theme-subtext hover:text-theme-text hover:border-theme-subtext transition-colors')} onClick={()=>removeDomain(active, d)}>{t('dashboard.delete')}</button>
              <button className={clsx('px-2 py-0.5 text-[10px] rounded border transition-colors', testing===d?'bg-theme-surface text-theme-subtext cursor-wait':'bg-theme-surface text-theme-accent border-theme-accent/30 hover:bg-theme-accent hover:text-theme-bg')} onClick={()=>handleTest(d)}>{testing===d?'...':t('dashboard.test')}</button>
            </div>
          </div>
        ))}
        {list.length===0 && (
          <div className="text-xs text-theme-subtext py-2 text-center border border-dashed border-theme-border/50 rounded-md">{t('dashboard.no_domains')}</div>
        )}
      </div>
    </div>
  );
};
