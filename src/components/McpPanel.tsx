import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Plug, Copy, Check } from 'lucide-react';
import clsx from 'clsx';
import { useAuthStore } from '../store/useAuthStore';

const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  username: string;
  endpoint: string;
}

// Settings card for the local MCP server: exposes the collection to external
// AI agents (Claude Code, Cursor, ...) via MCP Streamable HTTP on localhost.
export const McpPanel: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [portInput, setPortInput] = useState('');
  const [userInput, setUserInput] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    invoke<McpStatus>('mcp_get_status').then((s) => {
      setStatus(s);
      setPortInput(String(s.port));
      setUserInput(s.username);
    }).catch(console.error);
  }, []);

  if (!isTauri || !status) return null;

  const apply = async (patch: Partial<{ enabled: boolean; port: number; username: string }>) => {
    const next = {
      enabled: patch.enabled ?? status.enabled,
      port: patch.port ?? (Number(portInput) || status.port),
      username: patch.username ?? userInput,
    };
    try {
      const s = await invoke<McpStatus>('mcp_set_config', { config: next });
      setStatus(s);
    } catch (e) {
      console.error(e);
    }
  };

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(status.endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="bg-theme-surface border border-theme-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4 border-b border-theme-border pb-3">
        <div className="flex items-center gap-2">
          <Plug className="w-5 h-5 text-theme-accent" />
          <h2 className="text-xl font-bold text-theme-text">{t('mcp.title')}</h2>
          <span
            className={clsx(
              'ml-2 flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border',
              status.running
                ? 'bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-500'
                : 'bg-theme-bg border-theme-border text-theme-subtext'
            )}
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full', status.running ? 'bg-green-500' : 'bg-theme-subtext')} />
            {status.running ? t('mcp.status_running') : t('mcp.status_stopped')}
          </span>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={status.enabled}
            onChange={(e) => apply({ enabled: e.target.checked })}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-theme-border border-2 border-theme-subtext/20 rounded-full peer peer-focus:ring-2 peer-focus:ring-theme-accent peer-checked:bg-gradient-to-r peer-checked:from-theme-accent-warm peer-checked:to-theme-accent-warm-2 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
        </label>
      </div>

      <p className="text-xs text-theme-subtext mb-4">{t('mcp.desc')}</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-theme-text mb-1">{t('mcp.port_label')}</label>
          <input
            type="number"
            min={1024}
            max={65535}
            value={portInput}
            disabled={!status.enabled}
            onChange={(e) => setPortInput(e.target.value)}
            onBlur={() => {
              const p = Number(portInput);
              if (p >= 1024 && p <= 65535 && p !== status.port) apply({ port: p });
              else setPortInput(String(status.port));
            }}
            className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-theme-text mb-1">{t('mcp.user_label')}</label>
          <input
            type="text"
            value={userInput}
            disabled={!status.enabled}
            placeholder={useAuthStore.getState().user?.username || 'guest'}
            onChange={(e) => setUserInput(e.target.value)}
            onBlur={() => {
              const u = userInput.trim();
              if (u && u !== status.username) apply({ username: u });
              else setUserInput(status.username);
            }}
            className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none disabled:opacity-50"
          />
          <p className="text-xs text-theme-subtext/70 mt-1">{t('mcp.user_hint')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-theme-text mb-1">{t('mcp.endpoint_label')}</label>
          <div className="flex">
            <input
              type="text"
              readOnly
              value={status.enabled ? status.endpoint : t('mcp.status_stopped')}
              className="flex-1 min-w-0 px-4 py-2 rounded-l-lg border border-r-0 bg-theme-bg border-theme-border text-theme-text text-xs font-mono outline-none"
            />
            <button
              type="button"
              onClick={copyEndpoint}
              disabled={!status.enabled}
              className="px-3 rounded-r-lg border border-theme-border bg-theme-surface text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors disabled:opacity-50"
              title={t('mcp.copy_endpoint')}
            >
              {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {status.enabled && (
        <div className="mt-4 p-3 rounded-lg bg-theme-bg/50 border border-theme-border text-xs text-theme-subtext leading-relaxed">
          <p className="mb-1 font-medium text-theme-text">{t('mcp.connect_hint_title')}</p>
          <p><code className="text-theme-accent">claude mcp add --transport http mediatrove {status.endpoint}</code></p>
          <p className="mt-1">{t('mcp.connect_hint')}</p>
        </div>
      )}
    </div>
  );
};
