import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Star, Clock, Calendar, Heart, Check, Bookmark, MoreVertical, Info, Bell, BellOff, RefreshCw, Edit, Trash2, User, Users, ChevronsUp, Tags, Layers, FolderPlus, ChevronDown, ChevronUp } from 'lucide-react';
import { MediaItem, CollectionCategory, MediaType } from '../types/types';
import clsx from 'clsx';
import { useThemeStore } from '../store/useThemeStore';
import { useCollectionStore } from '../store/useCollectionStore';
import { EditMediaModal } from './EditMediaModal';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { toast } from 'react-toastify';
import { checkUpdates, repairMediaItem, FALLBACK_POSTER, isPlaceholderPosterUrl } from '../services/aiService';

// Episode-grid helpers. The app's progress convention is "the last number in
// the string is the episode counter" for flat progress ("E30", "第 680 话"),
// while season-aware progress uses "S{n}E{m}".
const lastNumber = (str?: string): number | null => {
    if (!str) return null;
    const match = str.match(/(\d+)(?!.*\d)/);
    return match ? parseInt(match[1], 10) : null;
};

const withLastNumber = (str: string, n: number): string => {
    const match = str.match(/(\d+)(?!.*\d)/);
    if (!match) return `E${n}`;
    return str.substring(0, match.index!) + String(n).padStart(match[0].length, '0') + str.substring(match.index! + match[0].length);
};

interface MediaCardProps {
  item: MediaItem;
  onAction?: (item: MediaItem, category: CollectionCategory) => void;
  showActions?: boolean;
  index?: number;
  layoutId?: string;
  onClick?: () => void;
  className?: string;
  variant?: 'search' | 'collection';
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onStartCollection?: () => void;
}

