import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import {
  ArrowLeft, Plus, MessageCircle, Trash2, Pencil, Send, Loader2,
  ShieldAlert, BookOpen, Check, X, Sparkles, Paperclip, Mic, Volume2, Square, FileText,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useCharacterStore } from '../store/useCharacterStore';
import { useAIStore } from '../store/useAIStore';
import { ChatMessage, ChatSession } from '../types/character';
import { compactSession, sendCharacterMessage } from '../services/characterService';
import { describeAIError } from '../services/aiService';
import {
  ASR_MAX_SECONDS, MAX_CHAT_ATTACHMENTS, MAX_UPLOAD_BYTES,
  isDeepseekProvider, synthesizeSpeech, transcribeAudio, uploadChatFile,
} from '../services/deepseekToolsService';
import { RecordingSession, startRecording } from '../services/audioRecorder';
import { v4 as uuidv4 } from 'uuid';

const deriveTitle = (text: string): string => text.trim().replace(/\s+/g, ' ').slice(0, 24);

const formatRecordTime = (s: number): string =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

interface PendingAttachment {
  key: string;
  name: string;
  size: number;
  mime?: string;
  status: 'uploading' | 'ready' | 'error';
  fileId?: string;
}

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

  // --- DeepSeek attachments / voice ---
  // Buttons only render for a DeepSeek config: file ids and the ASR/TTS
  // endpoints are provider-specific and other backends reject them.
  const aiProvider = useAIStore(s => s.provider);
  const aiBaseUrl = useAIStore(s => s.baseUrl);
  const dsReady = useMemo(() => isDeepseekProvider(), [aiProvider, aiBaseUrl]);

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const recordSessionRef = useRef<RecordingSession | null>(null);
  const recordTimerRef = useRef<number | null>(null);

  const [tts, setTts] = useState<{ msgId: string; status: 'loading' | 'playing' } | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsCacheRef = useRef<Map<string, string>>(new Map());
  // Monotonic request token: a slow synthesis for message A must not clobber
  // the state of a later click on message B.
  const ttsReqRef = useRef(0);

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
    const readyAttachments = attachments.filter(a => a.status === 'ready');
    if (!text && readyAttachments.length === 0) return;
    if (attachments.some(a => a.status === 'uploading')) {
      toast.info(t('character_chat.still_uploading'));
      return;
    }

    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      ...(readyAttachments.length > 0 ? {
        attachments: readyAttachments.map(a => ({ fileId: a.fileId!, name: a.name, size: a.size, mime: a.mime })),
      } : {}),
    };
    let working: ChatSession = {
      ...activeSession,
      messages: [...activeSession.messages, userMessage],
      title:
        activeSession.messages.filter(m => m.role === 'user').length === 0
          ? deriveTitle(text || readyAttachments.map(a => a.name).join(' '))
          : activeSession.title,
    };
    setInput('');
    attachmentsRef.current = [];
    setAttachments([]);
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
  }, [character, activeSession, pending, input, attachments, updateSession, t]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const removeAttachment = (key: string) => {
    attachmentsRef.current = attachmentsRef.current.filter(a => a.key !== key);
    setAttachments(attachmentsRef.current);
  };

  /** Upload each picked file right away so the chip tracks its own progress. */
  const handleFilesPicked = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    for (const file of files) {
      if (attachmentsRef.current.length >= MAX_CHAT_ATTACHMENTS) {
        toast.error(t('character_chat.attach_limit', { count: MAX_CHAT_ATTACHMENTS }));
        break;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(t('character_chat.file_too_large'));
        continue;
      }
      const key = uuidv4();
      attachmentsRef.current = [...attachmentsRef.current, {
        key, name: file.name, size: file.size, mime: file.type || undefined, status: 'uploading',
      }];
      setAttachments(attachmentsRef.current);
      try {
        const att = await uploadChatFile(file);
        attachmentsRef.current = attachmentsRef.current.map(a =>
          a.key === key ? { ...a, status: 'ready' as const, fileId: att.fileId } : a);
      } catch (e) {
        console.error('Attachment upload failed', e);
        attachmentsRef.current = attachmentsRef.current.map(a =>
          a.key === key ? { ...a, status: 'error' as const } : a);
        toast.error(t('character_chat.upload_failed'));
      }
      setAttachments(attachmentsRef.current);
    }
  };

  /** finish=false transcribes into the input; finish=true discards the take. */
  const finishRecording = useCallback(async (discard: boolean) => {
    const session = recordSessionRef.current;
    if (!session) return;
    recordSessionRef.current = null;
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    if (discard) {
      session.cancel();
      return;
    }
    try {
      setTranscribing(true);
      const { blob, seconds } = await session.stop();
      if (blob.size === 0) throw new Error('empty-recording');
      const text = await transcribeAudio(blob, seconds);
      if (!text) {
        toast.error(t('character_chat.asr_empty'));
        return;
      }
      // The transcript lands in the input box for a final check before send.
      setInput(prev => (prev.trim() ? `${prev.trim()} ${text}` : text));
    } catch (e) {
      console.error('Speech recognition failed', e);
      toast.error(t('character_chat.asr_failed'));
    } finally {
      setTranscribing(false);
    }
  }, [t]);

  const toggleRecording = useCallback(async () => {
    if (transcribing) return;
    if (recording) {
      void finishRecording(false);
      return;
    }
    try {
      const session = await startRecording();
      recordSessionRef.current = session;
      setRecordSeconds(0);
      setRecording(true);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds(s => Math.min(s + 1, ASR_MAX_SECONDS));
      }, 1000);
    } catch (e) {
      console.error('Microphone unavailable', e);
      toast.error(t('character_chat.mic_denied'));
    }
  }, [recording, transcribing, finishRecording, t]);

  // ASR rejects audio beyond 120 s — stop the take right before hitting the
  // cap instead of uploading a recording that can only fail.
  useEffect(() => {
    if (recording && recordSeconds >= ASR_MAX_SECONDS) void finishRecording(false);
  }, [recordSeconds, recording, finishRecording]);

  const stopTts = useCallback(() => {
    ttsReqRef.current += 1;
    ttsAudioRef.current?.pause();
    ttsAudioRef.current = null;
    setTts(null);
  }, []);

  const speakMessage = useCallback(async (message: ChatMessage) => {
    if (!message.content.trim()) return;
    if (tts?.msgId === message.id) {
      stopTts();
      return;
    }
    stopTts();
    const req = ++ttsReqRef.current;
    setTts({ msgId: message.id, status: 'loading' });
    try {
      // Synthesizing costs money per request — cache per message so a second
      // click replays instead of re-billing.
      let url = ttsCacheRef.current.get(message.id);
      if (!url) {
        url = await synthesizeSpeech(message.content);
        if (ttsReqRef.current !== req) return;
        ttsCacheRef.current.set(message.id, url);
      }
      const audio = new Audio(url);
      audio.onended = () => {
        if (ttsAudioRef.current === audio) {
          ttsAudioRef.current = null;
          setTts(null);
        }
      };
      ttsAudioRef.current = audio;
      await audio.play();
      if (ttsReqRef.current !== req) {
        audio.pause();
        return;
      }
      setTts({ msgId: message.id, status: 'playing' });
    } catch (e) {
      console.error('Speech synthesis failed', e);
      if (ttsReqRef.current === req) {
        ttsAudioRef.current = null;
        setTts(null);
        toast.error(t('character_chat.tts_failed'));
      }
    }
  }, [tts, stopTts, t]);

  // Leaving the page or switching sessions must not leave audio playing or
  // the microphone open.
  useEffect(() => () => {
    recordSessionRef.current?.cancel();
    if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
    ttsAudioRef.current?.pause();
  }, []);
  useEffect(() => {
    stopTts();
  }, [activeSession?.id, stopTts]);

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
                {message.role === 'assistant' ? (
                  <div className="group flex items-end gap-1 max-w-[85%] sm:max-w-[70%]">
                    <div className="min-w-0 px-4 py-2.5 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-theme-bg border border-theme-border text-theme-text">
                      <div className="prose prose-sm max-w-none [&_p]:my-1">
                        <ReactMarkdown>{message.content}</ReactMarkdown>
                      </div>
                    </div>
                    {dsReady && (
                      <button
                        onClick={() => void speakMessage(message)}
                        className="p-1.5 rounded-theme text-theme-subtext hover:text-theme-text hover:bg-theme-bg opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex-shrink-0"
                        title={tts?.msgId === message.id ? t('character_chat.stop_audio') : t('character_chat.read_aloud')}
                      >
                        {tts?.msgId === message.id && tts.status === 'loading' ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : tts?.msgId === message.id ? (
                          <Square className="w-4 h-4 text-theme-accent" />
                        ) : (
                          <Volume2 className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="max-w-[85%] sm:max-w-[70%] px-4 py-2.5 rounded-2xl rounded-br-sm text-sm leading-relaxed bg-theme-accent text-theme-bg">
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {message.attachments.map(a => (
                          <span key={a.fileId} className="flex items-center gap-1 px-2 py-0.5 rounded bg-black/10 text-xs">
                            <FileText className="w-3 h-3 flex-shrink-0" />
                            <span className="max-w-[160px] truncate">{a.name}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </div>
                )}
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
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {attachments.map(a => (
                  <span
                    key={a.key}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-theme text-xs border bg-theme-bg ${
                      a.status === 'error' ? 'border-red-400/60 text-red-400' : 'border-theme-border text-theme-subtext'
                    }`}
                  >
                    {a.status === 'uploading' ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : a.status === 'error' ? (
                      <X className="w-3 h-3" />
                    ) : (
                      <FileText className="w-3 h-3" />
                    )}
                    <span className="max-w-[180px] truncate">{a.name}</span>
                    <button
                      onClick={() => removeAttachment(a.key)}
                      className="hover:text-theme-text"
                      title={t('common.cancel')}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              {dsReady && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={pending}
                  className="p-2.5 rounded-theme bg-theme-bg border border-theme-border text-theme-subtext hover:text-theme-text disabled:opacity-40 transition-opacity flex-shrink-0"
                  title={t('character_chat.attach_file')}
                >
                  <Paperclip className="w-5 h-5" />
                </button>
              )}
              {dsReady && (recording || transcribing) ? (
                <div className="flex items-center gap-1.5 p-1.5 rounded-theme bg-theme-bg border border-theme-border flex-shrink-0 self-end">
                  {transcribing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-theme-accent" />
                      <span className="text-xs text-theme-subtext">{t('character_chat.transcribing')}</span>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => void finishRecording(false)}
                        className="p-1 rounded-full bg-red-500/15 text-red-500 hover:bg-red-500/25 animate-pulse"
                        title={t('character_chat.stop_recording')}
                      >
                        <Mic className="w-4 h-4" />
                      </button>
                      <span className="text-xs text-theme-subtext tabular-nums">{formatRecordTime(recordSeconds)}</span>
                      <button
                        onClick={() => void finishRecording(true)}
                        className="p-1 text-theme-subtext hover:text-theme-text"
                        title={t('common.cancel')}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ) : dsReady ? (
                <button
                  onClick={() => void toggleRecording()}
                  disabled={pending}
                  className="p-2.5 rounded-theme bg-theme-bg border border-theme-border text-theme-subtext hover:text-theme-text disabled:opacity-40 transition-opacity flex-shrink-0"
                  title={t('character_chat.voice_input')}
                >
                  <Mic className="w-5 h-5" />
                </button>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.ppt,.pptx,.xlsx,.xls,.txt,.md,.csv,.json,.epub,.mobi,.log,.yml,.yaml,.xml,.html,.css,.ts,.tsx,.js,.py,.java,.go,.rs,.rb,.php,.sh,.sql,image/*"
                className="hidden"
                onChange={(e) => void handleFilesPicked(e.target.files)}
              />
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
                disabled={pending || attachments.some(a => a.status === 'uploading') || (!input.trim() && !attachments.some(a => a.status === 'ready'))}
                className="p-2.5 rounded-theme bg-theme-accent text-theme-bg hover:bg-theme-accent-hover disabled:opacity-40 transition-opacity flex-shrink-0"
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
