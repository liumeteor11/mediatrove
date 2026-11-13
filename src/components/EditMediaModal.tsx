import React, { useState, useCallback, useRef, useEffect } from 'react';
import Cropper, { Point, Area } from 'react-easy-crop';
import { MediaItem } from '../types/types';
import { X, Upload, Save, Trash2, RotateCcw, FileText, Image as ImageIcon, Bold, Italic, Link as LinkIcon, List, Eye, EyeOff, Columns, Info } from 'lucide-react';
import { useCollectionStore } from '../store/useCollectionStore';
import clsx from 'clsx';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';

interface EditMediaModalProps {
  item: MediaItem;
  onClose: () => void;
  onDelete: () => void;
}

// Helper function to clean initial HTML content from ReactQuill
const cleanInitialContent = (content: string | undefined): string => {
  if (!content) return '';
  // Simple check if it looks like HTML (starts with <p, <div, etc or contains HTML entities)
  if (content.trim().startsWith('<') || content.includes('&lt;')) {
    return content
      .replace(/<p>/g, '')
      .replace(/<\/p>/g, '\n\n')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<strong>/g, '**')
      .replace(/<\/strong>/g, '**')
      .replace(/<em>/g, '*')
      .replace(/<\/em>/g, '*')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/<[^>]*>/g, '') // Strip remaining tags
      .trim();
  }
  return content;
};