export const MediaCard: React.FC<MediaCardProps> = ({ 
  item, 
  onAction, 
  showActions = true, 
  index = 0, 
  layoutId, 
  onClick, 
  className,
  variant = 'search',
  isSelectionMode,
  isSelected,
  onStartCollection
}) => {
  const [isFlipped, setIsFlipped] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { t } = useTranslation();
  const [imgLoading, setImgLoading] = useState(true);
  const [imgFailed, setImgFailed] = useState(false);
  const [isBackRefreshing, setIsBackRefreshing] = useState(false);
  // Episode list defaults to collapsed; only actively-following works start
  // expanded.
  const [gridExpanded, setGridExpanded] = useState(item.isOngoing);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.matchMedia('(max-width: 768px)').matches);
    checkMobile();
    const resizeObserver = new ResizeObserver(() => checkMobile());
    resizeObserver.observe(document.body);
    return () => resizeObserver.disconnect();
  }, []);
  
  const { theme } = useThemeStore();
  const { updateItem, removeFromCollection, moveCategory, bumpToFront } = useCollectionStore();

  const getCategoryLabel = (cat: CollectionCategory) => {
    switch (cat) {
      case CollectionCategory.TO_WATCH:
        return t('dashboard.to_watch');
      case CollectionCategory.WATCHED:
        return t('dashboard.status_watched');
      case CollectionCategory.FAVORITES:
        return t('dashboard.status_favorites');
      default:
        return String(cat);
    }
  };

  const getNextCategory = (cat?: CollectionCategory) => {
    const order: CollectionCategory[] = [
      CollectionCategory.TO_WATCH,
      CollectionCategory.WATCHED,
      CollectionCategory.FAVORITES
    ];
    const current = cat && order.includes(cat) ? cat : CollectionCategory.TO_WATCH;
    const idx = order.indexOf(current);
    return order[(idx + 1) % order.length];
  };

  const normalizeImgSrc = (value?: string): string | undefined => {
    let s = String(value ?? '').trim();
    if (!s) return undefined;
    s = s
      .replace(/^[<("'“‘\[]+/g, '')
      .replace(/[>"'”’\].,;:)]+$/g, '')
      .trim();
    if (!s) return undefined;
    const lower = s.toLowerCase();
    if (lower === 'n/a' || lower === 'na' || lower === 'null' || lower === 'undefined') return undefined;
    if (lower.includes('m.media-amazon.com/')) return undefined;
    if (lower.includes('i.ebayimg.com/') || lower.includes('ebayimg.com/')) return undefined;
    if (lower.startsWith('data:') || lower.startsWith('blob:')) return s;
    if (lower.startsWith('http://') || lower.startsWith('https://')) return s;
    if (s.startsWith('//')) return `https:${s}`;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return `https://${s}`;
    return s;
  };

  const getCategoryIcon = (category?: CollectionCategory) => {
    switch (category) {
      case CollectionCategory.FAVORITES: return <Heart className="w-4 h-4 fill-current text-red-500" />;
      case CollectionCategory.WATCHED: return <Check className="w-4 h-4 text-green-500" />;
      case CollectionCategory.TO_WATCH: return <Bookmark className="w-4 h-4 text-blue-500" />;
      default: return null;
    }
  };

  const fallbackPoster = FALLBACK_POSTER;
  const [imgSrc, setImgSrc] = useState(normalizeImgSrc(item.customPosterUrl || item.posterUrl) || fallbackPoster);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setImgSrc(normalizeImgSrc(item.customPosterUrl || item.posterUrl) || fallbackPoster);
    setImgLoading(true);
    setImgFailed(false);
  }, [item.customPosterUrl, item.posterUrl]);

  // A cached image can be fully loaded before React attaches onLoad, which
  // would leave the poster hidden behind the loading state forever.
  useEffect(() => {
    const el = imgRef.current;
    if (!el?.complete) return;
    if (el.naturalWidth === 0) handleImageError();
    else setImgLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgSrc]);

  const handleImageError = () => {
      setImgSrc(FALLBACK_POSTER);
      setImgFailed(true);
      setImgLoading(false);
      // A poster that fails to load at runtime (expired CDN link, dead host,
      // new hotlink protection) still looks intact to the repair logic, which
      // only recognizes placeholders. Record the failure once so the repair
      // sweeps and the card's refresh button re-fetch it; onLoad clears the
      // flag again as soon as an image renders.
      if (item.posterUrl && !item.customPosterUrl && !isPlaceholderPosterUrl(item.posterUrl) && !item.posterFailedAt) {
          updateItem(item.id, { posterFailedAt: Date.now() });
      }
  };

  const handleImageLoad = () => {
      setImgLoading(false);
      // The fallback SVG also fires onLoad right after an error switched to it
      // — only a real poster rendering clears the failure flag.
      if (imgSrc !== FALLBACK_POSTER && item.posterFailedAt) {
          updateItem(item.id, { posterFailedAt: undefined });
      }
  };

  const norm = (v?: string) => (v || '').trim();
  const isUnknownText = (v?: string) => {
      const s = norm(v);
      if (!s) return true;
      const low = s.toLowerCase();
      return low === 'unknown' || s === '未知' || low === 'n/a' || low === 'na' || s === '-';
  };
  const notificationEnabled = item.notificationEnabled !== false;

  // Episode grid data. Structured seasons (from TMDB checks) render one block
  // per season; otherwise a flat grid derives from totalEpisodes or a "全N集"
  // style latestUpdateInfo, falling back to the released-to count (two states:
  // watched vs released). Long runs are windowed around the current progress.
  const isEpisodicItem = item.type === MediaType.TV_SERIES || item.type === MediaType.COMIC || item.type === MediaType.BOOK || item.type === MediaType.SHORT_DRAMA;
  const epUnitKey = item.type === MediaType.COMIC ? 'media_card.unit_hua' : item.type === MediaType.BOOK ? 'media_card.unit_zhang' : 'media_card.unit_ji';
  const EP_GRID_CAP = 60;

  const progressMatch = /S(\d+)\s*E(\d+)/i.exec(item.userProgress || '');
  const progressSeason = progressMatch ? parseInt(progressMatch[1], 10) : null;
  const progressEp = progressMatch ? parseInt(progressMatch[2], 10) : null;
  const flatWatched = lastNumber(item.userProgress);

  interface SeasonBlock {
    season: number; // 0 = flat (no season info)
    total: number;
    released: number;
    watched: number;
    start: number;
    end: number;
    windowed: boolean;
    list: number[];
  }

  const makeBlock = (season: number, total: number, released: number, watched: number): SeasonBlock => {
    const windowed = total > EP_GRID_CAP;
    const start = windowed ? Math.max(1, Math.min(watched - 30, total - EP_GRID_CAP + 1)) : 1;
    const end = windowed ? start + EP_GRID_CAP - 1 : total;
    return {
      season, total, released, watched, windowed, start, end,
      list: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i)
    };
  };

  const epCaptionFor = (total: number, released: number) =>
      released < total
          ? t('media_card.episodes_partial', { released, total, unit: t(epUnitKey) })
          : t('media_card.episodes_total', { count: total, unit: t(epUnitKey) });

  const seasonBlocks: SeasonBlock[] | null = item.seasons && item.seasons.length > 0
      ? item.seasons.map(info => {
          const released = Math.min(info.released ?? info.total, info.total);
          let watched = 0;
          if (progressSeason != null && progressEp != null) {
              // "S{n}E{m}" implies linear progress: everything before the
              // marked season is finished.
              if (info.season < progressSeason) watched = info.total;
              else if (info.season === progressSeason) watched = Math.min(progressEp, info.total);
          } else if (info.season === item.seasons![0].season) {
              // Flat progress ("E8") predates multi-season knowledge: markWatched
              // writes season-prefixed progress once several seasons are known,
              // so an un-prefixed count belongs to the first season. Attributing
              // it to the newest season made the watched count jump around every
              // time an update check discovered a new season.
              watched = Math.min(flatWatched ?? 0, info.total);
          }
          return makeBlock(info.season, info.total, released, watched);
      })
      : null;

  const epReleased = lastNumber(item.latestUpdateInfo);
  const epTotalMatch = /全\s*(\d+)/.exec(item.latestUpdateInfo || '');
  const epTotal = item.totalEpisodes ?? (epTotalMatch ? parseInt(epTotalMatch[1], 10) : null);
  const flatMax = epTotal ?? epReleased ?? 0;
  const flatReleased = epTotal != null ? Math.min(epReleased ?? epTotal, epTotal) : flatMax;
  const flatBlock: SeasonBlock | null = !seasonBlocks && flatMax > 0
      ? makeBlock(0, flatMax, flatReleased, Math.min(flatWatched ?? 0, flatMax))
      : null;
  const flatCaption = epTotal != null && epReleased != null && epReleased < epTotal
      ? t('media_card.episodes_partial', { released: epReleased, total: epTotal, unit: t(epUnitKey) })
      : epTotal != null
          ? t('media_card.episodes_total', { count: epTotal, unit: t(epUnitKey) })
          : epReleased != null
              ? t('media_card.episodes_ongoing', { count: epReleased, unit: t(epUnitKey) })
              : '';

  const blocks: SeasonBlock[] = seasonBlocks ?? (flatBlock ? [flatBlock] : []);
  const hasGrid = blocks.length > 0;
  const gridSummary = seasonBlocks
      ? `${t('media_card.episodes_seasons', { count: seasonBlocks.length })} · ${epCaptionFor(seasonBlocks[seasonBlocks.length - 1].total, seasonBlocks[seasonBlocks.length - 1].released)}`
      : flatCaption;

  const markWatched = (block: SeasonBlock, n: number) => {
      const newProgress = seasonBlocks
          ? (item.seasons!.length > 1 ? `S${block.season}E${n}` : `E${n}`)
          : (item.userProgress ? withLastNumber(item.userProgress, n) : `E${n}`);
      updateItem(item.id, {
          userProgress: newProgress,
          ...(n >= block.released && block.released > 0 ? { hasNewUpdate: false } : {})
      });
  };

  const handleBackRefresh = async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isBackRefreshing) return;

      setIsBackRefreshing(true);
      try {
          const now = Date.now();

          const isPosterMissing = isPlaceholderPosterUrl(item.posterUrl) || !!item.posterFailedAt;
          const isInfoMissing =
              isPosterMissing ||
              isUnknownText(item.releaseDate) ||
              isUnknownText(item.directorOrAuthor) ||
              isUnknownText(item.description) ||
              (!item.cast || item.cast.length === 0);

          let repaired = false;
          let updated = false;

          if (isInfoMissing) {
              const patch = await repairMediaItem(item);
              if (patch) {
                  updateItem(item.id, patch);
                  repaired = true;
              }
          }

          const isEpisodic =
              item.type === MediaType.TV_SERIES ||
              item.type === MediaType.COMIC ||
              item.type === MediaType.BOOK ||
              item.type === MediaType.SHORT_DRAMA;

          // Always check updates for episodic content on manual refresh, or if ongoing
          const shouldCheckUpdates = item.isOngoing || isEpisodic;

          if (shouldCheckUpdates) {
              const updates = await checkUpdates([item]);
              const update = updates.find(u => u.id === item.id);
              if (update) {
                  const changed = update.latestUpdateInfo !== item.latestUpdateInfo;
                  updateItem(item.id, {
                      latestUpdateInfo: update.latestUpdateInfo,
                      isOngoing: update.isOngoing,
                      ...(update.totalEpisodes ? { totalEpisodes: update.totalEpisodes } : {}),
                      ...(update.seasons ? { seasons: update.seasons } : {}),
                      ...(update.tmdbId ? { tmdbId: update.tmdbId, tmdbMediaType: update.tmdbMediaType } : {}),
                      lastCheckedAt: now,
                      hasNewUpdate: changed ? true : item.hasNewUpdate
                  });
                  // New content floats the work to the front (not a pin).
                  if (changed && update.isOngoing) {
                      bumpToFront(item.id);
                  }
                  updated = true;
              } else {
                  updateItem(item.id, { lastCheckedAt: now });
              }
          }

          if (repaired || updated) {
              toast.success(t('media_card.refresh_success'));
          } else {
              toast.info(t('media_card.refresh_no_changes'));
          }
      } catch (err) {
          console.error(err);
          toast.error(t('media_card.refresh_error'));
      } finally {
          setIsBackRefreshing(false);
      }
  };

  return (
    <>
      <motion.div
        layoutId={layoutId}
        initial={layoutId ? undefined : { opacity: 0, y: 20 }}
        animate={layoutId ? undefined : { opacity: 1, y: 0 }}
        transition={{ delay: layoutId ? 0 : index * 0.1, duration: 0.5 }}
        className={clsx(
          "group relative w-full h-full perspective-1000",
          // Elevate above grid siblings while flipped/scaling, but stay below
          // the sticky navbar (z-50) so the flipped card can never cover the
          // top button bars.
          "md:hover:z-20",
          className
        )}
        onMouseEnter={() => !isMobile && !isEditModalOpen && setIsFlipped(true)}
        onMouseLeave={() => !isMobile && !isEditModalOpen && setIsFlipped(false)}
        onClick={() => {
            if (item.hasNewUpdate) {
                updateItem(item.id, { hasNewUpdate: false });
            }
            onClick?.();
        }}
      >
        <motion.div
          className={clsx(
            "relative w-full aspect-[1/1.48] transition-all duration-300 ease-out transform-style-3d cursor-pointer shadow-theme rounded-theme",
            // Hardware acceleration hints
            "will-change-transform backface-visibility-hidden",
            isFlipped ? "rotate-y-180" : "",
            // Depth only — no scale on hover: scaling plus the 3D flip makes
            // the card project past its grid cell onto the bars above.
            !isMobile && !isEditModalOpen && "md:group-hover:shadow-2xl",
            // Cyberpunk specific glow
            theme === 'cyberpunk' && "border border-transparent hover:border-theme-accent hover:shadow-[0_0_20px_var(--accent-primary)]"
          )}
        >
          {/* Front Side */}
          <div className="absolute inset-0 backface-hidden rounded-theme overflow-hidden border-2 border-theme-border bg-theme-surface">
            <div className="relative h-full w-full">
              {item.isCollection && (
                  <div className="absolute top-2 left-2 z-20 bg-black/60 backdrop-blur-md p-1.5 rounded-md text-white border border-white/10 shadow-lg">
                      <Layers className="w-4 h-4" />
                  </div>
              )}

              {item.isPinned && (
                  <div className={clsx(
                      "absolute top-2 z-20 bg-theme-accent/80 backdrop-blur-md p-1.5 rounded-md text-theme-bg border border-theme-accent/40 shadow-lg",
                      item.isCollection ? "left-10" : "left-2"
                  )}>
                      <ChevronsUp className="w-4 h-4" />
                  </div>
              )}

              {/* Selection Overlay */}
              {isSelectionMode && (
                  <div className={clsx(
                      "absolute inset-0 z-30 flex items-center justify-center transition-all duration-200",
                      isSelected ? "bg-theme-accent/20 backdrop-blur-[2px]" : "bg-black/40 hover:bg-black/20"
                  )}>
                       <div className={clsx(
                           "w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all duration-200 shadow-xl",
                           isSelected ? "bg-theme-accent border-theme-accent scale-110" : "border-white/50 bg-black/20 scale-100 hover:scale-105"
                       )}>
                           {isSelected && <Check className="w-6 h-6 text-white" />}
                       </div>
                  </div>
              )}

              {/* Mobile Flip Button */}
              {isMobile && (
                 <div className="absolute top-3 left-3 z-20">
                    <button 
                        onClick={(e) => {
                            e.stopPropagation();
                            setIsFlipped(!isFlipped);
                        }}
                        className="bg-black/60 backdrop-blur-md p-2 rounded-full border border-white/10 text-white active:scale-95 transition-transform"
                        aria-label={t('media_card.flip_card')}
                    >
                        <Info className="w-4 h-4" />
                    </button>
                 </div>
              )}
              
              <img
                key={imgSrc}
                ref={imgRef}
                src={imgSrc}
                alt={item.title}
                onError={handleImageError}
                onLoad={handleImageLoad}
                className={clsx(
                  "w-full h-full object-cover transition-transform duration-700 group-hover:scale-110",
                  imgLoading ? "opacity-0" : "opacity-100",
                  isFlipped ? "scale-x-[-1]" : ""
                )}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
              
              {/* Category Badge */}
              {item.category && (
                <div className="absolute top-3 right-3 bg-black/60 backdrop-blur-md p-1.5 rounded-full border border-white/10">
                  {getCategoryIcon(item.category)}
                </div>
              )}

              {/* New Update Red Dot */}
              {item.isOngoing && item.hasNewUpdate && (
                <div className="absolute top-3 right-10 w-3 h-3 bg-red-500 rounded-full border border-white animate-pulse shadow-lg z-10" />
              )}

              {/* Content Overlay */}
              <div className="absolute bottom-0 left-0 right-0 p-4 transform transition-transform duration-300 group-hover:translate-y-[-10px]">
                {(imgLoading && !imgFailed) && (
                  <p className="text-xs text-yellow-300 mb-1">{t('media_card.image_loading')}</p>
                )}
                {imgFailed && (
                  <p className="text-xs text-red-400 mb-1">{t('media_card.image_failed')}</p>
                )}
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-theme-accent text-theme-bg rounded-sm ring-1 ring-theme-accent/50 shadow-md">
                    {item.type}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-white leading-tight line-clamp-1 mb-1 font-sans text-shadow-gold">
                  {item.title}
                </h3>
                <p className="text-xs text-gray-300 line-clamp-1">
                  {item.releaseDate} • {item.directorOrAuthor}
                </p>
              </div>
            </div>
          </div>

          {/* Back Side */}
          <div className="absolute inset-0 backface-hidden rotate-y-180 rounded-theme overflow-hidden flex flex-col border-2 bg-theme-surface border-theme-border text-theme-text">
            {/* Spotlight Effect */}
            <div className="absolute inset-0 pointer-events-none bg-gradient-to-tr from-theme-accent/5 via-transparent to-transparent opacity-50" />
            
            {/* Background Image (Added for visual appeal) */}
            <div className="absolute inset-0 z-0 opacity-25 pointer-events-none select-none overflow-hidden">
                <img src={imgSrc} className="w-full h-full object-cover filter blur-sm scale-105" alt="" />
                <div className="absolute inset-0 bg-gradient-to-t from-theme-surface via-transparent to-theme-surface/50" />
            </div>

            {variant === 'collection' && (
              <button
                type="button"
                onClick={handleBackRefresh}
                disabled={isBackRefreshing}
                className={clsx(
                  "absolute top-3 right-3 z-20 p-2 rounded-full border transition-colors",
                  "bg-theme-bg/60 backdrop-blur-md border-theme-border text-theme-subtext hover:text-theme-text hover:border-theme-accent",
                  isBackRefreshing && "opacity-60 cursor-not-allowed"
                )}
                aria-label={t('media_card.refresh')}
                title={t('media_card.refresh_tooltip')}
              >
                <RefreshCw className={clsx("w-4 h-4", isBackRefreshing && "animate-spin")} />
              </button>
            )}

            <div className="relative z-10 flex flex-col h-full p-4">
            <h3 className="text-lg 2xl:text-xl font-bold mb-3 text-theme-accent">
              {item.title}
            </h3>
            
            <div className="flex-1 overflow-y-auto no-scrollbar relative pr-1">
              {/* Metadata Section */}
               <div className="mb-3 space-y-1.5 text-xs text-theme-subtext">
                 {!isUnknownText(item.releaseDate) && (
                   <div className="flex items-center gap-2">
                     <Calendar className="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
                     <span>{item.releaseDate}</span>
                   </div>
                 )}
                 
                 {!isUnknownText(item.directorOrAuthor) && (
                   <div className="flex items-center gap-2">
                     <User className="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
                     <span className="line-clamp-1">{item.directorOrAuthor}</span>
                   </div>
                 )}

                 {item.cast && item.cast.length > 0 && (
                   <div className="flex items-start gap-2">
                     <Users className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 opacity-70" />
                     <span className="line-clamp-2 leading-tight">
                       {item.cast.join(', ')}
                     </span>
                   </div>
                 )}
               </div>

               <div className="w-full h-px mb-3 bg-theme-border" />

              {!isUnknownText(item.description) && (
                <div className={clsx(
                  "text-sm leading-relaxed mb-4 transition-all duration-300 text-theme-text", 
                  !isExpanded && "line-clamp-6"
                )}>
                  {item.description}
                </div>
              )}
              
              {!isUnknownText(item.description) && item.description.length > 150 && (
                <button 
                  onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                  className="text-xs font-medium mb-3 hover:underline text-theme-accent"
                >
                  {isExpanded ? t('media_card.show_less') : t('media_card.view_more')}
                </button>
              )}

              {variant === 'collection' && !isSelectionMode && (
                <div className="flex justify-end gap-2 mb-3">
                    {(!item.isCollection && onStartCollection) && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onStartCollection();
                            }}
                            className="p-2 rounded-lg bg-theme-bg border border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors"
                            title={t('collection.create_collection', { defaultValue: "Create Collection" })}
                        >
                            <FolderPlus className="w-4 h-4" />
                        </button>
                    )}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            updateItem(item.id, { isPinned: !item.isPinned });
                        }}
                        className={clsx(
                          "p-2 rounded-lg border transition-colors",
                          item.isPinned
                            ? "bg-theme-accent text-theme-bg border-theme-accent"
                            : "bg-theme-bg border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent"
                        )}
                        title={item.isPinned ? t('media_card.unpin') : t('media_card.pin')}
                    >
                        <ChevronsUp className="w-4 h-4" />
                    </button>
                </div>
              )}

              {/* User Review Snippet (Collection Mode) */}
              {variant === 'collection' && item.userReview && (
                <div className="mb-3 p-2 rounded border bg-theme-bg border-theme-border text-theme-subtext overflow-hidden max-h-24 prose prose-sm max-w-none prose-p:text-xs prose-p:text-theme-subtext prose-p:m-0 prose-p:leading-relaxed prose-headings:text-xs prose-headings:text-theme-subtext prose-headings:m-0 prose-ul:m-0 prose-li:m-0 prose-li:text-theme-subtext">
                   <ReactMarkdown>{item.userReview}</ReactMarkdown>
                </div>
              )}
              
              {item.isOngoing && (
                <div className="flex items-center gap-2 text-xs 2xl:text-sm font-medium text-theme-accent mb-3">
                  <Clock className="w-3 h-3 2xl:w-4 2xl:h-4" />
                  <span>{t('media_card.ongoing')}</span>
                </div>
              )}

              {/* Tracking Section for Episodic Series in Collection */}
              {isEpisodicItem && item.category && (
                <div className="mt-2 p-3 2xl:p-4 rounded-lg mb-3 border bg-theme-bg/50 border-theme-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] 2xl:text-xs font-bold uppercase tracking-wider text-theme-accent">{t('media_card.tracking')}</span>

                    <div className="flex gap-2">
                        <button
                        onClick={(e) => {
                            e.stopPropagation();
                            updateItem(item.id, { notificationEnabled: !notificationEnabled });
                        }}
                        className={clsx(
                            "transition-colors",
                            notificationEnabled
                            ? "text-theme-accent"
                            : "text-theme-subtext"
                        )}
                        title={t('media_card.toggle_updates')}
                        >
                        {notificationEnabled ? <Bell className="w-3.5 h-3.5 2xl:w-4 2xl:h-4" /> : <BellOff className="w-3.5 h-3.5 2xl:w-4 2xl:h-4" />}
                        </button>
                    </div>
                  </div>

                  {/* Episode grid: one button per episode. Click marks
                      "watched up to here" (this episode and all before it).
                      Colors adapt to the active theme via theme tokens:
                      watched = accent, released = surface, unreleased = dimmed.
                      Collapsed by default; only following works start open. */}
                  {hasGrid && (
                    <div>
                      <button
                        onClick={(e) => { e.stopPropagation(); setGridExpanded(!gridExpanded); }}
                        className="w-full flex items-center justify-between gap-2 text-[10px] text-theme-subtext hover:text-theme-text transition-colors"
                        title={gridExpanded ? t('media_card.episodes_hide') : t('media_card.episodes_show')}
                      >
                        <span className="truncate">{gridSummary}</span>
                        {gridExpanded ? <ChevronUp className="w-3.5 h-3.5 flex-shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />}
                      </button>
                      {gridExpanded && (
                        <div className="mt-1.5 space-y-2.5">
                          {blocks.map(block => (
                            <div key={block.season}>
                              <div className="text-[10px] text-theme-subtext mb-1">
                                {seasonBlocks ? `S${block.season} · ` : ''}
                                {block.windowed ? `${t('media_card.episodes_window', { start: block.start, end: block.end })} · ` : ''}
                                {seasonBlocks ? epCaptionFor(block.total, block.released) : ''}
                              </div>
                              <div className="grid grid-cols-5 gap-1.5">
                                {block.list.map(n => {
                                  const isWatched = n <= block.watched;
                                  const isReleased = n <= block.released;
                                  return (
                                    <button
                                      key={n}
                                      onClick={(e) => {
                                          e.stopPropagation();
                                          markWatched(block, n);
                                      }}
                                      className={clsx(
                                        "py-1 rounded text-[10px] font-medium text-center transition-colors",
                                        isWatched
                                          ? "bg-theme-accent text-theme-bg border-theme-accent"
                                          : isReleased
                                              ? "bg-theme-surface text-theme-text border-theme-border hover:border-theme-accent"
                                              : "bg-theme-bg text-theme-subtext border-theme-border opacity-50",
                                        n === block.watched ? "border-2" : "border"
                                      )}
                                      title={t('media_card.episode_mark', { n })}
                                    >
                                      {String(n).padStart(2, '0')}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Actions */}
            {variant === 'collection' ? (
              <div className="mt-4 flex gap-2 relative z-10">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsEditModalOpen(true);
                  }}
                  className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg font-medium transition-colors bg-theme-accent text-theme-bg hover:bg-theme-accent-hover border-2 border-theme-accent focus:outline-none focus:ring-2 focus:ring-theme-accent"
                >
                  <Edit className="w-4 h-4" />
                  {t('media_card.edit')}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = getNextCategory(item.category);
                    if (onAction) {
                      onAction(item, next);
                    } else {
                      moveCategory(item.id, next);
                      toast.success(t('collection.moved_toast', { title: item.title, category: getCategoryLabel(next) }));
                    }
                  }}
                  className="flex items-center justify-center px-3 py-2 rounded-lg font-medium transition-colors bg-theme-bg text-theme-text hover:bg-theme-bg-hover border-2 border-theme-border focus:outline-none focus:ring-2 focus:ring-theme-accent"
                  title={t('media_card.change_category')}
                >
                  {getCategoryIcon(item.category) ?? <Tags className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowDeleteConfirm(true);
                  }}
                  className="flex items-center justify-center px-3 py-2 rounded-lg font-medium transition-colors bg-theme-accent-warm text-theme-bg hover:bg-theme-accent-warm-2 border-2 border-theme-accent-warm focus:outline-none focus:ring-2 focus:ring-theme-accent"
                  title={t('media_card.delete')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ) : (
              showActions && onAction && (
                <div className="mt-4 grid grid-cols-3 gap-2">
                <button 
                  onClick={(e) => { e.stopPropagation(); onAction(item, CollectionCategory.FAVORITES); }}
                  className="flex flex-col items-center justify-center p-2 rounded-lg transition-colors hover:bg-theme-bg text-theme-subtext hover:text-red-500 border-2 border-theme-border focus:outline-none focus:ring-2 focus:ring-theme-accent"
                  title={t('media_card.action_favorite_title')}
                >
                  <Heart className="w-5 h-5 mb-1" />
                  <span className="text-[10px]">{t('media_card.action_like')}</span>
                </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onAction(item, CollectionCategory.TO_WATCH); }}
                    className="flex flex-col items-center justify-center p-2 rounded-lg transition-colors hover:bg-theme-bg text-theme-subtext hover:text-blue-500 border-2 border-theme-border focus:outline-none focus:ring-2 focus:ring-theme-accent"
                    title={t('media_card.action_towatch_title')}
                  >
                    <Bookmark className="w-5 h-5 mb-1" />
                    <span className="text-[10px]">{t('media_card.action_save')}</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onAction(item, CollectionCategory.WATCHED); }}
                    className="flex flex-col items-center justify-center p-2 rounded-lg transition-colors hover:bg-theme-bg text-theme-subtext hover:text-green-500 border-2 border-theme-border focus:outline-none focus:ring-2 focus:ring-theme-accent"
                    title={t('media_card.action_watched_title')}
                  >
                    <Check className="w-5 h-5 mb-1" />
                    <span className="text-[10px]">{t('media_card.action_done')}</span>
                  </button>
                </div>
              )
            )}
            </div>
          </div>
        </motion.div>
      </motion.div>

      {/* Edit Modal */}
      {isEditModalOpen && (
        <EditMediaModal 
          item={item} 
          onClose={() => setIsEditModalOpen(false)} 
          onDelete={() => removeFromCollection(item.id)}
        />
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="max-w-sm w-full rounded-2xl shadow-2xl border p-6 relative z-10 transition-colors duration-300 bg-theme-surface border-theme-border">
            <div className="text-center mb-4">
              <h3 className="text-lg font-bold text-theme-text">{t('media_card.delete')}</h3>
              <p className="mt-2 text-sm text-theme-subtext">{t('edit_modal.delete_confirm')}</p>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                className="px-4 py-2 rounded-lg font-medium transition-colors bg-theme-surface text-theme-text border border-theme-border hover:bg-theme-bg"
                onClick={() => setShowDeleteConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="px-4 py-2 rounded-lg font-medium transition-colors bg-theme-accent-warm text-theme-bg hover:bg-theme-accent-warm-2"
                onClick={() => { removeFromCollection(item.id); setShowDeleteConfirm(false); }}
              >
                {t('media_card.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
