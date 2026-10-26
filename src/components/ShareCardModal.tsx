import React, { useRef, useState } from 'react';
import { X, Download, Share2 } from 'lucide-react';
import { MediaItem } from '../types/types';
import html2canvas from 'html2canvas';
import { useTranslation } from 'react-i18next';
import { useThemeStore } from '../store/useThemeStore';
import clsx from 'clsx';
import { FALLBACK_POSTER } from '../services/aiService';

interface ShareCardModalProps {
  item: MediaItem;
  onClose: () => void;
}

export const ShareCardModal: React.FC<ShareCardModalProps> = ({ item, onClose }) => {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const { theme } = useThemeStore();

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

  const handleDownload = async () => {
    if (!cardRef.current) return;
    setIsGenerating(true);
    try {
      const canvas = await html2canvas(cardRef.current, {
        useCORS: true,
        backgroundColor: null,
        scale: 2 // Retain high quality
      });
      
      const link = document.createElement('a');
      link.download = `${item.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-share-card.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (e) {
      console.error("Failed to generate share card", e);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="relative w-full max-w-md bg-theme-surface rounded-2xl shadow-2xl overflow-hidden border border-theme-border flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-theme-border">
          <h3 className="text-lg font-bold text-theme-text flex items-center gap-2">
            <Share2 className="w-5 h-5 text-theme-accent" />
            {t('share_card.title')}
          </h3>
          <button 
            onClick={onClose}
            className="p-1 rounded-full hover:bg-theme-bg text-theme-subtext transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Preview */}
        <div className="flex-1 overflow-y-auto p-6 flex justify-center bg-neutral-900/50">
          <div 
            ref={cardRef}
            className={clsx(
                "w-[300px] bg-theme-surface rounded-xl overflow-hidden shadow-2xl relative border border-theme-border/50 shrink-0",
                theme === 'cyberpunk' && "border-theme-accent shadow-[0_0_15px_rgba(0,255,255,0.3)]"
            )}
          >
            {/* Poster Image */}
            <div className="relative aspect-[2/3] w-full">
                <img 
                    src={normalizeImgSrc(item.customPosterUrl || item.posterUrl) || FALLBACK_POSTER} 
                    alt={item.title}
                    className="w-full h-full object-cover"
                    crossOrigin="anonymous" 
                    referrerPolicy="no-referrer"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent" />
                
                <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
                    <h2 className="text-xl font-bold leading-tight mb-1 text-shadow-sm">{item.title}</h2>
                    <p className="text-xs opacity-80">{item.releaseDate ? item.releaseDate.substring(0, 4) : ''} • {item.type}</p>
                </div>

                {/* Rating Badge */}
                {(item.userRating || item.rating) && (
                    <div className="absolute top-3 right-3 bg-black/60 backdrop-blur px-2 py-1 rounded-lg border border-white/20 text-yellow-400 font-bold text-sm">
                        ★ {item.userRating || item.rating}
                    </div>
                )}
            </div>

            {/* Details Section */}
            <div className="p-4 bg-theme-surface text-theme-text">
                {item.userReview ? (
                    <div className="mb-4">
                        <div className="text-xs text-theme-subtext uppercase tracking-wider mb-1">{t('share_card.my_review')}</div>
                        <p className="text-sm italic leading-relaxed text-theme-text/90 line-clamp-4 font-serif">
                            "{item.userReview}"
                        </p>
                    </div>
                ) : (
                    <p className="text-sm text-theme-subtext line-clamp-3 mb-4">
                        {item.description}
                    </p>
                )}
                
                {/* Footer / Branding */}
                <div className="flex items-center justify-between pt-3 border-t border-theme-border/50">
                     <div className="flex items-center gap-1.5">
                        <div className="w-6 h-6 rounded bg-theme-accent flex items-center justify-center text-theme-bg font-bold text-xs">
                            M
                        </div>
                        <span className="text-xs font-bold text-theme-text/80">{t('share_card.branding')}</span>
                     </div>
                     <div className="text-[10px] text-theme-subtext">
                        {new Date().toLocaleDateString()}
                     </div>
                </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-theme-border bg-theme-surface flex justify-end gap-3">
             <button 
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-medium text-theme-text hover:bg-theme-bg transition-colors"
             >
                {t('common.cancel')}
             </button>
             <button 
                onClick={handleDownload}
                disabled={isGenerating}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-theme-accent text-theme-bg hover:bg-theme-accent-hover flex items-center gap-2 transition-colors disabled:opacity-50"
             >
                {isGenerating ? (
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-b-transparent border-white" />
                ) : (
                    <Download className="w-4 h-4" />
                )}
                {t('share_card.download')}
             </button>
        </div>
      </div>
    </div>
  );
};
