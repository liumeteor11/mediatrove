import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, MessageCircle, Trash2, ShieldAlert, Plus, History, ChevronDown } from 'lucide-react';
import { DistilledCharacter } from '../../types/character';
import { useCharacterStore } from '../../store/useCharacterStore';
import { useEscapeToClose } from '../../hooks/useEscapeToClose';

interface CharacterDetailModalProps {
  character: DistilledCharacter;
  onClose: () => void;
  onChat: (characterId: string) => void;
  onDelete: (characterId: string) => void;
}

const SECTION_IDS = [
  'personality', 'background', 'appearance', 'mentalModels', 'decisionHeuristics',
  'interpersonal', 'boundaries', 'expression', 'relationships', 'quotes',
  'externalViews', 'timeline', 'corrections',
] as const;

type SectionId = (typeof SECTION_IDS)[number];

const Section: React.FC<{
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, open, onToggle, children }) => (
  <div>
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="w-full flex items-center justify-between gap-2 text-left"
    >
      <h4 className="text-xs font-semibold uppercase tracking-wider text-theme-subtext">{title}</h4>
      <ChevronDown className={`w-4 h-4 flex-shrink-0 text-theme-subtext transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="mt-2 text-sm space-y-1.5">{children}</div>}
  </div>
);

const ChipList: React.FC<{ items: string[] }> = ({ items }) => (
  <div className="flex flex-wrap gap-1.5">
    {items.map((item, i) => (
      <span key={i} className="px-2 py-0.5 rounded-full bg-theme-bg border border-theme-border text-xs">
        {item}
      </span>
    ))}
  </div>
);

export const CharacterDetailModal: React.FC<CharacterDetailModalProps> = ({ character, onClose, onChat, onDelete }) => {
  const { t } = useTranslation();
  const addCorrection = useCharacterStore(s => s.addCorrection);
  const removeCorrection = useCharacterStore(s => s.removeCorrection);
  useEscapeToClose(onClose);
  const [showCorrectionForm, setShowCorrectionForm] = useState(false);
  const [scene, setScene] = useState('');
  const [wrong, setWrong] = useState('');
  const [correct, setCorrect] = useState('');
  // Persona sections are hidden by default; clicking a section title reveals it.
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  const toggle = (id: SectionId) => setOpenMap(m => ({ ...m, [id]: !m[id] }));
  const anyOpen = SECTION_IDS.some(id => openMap[id]);
  const toggleAll = () =>
    setOpenMap(anyOpen ? {} : Object.fromEntries(SECTION_IDS.map(id => [id, true])));

  const e = character.expression;

  const submitCorrection = () => {
    if (!scene.trim() || !correct.trim()) return;
    addCorrection(character.id, { scene: scene.trim(), wrong: wrong.trim() || '-', correct: correct.trim() });
    setScene('');
    setWrong('');
    setCorrect('');
    setShowCorrectionForm(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm p-4">
      <div className="bg-theme-surface border border-theme-border rounded-theme max-w-2xl w-full max-h-[90vh] flex flex-col text-theme-text">
        <div className="flex items-start justify-between p-4 border-b border-theme-border">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-full bg-theme-accent text-theme-bg flex items-center justify-center text-lg font-bold flex-shrink-0">
              {character.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold truncate">{character.name}</h3>
              <p className="text-xs text-theme-subtext truncate">
                {t('characters.from_work', { work: character.sourceTitle })} · v{character.version}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-theme hover:bg-theme-bg text-theme-subtext" aria-label="close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-4">
          {character.tagline && <p className="text-sm italic text-theme-subtext">“{character.tagline}”</p>}

          <div className="flex items-center justify-between">
            <p className="text-xs text-theme-subtext">{t('characters.profile_hint')}</p>
            <button
              onClick={toggleAll}
              className="flex-shrink-0 ml-3 flex items-center gap-1 text-xs text-theme-accent hover:underline"
            >
              <History className="w-3.5 h-3.5" />
              {anyOpen ? t('characters.collapse_all') : t('characters.expand_all')}
            </button>
          </div>

          {character.personality.length > 0 && (
            <Section title={t('characters.section_personality')} open={!!openMap.personality} onToggle={() => toggle('personality')}>
              <ChipList items={character.personality} />
            </Section>
          )}

          {character.background && (
            <Section title={t('characters.section_background')} open={!!openMap.background} onToggle={() => toggle('background')}>
              <p className="leading-relaxed">{character.background}</p>
            </Section>
          )}

          {character.appearance && (
            <Section title={t('characters.section_appearance')} open={!!openMap.appearance} onToggle={() => toggle('appearance')}>
              <p className="leading-relaxed">{character.appearance}</p>
            </Section>
          )}

          {character.mentalModels.length > 0 && (
            <Section title={t('characters.section_mental_models')} open={!!openMap.mentalModels} onToggle={() => toggle('mentalModels')}>
              <ul className="list-disc list-inside space-y-1">
                {character.mentalModels.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </Section>
          )}

          {character.decisionHeuristics.length > 0 && (
            <Section title={t('characters.section_decision_heuristics')} open={!!openMap.decisionHeuristics} onToggle={() => toggle('decisionHeuristics')}>
              <ul className="list-disc list-inside space-y-1">
                {character.decisionHeuristics.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </Section>
          )}

          {character.interpersonal && (
            <Section title={t('characters.section_interpersonal')} open={!!openMap.interpersonal} onToggle={() => toggle('interpersonal')}>
              <p className="leading-relaxed">{character.interpersonal}</p>
            </Section>
          )}

          {character.boundaries.length > 0 && (
            <Section title={t('characters.section_boundaries')} open={!!openMap.boundaries} onToggle={() => toggle('boundaries')}>
              <ul className="list-disc list-inside space-y-1">
                {character.boundaries.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </Section>
          )}

          {e && (
            <Section title={t('characters.section_expression')} open={!!openMap.expression} onToggle={() => toggle('expression')}>
              <div className="space-y-2">
                {e.tone && <p><span className="text-theme-subtext">{t('characters.expression_tone')}: </span>{e.tone}</p>}
                {e.sentenceStyle && <p><span className="text-theme-subtext">{t('characters.expression_sentence')}: </span>{e.sentenceStyle}</p>}
                {e.catchphrases.length > 0 && (
                  <div>
                    <span className="text-theme-subtext text-xs">{t('characters.expression_catchphrases')}</span>
                    <div className="mt-1"><ChipList items={e.catchphrases} /></div>
                  </div>
                )}
                {e.exampleLines.length > 0 && (
                  <div className="pl-3 border-l-2 border-theme-border space-y-1">
                    {e.exampleLines.map((line, i) => <p key={i} className="italic text-theme-subtext">{line}</p>)}
                  </div>
                )}
              </div>
            </Section>
          )}

          {character.relationships.length > 0 && (
            <Section title={t('characters.section_relationships')} open={!!openMap.relationships} onToggle={() => toggle('relationships')}>
              <ul className="space-y-1">
                {character.relationships.map((r, i) => (
                  <li key={i}><span className="font-medium">{r.name}</span> — {r.relation}</li>
                ))}
              </ul>
            </Section>
          )}

          {character.quotes.length > 0 && (
            <Section title={t('characters.section_quotes')} open={!!openMap.quotes} onToggle={() => toggle('quotes')}>
              <div className="space-y-1">
                {character.quotes.map((q, i) => <p key={i} className="italic">“{q}”</p>)}
              </div>
            </Section>
          )}

          {character.externalViews.length > 0 && (
            <Section title={t('characters.section_external_views')} open={!!openMap.externalViews} onToggle={() => toggle('externalViews')}>
              <ul className="list-disc list-inside space-y-1">
                {character.externalViews.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </Section>
          )}

          {character.timeline.length > 0 && (
            <Section title={t('characters.section_timeline')} open={!!openMap.timeline} onToggle={() => toggle('timeline')}>
              <ul className="space-y-1.5">
                {character.timeline.map((ev, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-theme-accent font-medium flex-shrink-0 w-20">{ev.period}</span>
                    <span>{ev.event}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={t('characters.section_corrections')} open={!!openMap.corrections} onToggle={() => toggle('corrections')}>
            <div className="space-y-2">
              {character.corrections.length === 0 && (
                <p className="text-xs text-theme-subtext">{t('characters.no_corrections')}</p>
              )}
              {character.corrections.map((c, i) => (
                <div key={i} className="flex items-start gap-2 p-2 rounded-theme bg-theme-bg border border-theme-border">
                  <ShieldAlert className="w-4 h-4 mt-0.5 text-yellow-500 flex-shrink-0" />
                  <div className="text-xs flex-1 min-w-0">
                    <p className="font-medium">{c.scene}</p>
                    <p className="text-theme-subtext line-through">{c.wrong}</p>
                    <p className="text-green-600 dark:text-green-400">{c.correct}</p>
                  </div>
                  <button
                    onClick={() => removeCorrection(character.id, i)}
                    title={t('characters.correction_delete')}
                    aria-label={t('characters.correction_delete')}
                    className="p-1.5 rounded-theme text-theme-subtext hover:text-theme-accent-warm hover:bg-theme-surface flex-shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              {showCorrectionForm ? (
                <div className="p-3 rounded-theme bg-theme-bg border border-theme-border space-y-2">
                  <input
                    value={scene}
                    onChange={(ev) => setScene(ev.target.value)}
                    placeholder={t('characters.correction_scene')}
                    className="w-full px-3 py-1.5 rounded-theme bg-theme-surface border border-theme-border text-sm focus:outline-none focus:ring-2 focus:ring-theme-accent"
                  />
                  <input
                    value={wrong}
                    onChange={(ev) => setWrong(ev.target.value)}
                    placeholder={t('characters.correction_wrong')}
                    className="w-full px-3 py-1.5 rounded-theme bg-theme-surface border border-theme-border text-sm focus:outline-none focus:ring-2 focus:ring-theme-accent"
                  />
                  <input
                    value={correct}
                    onChange={(ev) => setCorrect(ev.target.value)}
                    placeholder={t('characters.correction_correct')}
                    className="w-full px-3 py-1.5 rounded-theme bg-theme-surface border border-theme-border text-sm focus:outline-none focus:ring-2 focus:ring-theme-accent"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setShowCorrectionForm(false)} className="px-3 py-1 text-xs rounded-theme border border-theme-border text-theme-subtext">
                      {t('common.cancel')}
                    </button>
                    <button onClick={submitCorrection} className="px-3 py-1 text-xs rounded-theme bg-theme-accent text-theme-bg font-medium">
                      {t('characters.correction_save')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowCorrectionForm(true)}
                  className="flex items-center gap-1 text-xs text-theme-accent hover:underline"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t('characters.add_correction')}
                </button>
              )}
            </div>
          </Section>
        </div>

        <div className="flex items-center justify-between p-4 border-t border-theme-border">
          <button
            onClick={() => onDelete(character.id)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-theme text-sm text-theme-accent-warm hover:bg-theme-accent-warm/10"
          >
            <Trash2 className="w-4 h-4" />
            {t('common.delete')}
          </button>
          <button
            onClick={() => onChat(character.id)}
            className="flex items-center gap-2 px-4 py-2 rounded-theme text-sm font-medium bg-theme-accent text-theme-bg hover:bg-theme-accent-hover"
          >
            <MessageCircle className="w-4 h-4" />
            {t('characters.start_chat')}
          </button>
        </div>
      </div>
    </div>
  );
};
