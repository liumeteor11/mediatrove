import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import {
  ArrowLeft, Plus, MessageCircle, Trash2, Pencil, Send, Loader2,
  ShieldAlert, BookOpen, Check, X, Sparkles,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useCharacterStore } from '../store/useCharacterStore';
import { ChatMessage, ChatSession } from '../types/character';
import { compactSession, sendCharacterMessage } from '../services/characterService';
import { describeAIError } from '../services/aiService';
import { v4 as uuidv4 } from 'uuid';

const deriveTitle = (text: string): string => text.trim().replace(/\s+/g, ' ').slice(0, 24);

export const CharacterChatPage: React.FC = () => {
  const { characterId } = useParams<{ characterId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const character = useCharacterStore(s => s.characters.find(c => c.id === characterId));
  const allSessions = useCharacterStore(s => s.sessions);
  // zustand v5 selectors must return stable references; filtering here would
  // return a fresh array every render and loop React into "max update depth".
  const sessions = useMemo(
    () => allSessions.filter(x => x.characterId === characterId),
    [allSessions, characterId]
  );
  const updateSession = useCharacterStore(s => s.updateSession);
  const createSession = useCharacterStore(s => s.createSession);
  const removeSession = useCharacterStore(s => s.removeSession);
  const renameSession = useCharacterStore(s => s.renameSession);
  const addCorrection = useCharacterStore(s => s.addCorrection);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [input, setInput] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [showCorrection, setShowCorrection] = useState(false);
  const [correction, setCorrection] = useState({ scene: '', wrong: '', correct: '' });

  const bootstrappedRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeSession: ChatSession | undefined = useMemo(
    () => sessions.find(s => s.id === activeId) || sessions[0],
    [sessions, activeId]
  );

  // Ensure at least one session exists per character (seeded with the greeting).
  useEffect(() => {
    if (!character) return;
    if (bootstrappedRef.current === character.id) return;
    bootstrappedRef.current = character.id;
    if (sessions.length === 0) {
      const session = createSession(character.id);
      setActiveId(session.id);
    }
  }, [character, sessions.length, createSession]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages.length, pending]);

  // Keep the viewport pinned to the newest tokens while streaming.
  useEffect(() => {
    if (pending) bottomRef.current?.scrollIntoView();
  }, [streamText, pending]);

  const handleSend = useCallback(async () => {
    if (!character || !activeSession || pending) return;
    const text = input.trim();
    if (!text) return;

    const userMessage: ChatMessage = { id: uuidv4(), role: 'user', content: text, createdAt: Date.now() };
    let working: ChatSession = {
      ...activeSession,
      messages: [...activeSession.messages, userMessage],
      title:
        activeSession.messages.filter(m => m.role === 'user').length === 0
          ? deriveTitle(text)
          : activeSession.title,
    };
    setInput('');
    setStreamText('');
    setPending(true);
    updateSession(working);

    try {
      // Fold old turns into the rolling summary before growing the window.
      const compaction = await compactSession(character, working);
      if (compaction) {
        working = { ...working, ...compaction };
        updateSession(working);
      }
      const reply = await sendCharacterMessage(character, working, (delta) => {
        setStreamText(prev => prev + delta);
      });
      const assistantMessage: ChatMessage = { id: uuidv4(), role: 'assistant', content: reply, createdAt: Date.now() };
      updateSession({ ...working, messages: [...working.messages, assistantMessage] });
    } catch (e) {
      console.error('Character chat failed', e);
      const { auth, detail } = describeAIError(e);
      const messageKey = auth ? 'character_chat.reply_failed_auth'
        : detail.includes('no-api-key') ? 'character_chat.reply_no_key'
        : detail.includes('empty-ai-response') ? 'character_chat.reply_empty'
        : detail ? 'character_chat.reply_failed_detail'
        : 'character_chat.reply_failed';
      toast.error(t(messageKey, { detail: detail.slice(0, 180) }));
    } finally {
      setStreamText('');
      setPending(false);
      inputRef.current?.focus();
    }
  }, [character, activeSession, pending, input, updateSession, t]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const submitCorrection = () => {
    if (!character || !correction.scene.trim() || !correction.correct.trim()) return;
    addCorrection(character.id, {
      scene: correction.scene.trim(),
      wrong: correction.wrong.trim() || '-',
      correct: correction.correct.trim(),
    });
    setCorrection({ scene: '', wrong: '', correct: '' });
    setShowCorrection(false);
    toast.success(t('characters.correction_saved'));
  };

  if (!character) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <p className="text-theme-subtext mb-4">{t('character_chat.character_not_found')}</p>
        <button
          onClick={() => navigate('/characters')}
          className="px-4 py-2 rounded-theme text-sm font-medium bg-theme-accent text-theme-bg hover:bg-theme-accent-hover"
        >
          {t('character_chat.back_to_characters')}
        </button>
      </div>
    );
  }

  const messages = activeSession?.messages || [];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 h-[calc(100vh-4rem)] flex flex-col">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => navigate('/characters')}
          className="p-2 rounded-theme text-theme-subtext hover:text-theme-text hover:bg-theme-surface"
          title={t('character_chat.back_to_characters')}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="w-10 h-10 rounded-full bg-theme-accent text-theme-bg flex items-center justify-center text-lg font-bold flex-shrink-0">
          {character.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-semibold text-theme-text truncate">{character.name}</h1>
          <p className="text-xs text-theme-subtext flex items-center gap-1 truncate">
            <BookOpen className="w-3 h-3 flex-shrink-0" />
            {t('characters.from_work', { work: character.sourceTitle })} · v{character.version}
          </p>
        </div>
        <button
          onClick={() => setShowCorrection(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-theme text-sm border border-theme-border text-theme-subtext hover:text-theme-text hover:bg-theme-surface"
          title={t('character_chat.adjust_persona')}
        >
          <ShieldAlert className="w-4 h-4" />
          <span className="hidden sm:inline">{t('character_chat.adjust_persona')}</span>
        </button>
      </div>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Session list */}
        <aside className="hidden md:flex flex-col w-56 flex-shrink-0 border border-theme-border rounded-theme bg-theme-surface">
          <button
            onClick={() => {
              const session = createSession(character.id);
              setActiveId(session.id);
            }}
            className="flex items-center gap-2 m-2 px-3 py-2 rounded-theme text-sm font-medium bg-theme-accent text-theme-bg hover:bg-theme-accent-hover"
          >
            <Plus className="w-4 h-4" />
            {t('character_chat.new_session')}
          </button>
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
            {sessions.map(session => (
              <div
                key={session.id}
                className={`group flex items-center gap-1 px-2 py-2 rounded-theme text-sm cursor-pointer transition-colors ${
                  activeSession?.id === session.id
                    ? 'bg-theme-accent/10 text-theme-text border border-theme-accent/40'
                    : 'text-theme-subtext hover:bg-theme-bg border border-transparent'
                }`}
                onClick={() => setActiveId(session.id)}
              >
                {renamingId === session.id ? (
                  <>
                    <input
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          renameSession(session.id, renameText);
                          setRenamingId(null);
                        } else if (e.key === 'Escape') {
                          setRenamingId(null);
                        }
                      }}
                      className="flex-1 min-w-0 px-1 py-0.5 rounded bg-theme-bg border border-theme-border text-xs focus:outline-none"
                    />
                    <button
                      onClick={(e) => { e.stopPropagation(); renameSession(session.id, renameText); setRenamingId(null); }}
                      className="p-0.5 text-theme-accent"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setRenamingId(null); }} className="p-0.5">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <MessageCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{session.title}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenamingId(session.id); setRenameText(session.title); }}
                      className="p-0.5 opacity-0 group-hover:opacity-100 hover:text-theme-text"
                      title={t('character_chat.rename')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeSession(session.id); if (activeSession?.id === session.id) setActiveId(null); }}
                      className="p-0.5 opacity-0 group-hover:opacity-100 hover:text-theme-accent-warm"
                      title={t('character_chat.delete_session')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          {character.corrections.length > 0 && (
            <div className="p-2 border-t border-theme-border">
              <p className="flex items-center gap-1 text-xs text-theme-subtext">
                <ShieldAlert className="w-3 h-3 text-yellow-500" />
                {t('characters.correction_count', { count: character.corrections.length })}
              </p>
            </div>
          )}
        </aside>

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0 border border-theme-border rounded-theme bg-theme-surface">
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && !pending && (
              <div className="h-full flex flex-col items-center justify-center text-center py-10">
                <Sparkles className="w-10 h-10 text-theme-subtext/40 mb-3" />
                <p className="text-theme-text font-medium">{t('character_chat.empty_title', { name: character.name })}</p>
                <p className="text-sm text-theme-subtext mt-1 max-w-sm">{t('character_chat.empty_desc')}</p>
              </div>
            )}
            {messages.map(message => (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] sm:max-w-[70%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    message.role === 'user'
                      ? 'bg-theme-accent text-theme-bg rounded-br-sm'
                      : 'bg-theme-bg border border-theme-border text-theme-text rounded-bl-sm'
                  }`}
                >
                  {message.role === 'assistant' ? (
                    <div className="prose prose-sm max-w-none [&_p]:my-1">
                      <ReactMarkdown>{message.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  )}
                </div>
              </div>
            ))}
            {pending && !streamText && (
              <div className="flex justify-start">
                <div className="bg-theme-bg border border-theme-border text-theme-subtext px-4 py-2.5 rounded-2xl rounded-bl-sm flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
            {pending && streamText && (
              <div className="flex justify-start">
                <div className="max-w-[85%] sm:max-w-[70%] px-4 py-2.5 rounded-2xl rounded-bl-sm bg-theme-bg border border-theme-border text-theme-text text-sm leading-relaxed">
                  <div className="prose prose-sm max-w-none [&_p]:my-1">
                    <ReactMarkdown>{streamText}</ReactMarkdown>
                  </div>
                  <span className="inline-block w-2 h-4 ml-0.5 align-text-bottom bg-theme-accent animate-pulse" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="p-3 border-t border-theme-border">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder={t('character_chat.input_placeholder', { name: character.name })}
                className="flex-1 resize-none max-h-32 px-4 py-2.5 rounded-theme bg-theme-bg border border-theme-border text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent"
              />
              <button
                onClick={handleSend}
                disabled={pending || !input.trim()}
                className="p-2.5 rounded-theme bg-theme-accent text-theme-bg hover:bg-theme-accent-hover disabled:opacity-40 transition-opacity"
                title={t('character_chat.send')}
              >
                {pending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Persona correction dialog */}
      {showCorrection && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm p-4">
          <div className="bg-theme-surface border border-theme-border rounded-theme max-w-md w-full p-5 text-theme-text">
            <h3 className="font-semibold mb-1">{t('character_chat.adjust_persona')}</h3>
            <p className="text-xs text-theme-subtext mb-4">{t('character_chat.adjust_persona_desc')}</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-theme-subtext mb-1">{t('characters.correction_scene')}</label>
                <input
                  value={correction.scene}
                  onChange={(e) => setCorrection(c => ({ ...c, scene: e.target.value }))}
                  className="w-full px-3 py-2 rounded-theme bg-theme-bg border border-theme-border text-sm focus:outline-none focus:ring-2 focus:ring-theme-accent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-theme-subtext mb-1">{t('characters.correction_wrong')}</label>
                <input
                  value={correction.wrong}
                  onChange={(e) => setCorrection(c => ({ ...c, wrong: e.target.value }))}
                  className="w-full px-3 py-2 rounded-theme bg-theme-bg border border-theme-border text-sm focus:outline-none focus:ring-2 focus:ring-theme-accent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-theme-subtext mb-1">{t('characters.correction_correct')}</label>
                <input
                  value={correction.correct}
                  onChange={(e) => setCorrection(c => ({ ...c, correct: e.target.value }))}
                  className="w-full px-3 py-2 rounded-theme bg-theme-bg border border-theme-border text-sm focus:outline-none focus:ring-2 focus:ring-theme-accent"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowCorrection(false)} className="px-4 py-2 rounded-theme text-sm border border-theme-border text-theme-subtext hover:bg-theme-bg">
                {t('common.cancel')}
              </button>
              <button onClick={submitCorrection} className="px-4 py-2 rounded-theme text-sm font-medium bg-theme-accent text-theme-bg hover:bg-theme-accent-hover">
                {t('characters.correction_save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
