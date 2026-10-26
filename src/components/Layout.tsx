import React, { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import { useThemeStore } from '../store/useThemeStore';
import { useAppUpdateStore } from '../store/useAppUpdateStore';
import { useCollectionStore } from '../store/useCollectionStore';
import { useCharacterStore } from '../store/useCharacterStore';
import { sendCharacterMessage } from '../services/characterService';
import type { ChatMessage } from '../types/character';
import { Navbar } from './Navbar';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

interface LayoutProps {
  children: React.ReactNode;
}

const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { theme } = useThemeStore();
  const { t } = useTranslation();

  // One silent app-update check per launch; the result feeds the dashboard
  // button (useAppUpdateStore) and a toast when a new release is out.
  useEffect(() => {
    void useAppUpdateStore.getState().silentCheck();
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    root.setAttribute('data-theme', theme);
  }, [theme]);

  // External AI agents can write to the collection through the local MCP
  // server; reload the store whenever they do so the UI stays in sync.
  useEffect(() => {
    if (!isTauri) return;
    let unlistenData: (() => void) | undefined;
    let unlistenChat: (() => void) | undefined;
    import('@tauri-apps/api/event')
      .then(({ listen }) => {
        listen('mcp:data-changed', () => {
          useCollectionStore.getState().refreshForUser();
        }).then((u) => { unlistenData = u; });

        // Character chat requested by an MCP agent: run it through the same
        // AI config the in-app chat uses, and record the exchange in the
        // character's history so it shows up in the chat page.
        listen<{ requestId: string; characterId: string; message: string }>(
          'mcp:chat-request',
          async (event) => {
            const { requestId, characterId, message } = event.payload;
            const store = useCharacterStore.getState();
            const character = store.getCharacter(characterId);
            if (!character) {
              invoke('mcp_chat_reply', { requestId, ok: false, reply: `character '${characterId}' not found in the app` }).catch(console.error);
              return;
            }
            try {
              const latest = [...store.getSessionsForCharacter(characterId)].sort(
                (a, b) => b.updatedAt - a.updatedAt
              )[0];
              const session = latest ?? store.createSession(characterId);
              const userMessage: ChatMessage = { id: uuidv4(), role: 'user', content: message, createdAt: Date.now() };
              let working = { ...session, messages: [...session.messages, userMessage], updatedAt: Date.now() };
              store.updateSession(working);
              const reply = await sendCharacterMessage(character, working);
              working = {
                ...working,
                messages: [...working.messages, { id: uuidv4(), role: 'assistant', content: reply, createdAt: Date.now() } as ChatMessage],
                updatedAt: Date.now(),
              };
              store.updateSession(working);
              invoke('mcp_chat_reply', { requestId, ok: true, reply }).catch(console.error);
            } catch (e: any) {
              console.error('MCP character chat failed', e);
              invoke('mcp_chat_reply', { requestId, ok: false, reply: String(e?.message || e || 'chat failed') }).catch(console.error);
            }
          }
        ).then((u) => { unlistenChat = u; });
      })
      .catch(console.error);
    return () => {
      unlistenData?.();
      unlistenChat?.();
    };
  }, []);

  return (
    <div className="min-h-screen flex flex-col transition-colors duration-300 bg-theme-bg text-theme-text font-theme">
      <Navbar />
      <main className="flex-grow container mx-auto px-[3%] md:px-[5%] py-8">
        {children}
      </main>
      <footer className="py-8 mt-auto border-t transition-colors duration-300 bg-theme-surface border-theme-border text-theme-subtext">
        <div className="max-w-7xl mx-auto px-4 text-center text-sm">
          <p>MediaTrove • v0.1.24</p>
        </div>
      </footer>
    </div>
  );
};
