import React, { useState, useEffect } from 'react';
import { useCollectionStore } from '../store/useCollectionStore';
import { MediaCard } from '../components/MediaCard';
import { CollectionCategory, MediaItem, MediaType } from '../types/types';
import { Filter, Search as SearchIcon, X, Download, Upload, MoreHorizontal, RefreshCw, Plus, Check, ArrowLeft, Edit3, ChevronDown, Tag, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'react-toastify';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { checkUpdates, repairMediaItem, isPlaceholderPosterUrl } from '../services/aiService';
import { AddMediaModal } from '../components/AddMediaModal';
import { save } from '@tauri-apps/plugin-dialog';
import { useMediaQuery } from '../hooks/useMediaQuery';

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Helper to detect Tauri environment
const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

// Long-press duration before a touch drag lifts (app-icon style). 600ms
// matches mobile launcher conventions; raise it here if a slower hold
// should be required. A quick swipe moves past the 8px tolerance long
// before this elapses, so paging and reordering never fight.
const LONG_PRESS_DELAY = 600;

interface SortableItemProps {
    item: MediaItem;
    index: number;
    onClick: () => void;
    onAction: (item: MediaItem, category: CollectionCategory) => void;
    isSelectionMode?: boolean;
    isSelected?: boolean;
    onStartCollection?: () => void;
}

const SortableItem = ({ item, index, onClick, onAction, isSelectionMode, isSelected, onStartCollection }: SortableItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Above sibling cards, below the sticky navbar (z-50).
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="h-full">
      <MediaCard 
        item={item} 
        layoutId={item.id}
        onClick={onClick}
        onAction={onAction}
        index={index}
        variant="collection"
        isSelectionMode={isSelectionMode}
        isSelected={isSelected}
        onStartCollection={onStartCollection}
      />
    </div>
  );
};

