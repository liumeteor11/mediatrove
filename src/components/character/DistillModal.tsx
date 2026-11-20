import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, X, Loader2, AlertTriangle, Users, RefreshCw } from 'lucide-react';
import { useCollectionStore } from '../../store/useCollectionStore';
import { useCharacterStore } from '../../store/useCharacterStore';
import { useAIStore } from '../../store/useAIStore';
import { suggestCharacterNames } from '../../services/characterService';
import { describeAIError } from '../../services/aiService';
import { MediaItem, MediaType } from '../../types/types';
import { useEscapeToClose } from '../../hooks/useEscapeToClose';

interface DistillModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const MANUAL_WORK = '__manual__';

/** Build a synthetic source item for a manually typed work title. */
const buildManualItem = (title: string): MediaItem => ({
  id: `manual-${title.trim().toLowerCase().replace(/\s+/g, '-')}`,
  title: title.trim(),
  directorOrAuthor: '',
  description: '',
  releaseDate: '',
  type: MediaType.OTHER,
  isOngoing: false,
  cast: [],
});

export const DistillModal: React.FC<DistillModalProps> = ({ isOpen, onClose }) => {
  const { t, i18n } = useTranslation();
  const collection = useCollectionStore(s => s.collection);
  const startDistill = useCharacterStore(s => s.startDistill);
  const apiKey = useAIStore(s => s.apiKey);
  useEscapeToClose(onClose, isOpen);

  const [workSelection, setWorkSelection] = useState<string>('');
  const [manualTitle, setManualTitle] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [extraMaterial, setExtraMaterial] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sortedCollection = useMemo(
    () =>
      [...collection].sort((a, b) => {
        const at = a.savedAt || 0;
        const bt = b.savedAt || 0;
        return bt - at;
      }),
    [collection]
  );

  // No collection works to pick from -> manual entry is the only option.
  const isManual = workSelection === MANUAL_WORK || sortedCollection.length === 0;

  const hasKey = !!apiKey;
  const language: 'zh' | 'en' = (i18n.language || 'en').startsWith('zh') ? 'zh' : 'en';

  const currentItem = useMemo<MediaItem | undefined>(() => {
    if (!isManual) return collection.find(i => i.id === workSelection);
    const title = manualTitle.trim();
    return title ? buildManualItem(title) : undefined;
  }, [isManual, manualTitle, collection, workSelection]);

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggestNonce, setSuggestNonce] = useState(0);
  const forceRefreshRef = useRef(false);

  // Look the cast up as soon as a work is known: TMDb credits are instant, the
  // model's own list follows (with web search for works it may not know).
  useEffect(() => {
    if (!isOpen || !hasKey || !currentItem) {
      setSuggestions([]);
      setSuggestError(null);
      setIsSuggesting(false);
      return;
    }
    let cancelled = false;
    setIsSuggesting(true);
    setSuggestError(null);
    const timer = setTimeout(async () => {
      const refresh = forceRefreshRef.current;
      forceRefreshRef.current = false;
      try {
        const { fromCredits, fromAI } = await suggestCharacterNames(currentItem, { language, refresh });
        if (cancelled) return;
        const seen = new Set<string>();
        setSuggestions(
          [...fromCredits, ...fromAI].filter(name => {
            const key = name.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
        );
      } catch (e) {
        if (cancelled) return;
        console.error('Character suggestions failed', e);
        setSuggestions([]);
        const { auth, detail } = describeAIError(e);
        setSuggestError(auth
          ? t('characters.error_key_rejected')
          : t('characters.suggest_failed', { detail: detail.slice(0, 120) }));
      } finally {
        if (!cancelled) setIsSuggesting(false);
      }
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, hasKey, currentItem, language, suggestNonce, t]);

  if (!isOpen) return null;

  const handleDistill = () => {
    const name = characterName.trim();
    let item: MediaItem | undefined;
    if (!isManual) {
      item = collection.find(i => i.id === workSelection);
    } else if (manualTitle.trim()) {
      item = buildManualItem(manualTitle);
    }
    if (!item) {
      setError(t(isManual ? 'characters.error_enter_work' : 'characters.error_select_work'));
      return;
    }
    if (!name) {
      setError(t('characters.error_character_name'));
      return;
    }
    setError(null);
    // Runs in the background: the dialog closes right away and the characters
    // page keeps a progress badge until the profile lands (or fails).
    startDistill(item, { characterName: name, extraMaterial, maxCharacters: 1, language });
    onClose();
  };

  const inputClass =
    'w-full px-3 py-2 rounded-theme bg-theme-bg border border-theme-border focus:outline-none focus:ring-2 focus:ring-theme-accent text-sm';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('characters.distill_title')}
        className="bg-theme-surface border border-theme-border rounded-theme max-w-lg w-full max-h-[90vh] overflow-y-auto text-theme-text"
      >
        <div className="flex items-center justify-between p-4 border-b border-theme-border sticky top-0 bg-theme-surface">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-theme-accent" />
            <h3 className="font-semibold">{t('characters.distill_title')}</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-theme hover:bg-theme-bg text-theme-subtext" aria-label="close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-theme-subtext">{t('characters.distill_desc')}</p>

          {!hasKey && (
            <div className="flex items-start gap-2 p-3 rounded-theme bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{t('characters.error_no_key')}</span>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">{t('characters.select_work')}</label>
            {sortedCollection.length > 0 && (
              <select
                value={isManual ? MANUAL_WORK : workSelection}
                onChange={(e) => setWorkSelection(e.target.value)}
                className={`${inputClass} mb-2`}
              >
                <option value="">{t('characters.select_work_placeholder')}</option>
                {sortedCollection.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.title} · {t(`media_type.${item.type}`, { defaultValue: item.type })}
                  </option>
                ))}
                <option value={MANUAL_WORK}>{t('characters.select_work_manual')}</option>
              </select>
            )}
            {isManual && (
              <input
                type="text"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder={t('characters.work_name_placeholder')}
                className={inputClass}
              />
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">{t('characters.character_name')}</label>
            <input
              type="text"
              value={characterName}
              onChange={(e) => setCharacterName(e.target.value)}
              placeholder={t('characters.character_name_placeholder')}
              className={inputClass}
            />
            {(isSuggesting || suggestions.length > 0 || suggestError || (currentItem && !hasKey)) && (
              <div className="mt-2 rounded-theme border border-theme-border bg-theme-bg/40 p-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-theme-subtext flex items-center gap-1">
                    {isSuggesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Users className="w-3 h-3" />}
                    {isSuggesting ? t('characters.suggest_loading') : t('characters.suggest_label')}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      forceRefreshRef.current = true;
                      setSuggestNonce(n => n + 1);
                    }}
                    disabled={isSuggesting || !hasKey}
                    className="text-xs text-theme-subtext hover:text-theme-accent flex items-center gap-1 disabled:opacity-50"
                  >
                    <RefreshCw className="w-3 h-3" />
                    {t('characters.suggest_retry')}
                  </button>
                </div>
                {!hasKey ? (
                  <p className="text-xs text-theme-subtext">{t('characters.suggest_need_key')}</p>
                ) : suggestError ? (
                  <p className="text-xs text-theme-accent-warm">{suggestError}</p>
                ) : suggestions.length === 0 && !isSuggesting ? (
                  <p className="text-xs text-theme-subtext">{t('characters.suggest_empty')}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map(name => {
                      const active = characterName.trim() === name;
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() => setCharacterName(active ? '' : name)}
                          className={`px-3 py-1 rounded-full border text-xs transition-colors ${
                            active
                              ? 'bg-theme-accent text-theme-bg border-theme-accent'
                              : 'bg-theme-surface border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent'
                          }`}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-theme-subtext/70 mt-1.5">{t('characters.suggest_hint')}</p>
              </div>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('characters.extra_material')}</label>
            <textarea
              value={extraMaterial}
              onChange={(e) => setExtraMaterial(e.target.value)}
              rows={4}
              placeholder={t('characters.extra_material_hint')}
              className={`${inputClass} resize-y`}
            />
            <p className="text-xs text-theme-subtext mt-1">{t('characters.extra_material_note')}</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-theme bg-theme-accent-warm/10 text-theme-accent-warm text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-theme-border">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-theme text-sm border border-theme-border text-theme-subtext hover:bg-theme-bg disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleDistill}
            disabled={(isManual ? !manualTitle.trim() : !workSelection) || !characterName.trim() || !hasKey}
            className="flex items-center gap-2 px-4 py-2 rounded-theme text-sm font-medium bg-theme-accent text-theme-bg hover:bg-theme-accent-hover disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4" />
            {t('characters.distill')}
          </button>
        </div>
      </div>
    </div>
  );
};
