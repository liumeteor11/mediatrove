import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Sparkles, MessageCircle, BookOpen, Trash2, ChevronRight, Search, Plus, Loader2 } from 'lucide-react';
import { useCharacterStore } from '../store/useCharacterStore';
import { DistillModal } from '../components/character/DistillModal';
import { CharacterDetailModal } from '../components/character/CharacterDetailModal';
import { toast } from 'react-toastify';

/** mm:ss for the background-distillation badge. */
const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export const CharactersPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const characters = useCharacterStore(s => s.characters);
  const sessions = useCharacterStore(s => s.sessions);
  const removeCharacter = useCharacterStore(s => s.removeCharacter);
  const distillTasks = useCharacterStore(s => s.distillTasks);

  const [showDistill, setShowDistill] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Ticks while a background distillation runs so the badge can show its age.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (distillTasks.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [distillTasks.length]);

  useEffect(() => {
    useCharacterStore.getState().initialize();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return characters;
    return characters.filter(
      c =>
        c.name.toLowerCase().includes(q) ||
        c.sourceTitle.toLowerCase().includes(q) ||
        c.aliases.some(a => a.toLowerCase().includes(q))
    );
  }, [characters, query]);

  const detailCharacter = characters.find(c => c.id === detailId) || null;

  const handleDelete = (id: string) => {
    removeCharacter(id);
    setConfirmDeleteId(null);
    setDetailId(null);
    toast.success(t('characters.deleted'));
  };

  const sessionCount = (characterId: string) => sessions.filter(s => s.characterId === characterId).length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-theme-text flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-theme-accent" />
            {t('characters.title')}
          </h1>
          <p className="text-sm text-theme-subtext mt-1">{t('characters.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:flex-none">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-theme-subtext" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('characters.search_placeholder')}
              className="pl-9 pr-3 py-2 rounded-lg bg-theme-surface border border-theme-border text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent w-full sm:w-44"
            />
          </div>
          <button
            onClick={() => setShowDistill(true)}
            className="p-2 rounded-lg border bg-theme-surface border-theme-border text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors flex items-center justify-center"
            title={t('characters.add_character')}
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20 rounded-theme border border-dashed border-theme-border">
          <Sparkles className="w-12 h-12 mx-auto text-theme-subtext/50 mb-4" />
          <h3 className="text-lg font-medium text-theme-text">{t('characters.empty_title')}</h3>
          <p className="text-sm text-theme-subtext mt-1 max-w-md mx-auto">{t('characters.empty_desc')}</p>
          <button
            onClick={() => setShowDistill(true)}
            className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-theme text-sm font-medium bg-theme-accent text-theme-bg hover:bg-theme-accent-hover"
          >
            <Sparkles className="w-4 h-4" />
            {t('characters.distill')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4">
          {filtered.map((character, index) => {
            return (
              <motion.div
                key={character.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index * 0.05, 0.4), duration: 0.4 }}
                className="group bg-theme-surface border-2 border-theme-border rounded-theme shadow-theme p-3 md:p-4 flex flex-col transition-all duration-300 hover:border-theme-accent md:hover:scale-[1.02] md:hover:shadow-2xl"
              >
                <div className="flex items-start gap-2.5 md:gap-3">
                  <div className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-theme-accent text-theme-bg flex items-center justify-center text-lg md:text-xl font-bold flex-shrink-0">
                    {character.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm md:text-base font-semibold text-theme-text truncate">{character.name}</h3>
                    <p className="text-xs text-theme-subtext flex items-center gap-1 truncate">
                      <BookOpen className="w-3 h-3 flex-shrink-0" />
                      {character.sourceTitle}
                    </p>
                  </div>
                  {character.sourceType && (
                    <span className="flex-shrink-0 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-theme-accent text-theme-bg rounded-sm ring-1 ring-theme-accent/50 shadow-md">
                      {t(`media_type.${character.sourceType}`, { defaultValue: character.sourceType })}
                    </span>
                  )}
                </div>

                <div className="mt-auto pt-2.5 md:pt-4 flex items-center justify-between gap-1.5 md:gap-2">
                  <span className="text-xs text-theme-subtext">
                    {t('characters.session_count', { count: sessionCount(character.id) })}
                    {character.corrections.length > 0 && ` · ${t('characters.correction_count', { count: character.corrections.length })}`}
                  </span>
                  <div className="flex items-center gap-0.5 md:gap-1">
                    <button
                      onClick={() => navigate(`/characters/${character.id}`)}
                      className="p-1.5 md:p-2 rounded-theme text-theme-accent hover:bg-theme-bg"
                      title={t('characters.start_chat')}
                      aria-label={`${t('characters.start_chat')}: ${character.name}`}
                    >
                      <MessageCircle className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(character.id)}
                      className="p-1.5 md:p-2 rounded-theme text-theme-subtext hover:text-theme-accent-warm hover:bg-theme-bg"
                      title={t('common.delete')}
                      aria-label={`${t('common.delete')}: ${character.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setDetailId(character.id)}
                      className="p-1.5 md:p-2 rounded-theme text-theme-subtext hover:text-theme-text hover:bg-theme-bg"
                      title={t('characters.view_profile')}
                      aria-label={`${t('characters.view_profile')}: ${character.name}`}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      <DistillModal isOpen={showDistill} onClose={() => setShowDistill(false)} />

      {/* Background distillations: the dialog is already closed, these stay until done */}
      {distillTasks.length > 0 && (
        <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 items-end pointer-events-none">
          {distillTasks.map(task => (
            <div
              key={task.id}
              className="pointer-events-auto flex items-center gap-2 px-3.5 py-2.5 rounded-theme border border-theme-border bg-theme-surface shadow-theme text-sm text-theme-text"
            >
              <Loader2 className="w-4 h-4 animate-spin text-theme-accent flex-shrink-0" />
              <span>{t('characters.distilling_named', { name: task.label })}</span>
              <span className="text-xs text-theme-subtext tabular-nums">{formatElapsed(now - task.startedAt)}</span>
            </div>
          ))}
        </div>
      )}

      {detailCharacter && (
        <CharacterDetailModal
          character={detailCharacter}
          onClose={() => setDetailId(null)}
          onChat={(id) => {
            setDetailId(null);
            navigate(`/characters/${id}`);
          }}
          onDelete={handleDelete}
        />
      )}

      {confirmDeleteId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm p-4">
          <div className="bg-theme-surface border border-theme-border rounded-theme max-w-sm w-full p-5 text-theme-text">
            <h3 className="font-semibold mb-2">
              {t('characters.delete_confirm_title', { name: characters.find(c => c.id === confirmDeleteId)?.name || '' })}
            </h3>
            <p className="text-sm text-theme-subtext mb-4">{t('characters.delete_confirm_desc')}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-4 py-2 rounded-theme text-sm border border-theme-border text-theme-subtext hover:bg-theme-bg"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleDelete(confirmDeleteId)}
                className="px-4 py-2 rounded-theme text-sm font-medium bg-theme-accent-warm text-theme-bg hover:bg-theme-accent-warm-2"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
