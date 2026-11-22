import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import { toast } from 'react-toastify';
import i18n from '../i18n';
import { useAuthStore } from './useAuthStore';
import { ChatSession, CharacterCorrection, DistilledCharacter } from '../types/character';
import { MediaItem } from '../types/types';
import {
  addCorrectionToCharacter,
  createCharacterSession as buildSession,
  distillCharacters,
  distillErrorKey,
} from '../services/characterService';
import type { DistillOptions } from '../types/character';

const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));
const STORAGE_KEY = 'media-tracker-characters';

/** A distillation running in the background, shown until it finishes. */
export interface DistillTask {
  id: string;
  /** Display label: "character · work" (or just the work when unnamed). */
  label: string;
  startedAt: number;
}

interface CharacterState {
  characters: DistilledCharacter[];
  sessions: ChatSession[];
  isLoading: boolean;
  initialized: boolean;
  /** Distillations currently running; the dialog closes and these keep going. */
  distillTasks: DistillTask[];
  initialize: () => Promise<void>;
  refreshForUser: () => Promise<void>;
  clear: () => void;
  getCharacter: (id: string) => DistilledCharacter | undefined;
  getSessionsForCharacter: (characterId: string) => ChatSession[];
  /** Insert/update characters from a distillation run and persist them. */
  upsertCharacters: (items: DistilledCharacter[]) => void;
  updateCharacter: (character: DistilledCharacter) => void;
  removeCharacter: (id: string) => void;
  /** Run a distillation in the background; reports the outcome through toasts. */
  startDistill: (item: MediaItem, opts: DistillOptions) => void;
  addCorrection: (characterId: string, correction: { scene: string; wrong: string; correct: string }) => DistilledCharacter | undefined;
  /** Drop one correction layer entry (index into `character.corrections`). */
  removeCorrection: (characterId: string, index: number) => DistilledCharacter | undefined;
  createSession: (characterId: string, title?: string) => ChatSession;
  updateSession: (session: ChatSession) => void;
  removeSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
}

const persistLocalStorage = (characters: DistilledCharacter[], sessions: ChatSession[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { characters, sessions }, version: 0 }));
  } catch (e) {
    console.error('Failed to persist characters to localStorage', e);
  }
};

const persistCharacter = (character: DistilledCharacter) => {
  if (!isTauri) return;
  const username = useAuthStore.getState().user?.username;
        if (!username) return;
  invoke('save_character', { username, character }).catch(e => console.error('save_character failed', e));
};

const persistSession = (session: ChatSession) => {
  if (!isTauri) return;
  const username = useAuthStore.getState().user?.username;
        if (!username) return;
  invoke('save_chat_session', { username, session }).catch(e => console.error('save_chat_session failed', e));
};

const sortByUpdated = <T extends { updatedAt: number }>(list: T[]): T[] =>
  [...list].sort((a, b) => b.updatedAt - a.updatedAt);