export const CollectionPage: React.FC = () => {
  const { t } = useTranslation();
  const { collection, moveCategory, importCollection, exportCollection, updateItem, reorderCollection, createCollection, updateCollectionMembers, bumpToFront } = useCollectionStore();
  const [filter, setFilter] = useState<CollectionCategory | 'All'>('All');
  const [typeFilter, setTypeFilter] = useState<MediaType | 'All'>('All');
  const [statusOpen, setStatusOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  
  // Collection & Selection State
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [collectionInitiatorId, setCollectionInitiatorId] = useState<string | null>(null);
  const [viewingCollectionId, setViewingCollectionId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editCollectionId, setEditCollectionId] = useState<string | null>(null);
  const [editSelectedIds, setEditSelectedIds] = useState<string[]>([]);

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const statusRef = React.useRef<HTMLDivElement>(null);
  const typeRef = React.useRef<HTMLDivElement>(null);
  const detailOverlayRef = React.useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    // Mouse-only drag for desktop pointers...
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8, // Require movement of 8px to start drag (prevents accidental drag on click)
      },
    }),
    // ...and app-icon style long-press drag for touch: hold the card still
    // (within the 8px tolerance) and the drag lifts; quick swipes never
    // reach the delay and stay free for the swipe paging below.
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: LONG_PRESS_DELAY,
        tolerance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Clicking a card opens the detail overlay but leaves keyboard focus on the
  // card's dnd-kit wrapper (tabindex=0). A stray Space/Enter there starts a
  // keyboard drag instead of the no-op the user expects — the drag silently
  // reorders the collection behind the overlay. Hand focus to the overlay
  // itself so keyboard input lands on it while it is open.
  React.useEffect(() => {
    if (selectedId) detailOverlayRef.current?.focus();
  }, [selectedId]);

  const filteredCollection = React.useMemo(() => {
    let base = collection;

    if (editMode && viewingCollectionId) {
        base = base.filter(item => !item.isCollection && (item.parentCollectionId === viewingCollectionId || !item.parentCollectionId));
    } else if (viewingCollectionId) {
        base = base.filter(item => item.parentCollectionId === viewingCollectionId);
    } else {
        base = base.filter(item => !item.parentCollectionId);
    }

    if (filter !== 'All') {
      base = base.filter((item) => item.category === filter);
    }

    if (typeFilter !== 'All') {
      base = base.filter((item) => item.type === typeFilter);
    }

    if (searchTerm) {
        const lower = searchTerm.toLowerCase();
        // Search beyond the title: an actor or director name is a natural way
        // to look for a tracked work ("emily dickinson" → Dickinson), and the
        // metadata is already on the item.
        base = base.filter((item) => {
            const castText = Array.isArray(item.cast) ? item.cast.join(' ') : '';
            return `${item.title} ${castText} ${item.directorOrAuthor || ''}`
                .toLowerCase()
                .includes(lower);
        });
    }

    const indexMap = new Map(collection.map((item, idx) => [item.id, idx]));
    const sorted = [...base].sort((a, b) => {
        const ap = !!a.isPinned;
        const bp = !!b.isPinned;
        if (ap !== bp) return ap ? -1 : 1;
        return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
    });

    return sorted;
  }, [collection, filter, typeFilter, searchTerm, viewingCollectionId, editMode]);

  // Mobile pagination: 3-column grid, 15 items per page. Desktop keeps the
  // single scrolling grid it has always had.
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const MOBILE_PAGE_SIZE = 15;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(filteredCollection.length / MOBILE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visibleCollection = isDesktop
    ? filteredCollection
    : filteredCollection.slice(safePage * MOBILE_PAGE_SIZE, (safePage + 1) * MOBILE_PAGE_SIZE);

  // Touch swipe paging: a fast horizontal swipe on the grid flips pages
  // (left = next, right = previous). Vertical scrolling and taps are
  // unaffected — the direction test requires |dx| > 2|dy| and 64px of travel.
  // Skipped while a long-press drag is active: releasing a reorder gesture
  // must never also flip the page.
  const gridTouchRef = React.useRef<{ x: number; y: number; t: number } | null>(null);
  const dragActiveRef = React.useRef(false);
  const handleGridTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    gridTouchRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  };
  const handleGridTouchEnd = (e: React.TouchEvent) => {
    const start = gridTouchRef.current;
    gridTouchRef.current = null;
    if (!start || isDesktop || pageCount <= 1 || dragActiveRef.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const dt = Date.now() - start.t;
    if (dt > 800 || Math.abs(dx) < 64 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    if (dx < 0 && safePage < pageCount - 1) setPage(safePage + 1);
    if (dx > 0 && safePage > 0) setPage(safePage - 1);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    
    if (active.id !== over?.id) {
      const oldIndex = filteredCollection.findIndex((item) => item.id === active.id);
      const newIndex = filteredCollection.findIndex((item) => item.id === over?.id);
      
      if (oldIndex !== -1 && newIndex !== -1) {
          const nextVisible = arrayMove(filteredCollection, oldIndex, newIndex);
          const nextVisibleIds = new Set(nextVisible.map(item => item.id));
          const topLevel = collection.filter(item => !item.parentCollectionId && nextVisibleIds.has(item.id));
          const topLevelMap = new Map(topLevel.map(item => [item.id, item]));
          const reorderedTop = nextVisible.map(item => topLevelMap.get(item.id) || item);
          let topIndex = 0;
          const newOrder = collection.map(item => {
              if (item.parentCollectionId || !nextVisibleIds.has(item.id)) return item;
              const nextItem = reorderedTop[topIndex];
              topIndex += 1;
              return nextItem;
          });
          reorderCollection(newOrder);
      }
    }
  };

  const isDraggable = filter === 'All' && typeFilter === 'All' && searchTerm === '' && !selectionMode && !editMode;

  const handleRefresh = async () => {
      setIsRefreshing(true);
      try {
          const now = Date.now();
          let updatedCount = 0;
          let repairedCount = 0;

          // 1. Repair missing metadata (posters, dates)
          // Process in chunks to avoid overwhelming APIs
          const itemsToRepair = collection.filter(item =>
              isPlaceholderPosterUrl(item.posterUrl) ||
              !!item.posterFailedAt ||
              !item.releaseDate
          );
          
          if (itemsToRepair.length > 0) {
              toast.info(t('collection.repairing_metadata', { count: itemsToRepair.length , defaultValue: `Updating metadata for ${itemsToRepair.length} items...` }));
              
              // Process sequentially or in small batches
              for (const item of itemsToRepair) {
                  try {
                      const updates = await repairMediaItem(item);
                      if (updates) {
                          updateItem(item.id, updates);
                          repairedCount++;
                      }
                  } catch (e) {
                      console.error(`Failed to repair ${item.title}`, e);
                  }
              }
          }

          // 2. Check for updates: ongoing items, plus ended episodic works so a
          // "finished" show that starts updating again stays discoverable via
          // this manual sweep (resurrection). Automatic startup checks only
          // cover ongoing items; the manual sweep is the resurrection net.
          const episodicTypes: string[] = [MediaType.TV_SERIES, MediaType.COMIC, MediaType.BOOK, MediaType.SHORT_DRAMA];
          const ongoingItems = collection.filter(item =>
              item.notificationEnabled !== false &&
              (item.isOngoing || episodicTypes.includes(item.type))
          );

          if (ongoingItems.length > 0) {
             const updates = await checkUpdates(ongoingItems);
             updates.forEach(update => {
                const original = collection.find(i => i.id === update.id);
                if (!original) return;
                const changed = update.latestUpdateInfo !== original.latestUpdateInfo;
                updateItem(update.id, {
                  latestUpdateInfo: update.latestUpdateInfo,
                  isOngoing: update.isOngoing,
                  ...(update.totalEpisodes ? { totalEpisodes: update.totalEpisodes } : {}),
                  ...(update.seasons ? { seasons: update.seasons } : {}),
                  ...(update.tmdbId ? { tmdbId: update.tmdbId, tmdbMediaType: update.tmdbMediaType } : {}),
                  lastCheckedAt: now,
                  hasNewUpdate: changed ? true : original.hasNewUpdate
                });
                // New content floats the work to the front (not a pin).
                if (changed && update.isOngoing) {
                  bumpToFront(update.id);
                }
                if (changed) updatedCount++;
             });
          }

          if (updatedCount > 0 || repairedCount > 0) {
              toast.success(t('collection.refresh_success', { updated: updatedCount, repaired: repairedCount , defaultValue: `Updated ${updatedCount} items, repaired ${repairedCount} items` }));
          } else {
              toast.info(t('collection.refresh_no_changes', { defaultValue: "No new updates found" }));
          }

      } catch (error) {
          console.error(error);
          toast.error(t('collection.refresh_error', { defaultValue: "Failed to refresh collection" }));
      } finally {
          setIsRefreshing(false);
      }
  };

  const getCategoryLabel = (cat: string) => {
    switch (cat) {
        case 'All': return t('search_page.filter_all');
        case 'To Watch': return t('dashboard.to_watch');
        case 'Watched': return t('dashboard.status_watched');
        case 'Favorites': return t('dashboard.status_favorites');
        default: return cat;
    }
  };

  const getTypeLabel = (type: MediaType | 'All') => {
    switch (type) {
        case 'All': return t('collection.filter_all_types', { defaultValue: 'All Types' });
        case MediaType.MOVIE: return t('search_page.filter_movies');
        case MediaType.TV_SERIES: return t('search_page.filter_tv');
        case MediaType.BOOK: return t('search_page.filter_books');
        case MediaType.COMIC: return t('search_page.filter_comics');
        case MediaType.SHORT_DRAMA: return t('search_page.filter_short_dramas');
        case MediaType.MUSIC: return t('search_page.filter_music');
        case MediaType.OTHER: return t('search_page.filter_other');
        default: return String(type);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectionMode) {
             handleCancelCollection();
        } else if (editMode) {
             handleCancelEditCollection();
        } else if (viewingCollectionId) {
             setViewingCollectionId(null);
        } else {
             setSelectedId(null);
             setShowMenu(false);
        }
        setStatusOpen(false);
        setTypeOpen(false);
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
      if (typeRef.current && !typeRef.current.contains(e.target as Node)) {
        setTypeOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [selectionMode, viewingCollectionId]);

  const handleStartCollection = (initiatorId: string) => {
      setSelectionMode(true);
      setCollectionInitiatorId(initiatorId);
      setSelectedIds([initiatorId]);
  };

  const handleToggleSelection = (id: string) => {
      if (selectedIds.includes(id)) {
          setSelectedIds(selectedIds.filter(i => i !== id));
      } else {
          setSelectedIds([...selectedIds, id]);
      }
  };

  const handleConfirmCollection = () => {
      if (!collectionInitiatorId) return;
      
      const initiator = collection.find(i => i.id === collectionInitiatorId);
      if (!initiator) return;

      const selected = collection.filter(i => selectedIds.includes(i.id) && i.id !== collectionInitiatorId);
      
      createCollection(initiator, selected);
      toast.success(t('collection.created_success', { defaultValue: "Collection created!" }));
      
      setSelectionMode(false);
      setCollectionInitiatorId(null);
      setSelectedIds([]);
  };

  const handleCancelCollection = () => {
      setSelectionMode(false);
      setCollectionInitiatorId(null);
      setSelectedIds([]);
  };

  const handleStartEditCollection = () => {
      if (!viewingCollectionId) return;
      const currentMembers = collection.filter(i => i.parentCollectionId === viewingCollectionId).map(i => i.id);
      setSelectionMode(false);
      setCollectionInitiatorId(null);
      setSelectedIds([]);
      setEditMode(true);
      setEditCollectionId(viewingCollectionId);
      setEditSelectedIds(currentMembers);
  };

  const handleToggleEditSelection = (id: string) => {
      setEditSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const handleConfirmEditCollection = () => {
      if (!editCollectionId) return;
      updateCollectionMembers(editCollectionId, editSelectedIds);
      toast.success(t('collection.edit_saved', { defaultValue: "Collection updated" }));
      handleCancelEditCollection();
  };

  const handleCancelEditCollection = () => {
      setEditMode(false);
      setEditCollectionId(null);
      setEditSelectedIds([]);
  };

  const handleMove = (item: MediaItem, category: CollectionCategory) => {
    moveCategory(item.id, category);
    toast.success(t('collection.moved_toast', { title: item.title, category: getCategoryLabel(category) }));
  };

  const handleExport = async () => {
    if (collection.length === 0) {
      toast.info(t('collection.export_empty'));
      return;
    }

    if (isTauri) {
        try {
            const path = await save({
                filters: [{
                    name: 'JSON',
                    extensions: ['json']
                }],
                defaultPath: `media-collection-${new Date().toISOString().split('T')[0]}.json`
            });
            
            if (path) {
                // Call store export with the selected path
                const result = await exportCollection(path);
                if (result) {
                    toast.success(t('collection.export_success'));
                } else {
                    toast.error(t('collection.export_error', { defaultValue: 'Export failed' }));
                }
            }
        } catch (e) {
            console.error('Save dialog failed', e);
            toast.error('Export failed');
        }
        setShowMenu(false);
        return;
    }
    
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(collection, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `media-collection-${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchorNode); // required for firefox
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    toast.success(t('collection.export_success'));
    setShowMenu(false);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = event.target?.result as string;
        const items = JSON.parse(json);
        
        if (!Array.isArray(items)) {
          throw new Error("Invalid format");
        }

        // Basic validation
        const validItems = items.filter((item: any) => item.id && item.title && item.type);
        
        if (validItems.length === 0) {
           toast.error(t('collection.import_invalid'));
           return;
        }

        importCollection(validItems);
        toast.success(t('collection.import_success', { count: validItems.length }));
      } catch (error) {
        console.error('Import error:', error);
        toast.error(t('collection.import_error'));
      } finally {
        // Reset input
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
        setShowMenu(false);
      }
    };
    reader.readAsText(file);
  };

  return (
    <>
      <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-2 md:gap-6 mb-4 md:mb-8">
        <div className="flex items-center gap-4">
            {viewingCollectionId && (
                <button 
                    onClick={() => setViewingCollectionId(null)}
                    className="p-2 rounded-full hover:bg-theme-bg transition-colors"
                >
                    <ArrowLeft className="w-6 h-6 text-theme-text" />
                </button>
            )}
            <div>
                {selectionMode ? (
                     <>
                        <h1 className="text-2xl md:text-3xl font-bold text-theme-accent">{t('collection.selection_mode', { defaultValue: "Selection Mode" })}</h1>
                        <p className="mt-1 text-theme-subtext">{t('collection.selection_hint', { defaultValue: "Select items to add to collection" })}</p>
                     </>
                ) : editMode ? (
                     <>
                        <h1 className="text-2xl md:text-3xl font-bold text-theme-accent">{t('collection.edit_mode', { defaultValue: "Edit Collection" })}</h1>
                        <p className="mt-1 text-theme-subtext">{t('collection.edit_hint', { defaultValue: "Select items to keep in this collection" })}</p>
                     </>
                ) : viewingCollectionId ? (
                     <>
                        <h1 className="text-2xl md:text-3xl font-bold text-theme-accent">
                            {collection.find(i => i.id === viewingCollectionId)?.title || t('collection.collection_view')}
                        </h1>
                        <p className="mt-1 text-theme-subtext">{t('collection.collection_view', { defaultValue: "Collection View" })}</p>
                     </>
                ) : (
                     <>
                        <h1 className="text-2xl md:text-3xl font-bold text-theme-accent">{t('collection.title')}</h1>
                        <p className="mt-1 hidden md:block text-theme-subtext">{t('collection.subtitle')}</p>
                     </>
                )}
            </div>
        </div>

        {selectionMode || editMode ? (
            <div className="flex items-center gap-4">
                <button
                    onClick={selectionMode ? handleCancelCollection : handleCancelEditCollection}
                    className="px-6 py-2 rounded-lg border border-theme-border text-theme-subtext hover:text-theme-text hover:bg-theme-bg transition-colors flex items-center gap-2"
                >
                    <X className="w-5 h-5" />
                    {t('common.cancel')}
                </button>
                <button
                    onClick={selectionMode ? handleConfirmCollection : handleConfirmEditCollection}
                    className="px-6 py-2 rounded-lg bg-theme-accent text-theme-bg font-bold hover:bg-theme-accent-hover transition-colors flex items-center gap-2 shadow-lg shadow-theme-accent/20"
                >
                    <Check className="w-5 h-5" />
                    {t('common.confirm')}
                </button>
            </div>
        ) : (
            <div className="flex flex-wrap sm:flex-nowrap flex-1 sm:flex-none items-center gap-2 md:gap-4 min-w-[240px]">
                 <div className="relative flex-1 sm:flex-none min-w-[150px]">
                    <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-subtext" />
                    <input
                        type="text"
                        placeholder={t('collection.filter_placeholder')}
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-9 pr-4 py-1.5 md:py-2 rounded-lg border focus:ring-2 outline-none w-full sm:w-64 transition-all bg-theme-surface border-theme-border text-sm text-theme-text focus:border-theme-accent focus:ring-theme-accent/20 placeholder-theme-subtext"
                    />
                </div>
                
                <button
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    className={clsx(
                        "p-1.5 md:p-2 rounded-lg border transition-colors flex items-center justify-center",
                        isRefreshing
                            ? "bg-theme-surface border-theme-border text-theme-subtext cursor-wait"
                            : "bg-theme-surface border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent"
                    )}
                    title={t('collection.refresh_tooltip', { defaultValue: "Refresh collection & Fix metadata" })}
                >
                    <RefreshCw className={clsx("w-5 h-5", isRefreshing && "animate-spin")} />
                </button>

                {viewingCollectionId && (
                    <button
                        onClick={handleStartEditCollection}
                        className="p-1.5 md:p-2 rounded-lg border bg-theme-surface border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors flex items-center justify-center"
                        title={t('collection.edit_collection', { defaultValue: "Edit Collection" })}
                    >
                        <Edit3 className="w-5 h-5" />
                    </button>
                )}

                <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="p-1.5 md:p-2 rounded-lg border bg-theme-surface border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors flex items-center justify-center"
                    title={t('collection.add_manual_tooltip', { defaultValue: "Add Manually" })}
                >
                    <Plus className="w-5 h-5" />
                </button>

                <div className="flex gap-1.5 md:gap-2 items-center">
                    {/* Status filter dropdown: All / Favorites / To Watch / Watched */}
                    <div className="relative" ref={statusRef}>
                        <button
                            onClick={() => { setStatusOpen(!statusOpen); setTypeOpen(false); }}
                            className={clsx(
                              "px-3 py-1.5 md:px-4 md:py-2 rounded-full text-xs md:text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5 md:gap-2",
                              (filter !== 'All' || statusOpen)
                                ? "bg-theme-accent text-theme-bg"
                                : "bg-theme-surface border border-theme-border text-theme-text hover:bg-theme-bg"
                            )}
                            title={t('collection.filter_status_tooltip', { defaultValue: 'Filter by status' })}
                        >
                            <Filter className="w-4 h-4" />
                            {getCategoryLabel(filter)}
                            <ChevronDown className={clsx("w-4 h-4 transition-transform", statusOpen && "rotate-180")} />
                        </button>
                        {statusOpen && (
                            <div className="absolute right-0 sm:left-0 top-full mt-2 w-36 bg-theme-surface border border-theme-border rounded-lg shadow-lg z-50 overflow-hidden">
                                {(['All', ...Object.values(CollectionCategory)] as const).map((cat) => (
                                    <button
                                        key={cat}
                                        onClick={() => { setFilter(cat); setStatusOpen(false); }}
                                        className={clsx(
                                          "w-full text-left px-4 py-2 text-sm transition-colors flex items-center justify-between gap-2",
                                          filter === cat
                                            ? "text-theme-accent bg-theme-bg"
                                            : "text-theme-text hover:bg-theme-bg"
                                        )}
                                    >
                                        {getCategoryLabel(cat)}
                                        {filter === cat && <Check className="w-4 h-4 flex-shrink-0" />}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Type filter dropdown: Movie / TV Series / Book / ... */}
                    <div className="relative" ref={typeRef}>
                        <button
                            onClick={() => { setTypeOpen(!typeOpen); setStatusOpen(false); }}
                            className={clsx(
                              "px-3 py-1.5 md:px-4 md:py-2 rounded-full text-xs md:text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5 md:gap-2",
                              (typeFilter !== 'All' || typeOpen)
                                ? "bg-theme-accent text-theme-bg"
                                : "bg-theme-surface border border-theme-border text-theme-text hover:bg-theme-bg"
                            )}
                            title={t('collection.filter_type_tooltip', { defaultValue: 'Filter by type' })}
                        >
                            <Tag className="w-4 h-4" />
                            {getTypeLabel(typeFilter)}
                            <ChevronDown className={clsx("w-4 h-4 transition-transform", typeOpen && "rotate-180")} />
                        </button>
                        {typeOpen && (
                            <div className="absolute right-0 sm:left-0 top-full mt-2 w-36 bg-theme-surface border border-theme-border rounded-lg shadow-lg z-50 overflow-hidden max-h-80 overflow-y-auto">
                                {(['All', ...Object.values(MediaType)] as const).map((type) => (
                                    <button
                                        key={type}
                                        onClick={() => { setTypeFilter(type); setTypeOpen(false); }}
                                        className={clsx(
                                          "w-full text-left px-4 py-2 text-sm transition-colors flex items-center justify-between gap-2",
                                          typeFilter === type
                                            ? "text-theme-accent bg-theme-bg"
                                            : "text-theme-text hover:bg-theme-bg"
                                        )}
                                    >
                                        {getTypeLabel(type)}
                                        {typeFilter === type && <Check className="w-4 h-4 flex-shrink-0" />}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
                
                <div className="flex gap-2 items-center pl-4 sm:border-l sm:border-theme-border relative" ref={menuRef}>
                   <button
                     onClick={() => setShowMenu(!showMenu)}
                     className="p-2 rounded-lg bg-theme-surface border border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors"
                     title={t('collection.import_export_tooltip')}
                   >
                     <MoreHorizontal className="w-5 h-5" />
                   </button>

                   {showMenu && (
                     <div className="absolute right-0 top-full mt-2 w-48 bg-theme-surface border border-theme-border rounded-lg shadow-lg z-50 overflow-hidden">
                       <button
                         onClick={handleExport}
                         className="w-full text-left px-4 py-2 hover:bg-theme-bg transition-colors flex items-center gap-2 text-theme-text"
                       >
                         <Download className="w-4 h-4" />
                         {t('collection.export_tooltip')}
                       </button>
                       <button
                         onClick={() => fileInputRef.current?.click()}
                         className="w-full text-left px-4 py-2 hover:bg-theme-bg transition-colors flex items-center gap-2 text-theme-text"
                       >
                         <Upload className="w-4 h-4" />
                         {t('collection.import_tooltip')}
                       </button>
                     </div>
                   )}

                   <input
                     type="file"
                     ref={fileInputRef}
                     onChange={handleImport}
                     accept=".json"
                     className="hidden"
                   />
                </div>
            </div>
        )}
      </div>

      {collection.length === 0 ? (
        <div className="text-center py-20 rounded-2xl border border-dashed bg-theme-surface border-theme-border">
            <Filter className="w-12 h-12 mx-auto mb-4 text-theme-subtext" />
            <h3 className="text-lg font-medium text-theme-text">{t('collection.empty_title')}</h3>
            <p className="mb-6 text-theme-subtext">{t('collection.empty_text')}</p>
        </div>
      ) : (
        isDraggable ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => { dragActiveRef.current = true; }}
            onDragEnd={(event) => { dragActiveRef.current = false; handleDragEnd(event); }}
            onDragCancel={() => { dragActiveRef.current = false; }}
          >
            <SortableContext
              items={visibleCollection.map(i => i.id)}
              strategy={rectSortingStrategy}
            >
                <div
                  className="grid grid-cols-3 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5 gap-x-3 gap-y-5 md:gap-x-6 md:gap-y-8"
                  onTouchStart={handleGridTouchStart}
                  onTouchEnd={handleGridTouchEnd}
                >
                    {visibleCollection.map((item, index) => (
                        <SortableItem
                            key={item.id} 
                            item={item} 
                            onClick={() => {
                                if (selectionMode) {
                                    handleToggleSelection(item.id);
                                } else if (editMode) {
                                    handleToggleEditSelection(item.id);
                                } else if (item.isCollection) {
                                    setViewingCollectionId(item.id);
                                } else {
                                    setSelectedId(item.id);
                                }
                            }}
                            onAction={handleMove}
                            index={index}
                            isSelectionMode={selectionMode || editMode}
                            isSelected={selectionMode ? selectedIds.includes(item.id) : editSelectedIds.includes(item.id)}
                            onStartCollection={editMode ? undefined : () => handleStartCollection(item.id)}
                        />
                    ))}
                </div>
            </SortableContext>
          </DndContext>
        ) : (
            <motion.div
              layout
              className="grid grid-cols-3 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5 gap-x-3 gap-y-5 md:gap-x-6 md:gap-y-8"
              onTouchStart={handleGridTouchStart}
              onTouchEnd={handleGridTouchEnd}
            >
                <AnimatePresence>
                    {visibleCollection.map((item, index) => (
                        <MediaCard 
                            key={item.id} 
                            item={item} 
                            layoutId={item.id}
                            onClick={() => {
                                if (selectionMode) {
                                    handleToggleSelection(item.id);
                                } else if (editMode) {
                                    handleToggleEditSelection(item.id);
                                } else if (item.isCollection) {
                                    setViewingCollectionId(item.id);
                                } else {
                                    setSelectedId(item.id);
                                }
                            }}
                            onAction={handleMove}
                            index={index}
                            variant="collection"
                            isSelectionMode={selectionMode || editMode}
                            isSelected={selectionMode ? selectedIds.includes(item.id) : editSelectedIds.includes(item.id)}
                            onStartCollection={editMode ? undefined : () => handleStartCollection(item.id)}
                        />
                    ))}
                </AnimatePresence>
            </motion.div>
        )
      )}

      {/* Mobile pager: 15 items (3×5) per page. Desktop scrolls instead. */}
      {!isDesktop && pageCount > 1 && (
        <div className="flex items-center justify-center gap-3 mt-5">
          <button
            onClick={() => setPage(safePage - 1)}
            disabled={safePage === 0}
            className="p-2 rounded-lg border transition-colors bg-theme-surface border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('collection.prev_page', { defaultValue: 'Previous page' })}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-theme-subtext tabular-nums">
            {t('collection.page_of', { page: safePage + 1, total: pageCount, defaultValue: `${safePage + 1} / ${pageCount}` })}
          </span>
          <button
            onClick={() => setPage(safePage + 1)}
            disabled={safePage >= pageCount - 1}
            className="p-2 rounded-lg border transition-colors bg-theme-surface border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('collection.next_page', { defaultValue: 'Next page' })}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {filteredCollection.length === 0 && collection.length > 0 && (
          <div className="text-center py-12">
              <p className="text-theme-subtext">{t('collection.no_matches')}</p>
          </div>
      )}

      </div>

      {/* Fixed overlays live OUTSIDE the space-y-8 container: Tailwind v4's
          space-y gives every non-last child a bottom margin, and a bottom
          margin on a fixed inset-0 element shrinks it — the backdrop used to
          stop 32px short of the screen bottom. */}
      <AnimatePresence>
        {selectedId && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 z-[60] backdrop-blur-sm"
              onClick={() => setSelectedId(null)}
            />
            <div
              ref={detailOverlayRef}
              tabIndex={-1}
              onKeyDown={(e) => {
                // The overlay floats above the grid; Space would scroll the
                // hidden list underneath. Swallow it while the overlay is up.
                if (e.key === ' ') e.preventDefault();
              }}
              className="fixed inset-0 grid place-items-center z-[70] pointer-events-none p-4 md:p-8 outline-none"
            >
               <div className="pointer-events-auto w-full aspect-[1/1.48] md:w-auto md:h-[85vh] shadow-2xl relative max-w-full">
                  {collection.find(item => item.id === selectedId) && (
                     <MediaCard
                        item={collection.find(item => item.id === selectedId)!}
                        layoutId={selectedId}
                        onAction={handleMove}
                        showActions={true}
                        className="w-full h-full"
                        variant="collection"
                        // On touch screens there is no hover-flip, so start the
                        // detail card on the metadata face (Edit/actions are
                        // there) and offer an explicit poster toggle.
                        defaultFlipped={!isDesktop}
                        showFlipToggle={!isDesktop}
                     />
                  )}
                  <button
                    onClick={() => setSelectedId(null)}
                    className="absolute -top-12 right-0 p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
                  >
                    <X className="w-6 h-6" />
                  </button>
               </div>
            </div>
          </>
        )}
      </AnimatePresence>

      {isAddModalOpen && (
        <AddMediaModal onClose={() => setIsAddModalOpen(false)} />
      )}
    </>
  );
};
