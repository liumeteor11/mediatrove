import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
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
import { useLocation } from 'react-router-dom';

interface LayoutProps {
  children: React.ReactNode;
}

const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { theme } = useThemeStore();
  const { t } = useTranslation();
  const location = useLocation();
  // The character chat is a full-height app-like page: it manages its own
  // vertical budget, so the footer is dropped and main's vertical padding
  // released to keep the message input pinned near the screen bottom.
  const isChatPage = /^\/characters\/.+/.test(location.pathname);
  const [appVersion, setAppVersion] = useState('');

  // The footer version must reflect the built binary: getVersion() reads the
  // version baked into the Tauri app (tauri.conf.json at build time), so every
  // release build shows its own version instead of a hardcoded string that
  // silently rots.
  useEffect(() => {
    if (!isTauri) return;
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

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
    <div className={clsx(
      'flex flex-col transition-colors duration-300 bg-theme-bg text-theme-text font-theme',
      // The chat page is a fixed-height app layout: nav + chat + footer must
      // sum to exactly the viewport, so the root must not grow with content.
      isChatPage ? 'h-screen overflow-hidden' : 'min-h-screen'
    )}>
      <Navbar />
      <main className={clsx(
        'flex-grow container mx-auto px-[3%] md:px-[5%]',
        // min-h-0 lets the chat page cap at the viewport: its own flex-1
        // wrapper then scrolls internally instead of pushing the footer down.
        isChatPage ? 'py-0 flex flex-col min-h-0' : 'py-8'
      )}>
        {children}
      </main>
      <footer className="flex items-center justify-center min-h-[44px] mt-auto border-t transition-colors duration-300 bg-theme-surface border-theme-border text-theme-subtext text-sm px-4">
        <p>MediaTrove{appVersion ? ` • v${appVersion}` : ''}</p>
      </footer>
    </div>
  );
};