export const useCharacterStore = create<CharacterState>((set, get) => ({
  characters: [],
  sessions: [],
  isLoading: false,
  initialized: false,
  distillTasks: [],

  initialize: async () => {
    if (get().initialized) return;
    set({ isLoading: true });
    try {
      if (isTauri) {
        const username = useAuthStore.getState().user?.username;
        if (!username) return;
        const [characters, sessions] = await Promise.all([
          invoke<DistilledCharacter[]>('get_characters', { username }),
          invoke<ChatSession[]>('get_chat_sessions', { username }),
        ]);
        set({
          characters: sortByUpdated(characters || []),
          sessions: sortByUpdated(sessions || []),
          initialized: true,
          isLoading: false,
        });
      } else {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            const characters = Array.isArray(parsed?.state?.characters) ? parsed.state.characters : [];
            const sessions = Array.isArray(parsed?.state?.sessions) ? parsed.state.sessions : [];
            set({ characters: sortByUpdated(characters), sessions: sortByUpdated(sessions), initialized: true, isLoading: false });
          } catch (e) {
            console.error('Failed to parse stored characters', e);
            set({ initialized: true, isLoading: false });
          }
        } else {
          set({ initialized: true, isLoading: false });
        }
      }
    } catch (e) {
      console.error('Failed to initialize character store', e);
      set({ isLoading: false });
    }
  },

  refreshForUser: async () => {
    set({ initialized: false });
    await get().initialize();
  },

  clear: () => set({ characters: [], sessions: [], initialized: false }),

  getCharacter: (id) => get().characters.find(c => c.id === id),

  getSessionsForCharacter: (characterId) =>
    get().sessions.filter(s => s.characterId === characterId),

  upsertCharacters: (items) => set((state) => {
    const map = new Map(state.characters.map(c => [c.id, c]));
    items.forEach(c => map.set(c.id, c));
    const characters = sortByUpdated(Array.from(map.values()));
    if (isTauri) items.forEach(persistCharacter);
    else persistLocalStorage(characters, state.sessions);
    return { characters };
  }),

  startDistill: (item, opts) => {
    const characterName = (opts.characterName || '').trim();
    const label = characterName ? `${characterName} · ${item.title}` : item.title;
    // Starting the same distillation twice would spend tokens on a duplicate run.
    if (get().distillTasks.some(task => task.label === label)) {
      toast.info(String(i18n.t('characters.distill_running', { name: label })));
      return;
    }
    const id = uuidv4();
    set(state => ({ distillTasks: [...state.distillTasks, { id, label, startedAt: Date.now() }] }));
    void (async () => {
      try {
        const result = await distillCharacters(item, get().characters, opts);
        get().upsertCharacters(result.characters);
        toast.success(String(i18n.t('characters.distill_success', { created: result.created, updated: result.updated })));
      } catch (e) {
        console.error('Distillation failed', e);
        const { key, params } = distillErrorKey(e);
        toast.error(String(i18n.t(key, params as any)));
      } finally {
        set(state => ({ distillTasks: state.distillTasks.filter(task => task.id !== id) }));
      }
    })();
  },

  updateCharacter: (character) => set((state) => {
    const characters = sortByUpdated([character, ...state.characters.filter(c => c.id !== character.id)]);
    if (isTauri) persistCharacter(character);
    else persistLocalStorage(characters, state.sessions);
    return { characters };
  }),

  removeCharacter: (id) => set((state) => {
    const characters = state.characters.filter(c => c.id !== id);
    const sessions = state.sessions.filter(s => s.characterId !== id);
    if (isTauri) {
      const username = useAuthStore.getState().user?.username;
        if (!username) return;
      invoke('remove_character', { username, id }).catch(e => console.error('remove_character failed', e));
    } else {
      persistLocalStorage(characters, sessions);
    }
    return { characters, sessions };
  }),

  addCorrection: (characterId, correction) => {
    const character = get().characters.find(c => c.id === characterId);
    if (!character) return undefined;
    const updated = addCorrectionToCharacter(character, correction as Omit<CharacterCorrection, 'createdAt'>);
    get().updateCharacter(updated);
    return updated;
  },

  removeCorrection: (characterId, index) => {
    const character = get().characters.find(c => c.id === characterId);
    if (!character || index < 0 || index >= character.corrections.length) return undefined;
    const updated: DistilledCharacter = {
      ...character,
      corrections: character.corrections.filter((_, i) => i !== index),
      version: character.version + 1,
      updatedAt: Date.now(),
    };
    get().updateCharacter(updated);
    return updated;
  },

  createSession: (characterId, title) => {
    const character = get().characters.find(c => c.id === characterId);
    const session = buildSession(character || ({ id: characterId, name: title || '' } as DistilledCharacter), title);
    set((state) => {
      const sessions = sortByUpdated([session, ...state.sessions]);
      if (isTauri) persistSession(session);
      else persistLocalStorage(state.characters, sessions);
      return { sessions };
    });
    return session;
  },

  updateSession: (session) => set((state) => {
    const stamped = { ...session, updatedAt: Date.now() };
    const sessions = sortByUpdated([stamped, ...state.sessions.filter(s => s.id !== stamped.id)]);
    if (isTauri) persistSession(stamped);
    else persistLocalStorage(state.characters, sessions);
    return { sessions };
  }),

  removeSession: (id) => set((state) => {
    const sessions = state.sessions.filter(s => s.id !== id);
    if (isTauri) {
      const username = useAuthStore.getState().user?.username;
        if (!username) return;
      invoke('remove_chat_session', { username, id }).catch(e => console.error('remove_chat_session failed', e));
    } else {
      persistLocalStorage(state.characters, sessions);
    }
    return { sessions };
  }),

  renameSession: (id, title) => {
    const session = get().sessions.find(s => s.id === id);
    if (!session) return;
    get().updateSession({ ...session, title: title.trim().slice(0, 60) || session.title });
  },
}));

// Refresh character data when the auth user changes (mirrors useCollectionStore).
useAuthStore.subscribe((state, prev) => {
  const newUser = state.user?.username || null;
  const oldUser = prev.user?.username || null;
  if (newUser !== oldUser) {
    if (!newUser) {
      useCharacterStore.getState().clear();
    } else {
      useCharacterStore.getState().refreshForUser();
    }
  }
});