export const EditMediaModal: React.FC<EditMediaModalProps> = ({ item, onClose, onDelete }) => {
  const { t } = useTranslation();
  const { updateItem } = useCollectionStore();
  const [activeTab, setActiveTab] = useState<'info' | 'review' | 'cover'>('info');
  // Clean content on init
  const [reviewContent, setReviewContent] = useState(() => cleanInitialContent(item.userReview));
  const [editDirector, setEditDirector] = useState(item.directorOrAuthor || '');
  const [editDescription, setEditDescription] = useState(item.description || '');
  const [editReleaseDate, setEditReleaseDate] = useState(item.releaseDate || '');
  const [editCast, setEditCast] = useState(item.cast ? item.cast.join(', ') : '');
  // Manual corrections are the final word on tracking data: when the first
  // AI/search guess got the episode count wrong (and no authoritative source
  // covers the title), this is the user's way to fix it for good.
  const hasSeasonStructure = !!(item.seasons && item.seasons.length > 0);
  const [editTotalEpisodes, setEditTotalEpisodes] = useState(item.totalEpisodes != null ? String(item.totalEpisodes) : '');
  const [editUserProgress, setEditUserProgress] = useState(item.userProgress || '');
  const [isSaving, setIsSaving] = useState(false);
  const [viewMode, setViewMode] = useState<'edit' | 'split' | 'preview'>('edit');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Image Upload & Crop State
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-save effect (basic implementation)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (reviewContent !== cleanInitialContent(item.userReview || '')) {
        handleSave(true);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [reviewContent]);

  const onCropComplete = useCallback((croppedArea: Area, croppedAreaPixels: Area) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const createImage = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image));
      image.addEventListener('error', (error) => reject(error));
      image.setAttribute('crossOrigin', 'anonymous');
      image.src = url;
    });

  const getCroppedImg = async (imageSrc: string, pixelCrop: Area): Promise<string> => {
    const image = await createImage(imageSrc);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return '';
    }

    canvas.width = pixelCrop.width;
    canvas.height = pixelCrop.height;

    ctx.drawImage(
      image,
      pixelCrop.x,
      pixelCrop.y,
      pixelCrop.width,
      pixelCrop.height,
      0,
      0,
      pixelCrop.width,
      pixelCrop.height
    );

    return canvas.toDataURL('image/jpeg');
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const imageDataUrl = await readFile(file);
      setImageSrc(imageDataUrl as string);
    }
  };

  const readFile = (file: File) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result));
      reader.readAsDataURL(file);
    });
  };

  const handleSave = async (silent = false) => {
    setIsSaving(true);
    try {
      const totalEpisodesNum = parseInt(editTotalEpisodes, 10);
      const updates: Partial<MediaItem> = {
        userReview: reviewContent,
        directorOrAuthor: editDirector,
        description: editDescription,
        releaseDate: editReleaseDate,
        cast: editCast.split(',').map(c => c.trim()).filter(Boolean),
        userProgress: editUserProgress.trim() || undefined,
        // With structured seasons the per-season totals come from the TMDB
        // check; a flat total would be ignored by the grid anyway.
        ...(hasSeasonStructure
            ? {}
            : { totalEpisodes: Number.isFinite(totalEpisodesNum) && totalEpisodesNum > 0 ? totalEpisodesNum : undefined }),
        lastEditedAt: Date.now(),
      };

      if (imageSrc && croppedAreaPixels && activeTab === 'cover') {
        const croppedImage = await getCroppedImg(imageSrc, croppedAreaPixels);
        updates.customPosterUrl = croppedImage;
      }

      updateItem(item.id, updates);
      if (!silent) {
        toast.success(t('edit_modal.save_success'));
        onClose();
      }
    } catch (error) {
      console.error('Save error:', error);
      if (!silent) toast.error(t('edit_modal.save_error'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = () => {
    setConfirmDelete(true);
  };

  // Formatting Helpers
  const insertFormat = (prefix: string, suffix: string) => {
    if (!textareaRef.current) return;
    
    const start = textareaRef.current.selectionStart;
    const end = textareaRef.current.selectionEnd;
    const text = reviewContent;
    
    const before = text.substring(0, start);
    const selected = text.substring(start, end);
    const after = text.substring(end);
    
    const newText = before + prefix + selected + suffix + after;
    setReviewContent(newText);
    
    // Reset cursor position
    setTimeout(() => {
        if (textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(start + prefix.length, end + prefix.length);
        }
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      insertFormat('**', '**');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
      e.preventDefault();
      insertFormat('*', '*');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      insertFormat('[', '](url)');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className={clsx(
        "w-full flex flex-col rounded-theme shadow-theme overflow-hidden bg-theme-surface border border-theme-border h-[600px] transition-all duration-300",
        viewMode === 'split' ? "max-w-6xl" : "max-w-3xl"
      )}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-theme-border bg-theme-bg">
          <h2 className="text-xl font-bold text-theme-accent">
            {t('edit_modal.title', { title: item.title })}
          </h2>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-theme-surface transition-colors">
            <X className="w-6 h-6 text-theme-subtext" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center px-6 border-b border-theme-border bg-theme-bg/50">
          <button
            onClick={() => setActiveTab('info')}
            className={clsx(
              "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
              activeTab === 'info'
                ? "border-theme-accent text-theme-accent"
                : "border-transparent text-theme-subtext hover:text-theme-text"
            )}
          >
            <Info className="w-4 h-4" />
            {t('edit_modal.tab_info', { defaultValue: 'Info' })}
          </button>
          <button
            onClick={() => setActiveTab('review')}
            className={clsx(
              "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
              activeTab === 'review'
                ? "border-theme-accent text-theme-accent"
                : "border-transparent text-theme-subtext hover:text-theme-text"
            )}
          >
            <FileText className="w-4 h-4" />
            {t('edit_modal.tab_review')}
          </button>
          <button
            onClick={() => setActiveTab('cover')}
            className={clsx(
              "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
              activeTab === 'cover'
                ? "border-theme-accent text-theme-accent"
                : "border-transparent text-theme-subtext hover:text-theme-text"
            )}
          >
            <ImageIcon className="w-4 h-4" />
            {t('edit_modal.tab_cover')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-6 overflow-y-auto bg-theme-bg relative">
          {activeTab === 'info' && (
             <div className="flex flex-col gap-4 h-full">
                <div className="space-y-2">
                    <label className="text-sm font-medium text-theme-subtext">{t('media_card.director_author', { defaultValue: 'Director / Author' })}</label>
                    <input
                        type="text"
                        value={editDirector}
                        onChange={(e) => setEditDirector(e.target.value)}
                        className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all"
                        placeholder={t('media_card.director_placeholder', { defaultValue: 'Enter director or author name...' })}
                    />
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-subtext">{t('media_card.release_date', { defaultValue: 'Release Date' })}</label>
                        <input
                            type="text"
                            value={editReleaseDate}
                            onChange={(e) => setEditReleaseDate(e.target.value)}
                            className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all"
                            placeholder={t('media_card.release_date_placeholder', { defaultValue: 'e.g. 2023-07-21' })}
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-subtext">{t('media_card.cast', { defaultValue: 'Cast & Crew' })}</label>
                        <input
                            type="text"
                            value={editCast}
                            onChange={(e) => setEditCast(e.target.value)}
                            className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all"
                            placeholder={t('media_card.cast_placeholder', { defaultValue: 'Enter cast members, separated by commas...' })}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-subtext">{t('edit_modal.user_progress', { defaultValue: 'Watch Progress' })}</label>
                        <input
                            type="text"
                            value={editUserProgress}
                            onChange={(e) => setEditUserProgress(e.target.value)}
                            className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all"
                            placeholder={t('edit_modal.user_progress_placeholder', { defaultValue: 'e.g. S1E5 or Chapter 10' })}
                        />
                    </div>
                    {!hasSeasonStructure && (
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-subtext">{t('edit_modal.total_episodes', { defaultValue: 'Total Episodes' })}</label>
                            <input
                                type="number"
                                min={1}
                                value={editTotalEpisodes}
                                onChange={(e) => setEditTotalEpisodes(e.target.value)}
                                className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all"
                                placeholder={t('edit_modal.total_episodes_placeholder', { defaultValue: 'e.g. 12' })}
                            />
                        </div>
                    )}
                </div>

                <div className="space-y-2 flex-1 flex flex-col">
                    <label className="text-sm font-medium text-theme-subtext">{t('media_card.description', { defaultValue: 'Description' })}</label>
                    <textarea
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        className="w-full flex-1 p-4 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none resize-none leading-relaxed"
                        placeholder={t('media_card.description_placeholder', { defaultValue: 'Enter plot summary or description...' })}
                    />
                </div>
             </div>
          )}

          {activeTab === 'review' && (
            <div className="h-full flex flex-col">
              {/* Toolbar */}
              <div className="flex items-center gap-1 mb-2 pb-2 border-b border-theme-border/50">
                <button
                  onClick={() => insertFormat('**', '**')}
                  className="p-2 rounded hover:bg-theme-surface text-theme-subtext hover:text-theme-accent transition-colors"
                  title={t('edit_modal.bold_title')}
                >
                  <Bold className="w-4 h-4" />
                </button>
                <button
                  onClick={() => insertFormat('*', '*')}
                  className="p-2 rounded hover:bg-theme-surface text-theme-subtext hover:text-theme-accent transition-colors"
                  title={t('edit_modal.italic_title')}
                >
                  <Italic className="w-4 h-4" />
                </button>
                <button
                  onClick={() => insertFormat('[', '](url)')}
                  className="p-2 rounded hover:bg-theme-surface text-theme-subtext hover:text-theme-accent transition-colors"
                  title={t('edit_modal.link_title')}
                >
                  <LinkIcon className="w-4 h-4" />
                </button>
                 <button
                  onClick={() => insertFormat('- ', '')}
                  className="p-2 rounded hover:bg-theme-surface text-theme-subtext hover:text-theme-accent transition-colors"
                  title={t('edit_modal.list_title')}
                >
                  <List className="w-4 h-4" />
                </button>
                <div className="w-px h-4 bg-theme-border mx-2" />
                <button
                  onClick={() => setViewMode(viewMode === 'split' ? 'edit' : 'split')}
                  className={clsx(
                    "p-2 rounded transition-colors flex items-center gap-2 text-xs font-medium",
                    viewMode === 'split'
                      ? "bg-theme-accent text-theme-bg" 
                      : "hover:bg-theme-surface text-theme-subtext hover:text-theme-text"
                  )}
                  title={t('edit_modal.split_view_title')}
                >
                  <Columns className="w-4 h-4" />
                  <span className="hidden sm:inline">{t('edit_modal.split')}</span>
                </button>
                <button
                  onClick={() => setViewMode(viewMode === 'preview' ? 'edit' : 'preview')}
                  className={clsx(
                    "p-2 rounded transition-colors flex items-center gap-2 text-xs font-medium",
                    viewMode === 'preview'
                      ? "bg-theme-accent text-theme-bg" 
                      : "hover:bg-theme-surface text-theme-subtext hover:text-theme-text"
                  )}
                  title={t('edit_modal.preview_title')}
                >
                  {viewMode === 'preview' ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  <span className="hidden sm:inline">{viewMode === 'preview' ? t('edit_modal.edit') : t('edit_modal.preview')}</span>
                </button>
              </div>

              <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
                {(viewMode === 'edit' || viewMode === 'split') && (
                  <textarea
                    ref={textareaRef}
                    value={reviewContent}
                    onChange={(e) => setReviewContent(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('edit_modal.markdown_placeholder')}
                    className={clsx(
                      "h-full p-4 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none resize-none font-mono text-sm leading-relaxed",
                      viewMode === 'split' ? "w-1/2" : "w-full flex-1"
                    )}
                  />
                )}
                
                {(viewMode === 'preview' || viewMode === 'split') && (
                    <div className={clsx(
                       "h-full p-4 rounded-xl border bg-theme-surface border-theme-border text-theme-text overflow-y-auto prose prose-sm max-w-none",
                       viewMode === 'split' ? "w-1/2" : "w-full flex-1"
                    )}>
                       <ReactMarkdown>{reviewContent || t('edit_modal.no_content')}</ReactMarkdown>
                    </div>
                 )}
              </div>
              
              <div className="mt-2 text-xs text-theme-subtext flex justify-between">
                <span>{t('edit_modal.markdown_supported')}</span>
                <span className="opacity-50">{reviewContent.length} {t('edit_modal.chars')}</span>
              </div>
            </div>
          )}

          {activeTab === 'cover' && (
            <div className="h-full flex flex-col gap-4">
              <div className="flex gap-4 items-center">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 rounded-lg flex items-center gap-2 transition-colors bg-theme-surface hover:bg-theme-bg text-theme-text border border-theme-border"
                >
                  <Upload className="w-4 h-4" />
                  {t('edit_modal.select_image')}
                </button>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/*"
                  className="hidden"
                />
                {imageSrc && (
                  <button
                    onClick={() => { setImageSrc(null); setZoom(1); }}
                    className="px-4 py-2 rounded-lg flex items-center gap-2 text-theme-subtext hover:bg-theme-surface transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {t('edit_modal.reset')}
                  </button>
                )}
              </div>

              <div className="relative flex-1 bg-theme-subtext/10 rounded-xl overflow-hidden min-h-[300px]">
                {imageSrc ? (
                  <Cropper
                    image={imageSrc}
                    crop={crop}
                    zoom={zoom}
                    aspect={2 / 3} // Standard Poster Aspect Ratio
                    onCropChange={setCrop}
                    onCropComplete={onCropComplete}
                    onZoomChange={setZoom}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-theme-subtext flex-col gap-2">
                    <div className="w-32 h-48 border-2 border-dashed border-theme-border rounded-lg flex items-center justify-center">
                      {t('edit_modal.no_image_selected')}
                    </div>
                    <p className="text-sm">{t('edit_modal.upload_instruction')}</p>
                  </div>
                )}
              </div>
              
              {imageSrc && (
                 <div className="flex items-center gap-2 px-4">
                    <span className="text-sm text-theme-text">{t('edit_modal.zoom')}</span>
                    <input
                      type="range"
                      value={zoom}
                      min={1}
                      max={3}
                      step={0.1}
                      aria-labelledby="Zoom"
                      onChange={(e) => setZoom(Number(e.target.value))}
                      className="w-full h-1 bg-theme-border rounded-lg appearance-none cursor-pointer"
                    />
                 </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex justify-between items-center gap-3 border-theme-border bg-theme-bg">
          <button
            onClick={handleDelete}
            className="px-4 py-2 rounded-lg font-medium text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            {t('edit_modal.delete_card')}
          </button>

          <div className="flex gap-3">
            <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg font-medium transition-colors text-theme-subtext hover:text-theme-text"
            >
                {t('common.cancel')}
            </button>
            <button
                onClick={() => handleSave(false)}
                disabled={isSaving}
                className={clsx(
                "px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors",
                "bg-theme-accent text-theme-bg hover:bg-theme-accent-hover",
                isSaving && "opacity-50 cursor-not-allowed"
                )}
            >
                <Save className="w-4 h-4" />
                {isSaving ? t('common.saving') : t('edit_modal.save_changes')}
            </button>
          </div>
        </div>
      </div>
      {confirmDelete && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="max-w-sm w-full rounded-2xl shadow-2xl border p-6 relative z-10 transition-colors duration-300 bg-theme-surface border-theme-border">
            <div className="text-center mb-4">
              <h3 className="text-lg font-bold text-theme-text">{t('media_card.delete')}</h3>
              <p className="mt-2 text-sm text-theme-subtext">{t('edit_modal.delete_confirm')}</p>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                className="px-4 py-2 rounded-lg font-medium transition-colors bg-theme-surface text-theme-text border border-theme-border hover:bg-theme-bg"
                onClick={() => setConfirmDelete(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="px-4 py-2 rounded-lg font-medium transition-colors bg-theme-accent-warm text-theme-bg hover:bg-theme-accent-warm-2"
                onClick={() => { onDelete(); setConfirmDelete(false); onClose(); }}
              >
                {t('media_card.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
