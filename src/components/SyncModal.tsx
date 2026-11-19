import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toDataURL as qrToDataURL } from 'qrcode';
import { ChevronDown, QrCode, X } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import { useAIStore } from '../store/useAIStore';
import { useThemeStore } from '../store/useThemeStore';
import { useTranslation } from 'react-i18next';

interface PeerInfo {
    name: string;
    ip: string;
    port: number;
    last_seen: number;
}

interface PairTicket {
    code: string;
    ip: string;
    port: number;
    username: string;
    expires_in: number;
}

interface SyncModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const SyncModal: React.FC<SyncModalProps> = ({ isOpen, onClose }) => {
    const { t } = useTranslation();
    const [peers, setPeers] = useState<PeerInfo[]>([]);
    // Empty = nothing worth saying; scan progress lives in the peer list's
    // own spinner, so the header line stays free of a duplicate indicator.
    const [status, setStatus] = useState<string>('');
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncToken, setSyncToken] = useState<string>('');
    const [tokenInput, setTokenInput] = useState<string>('');
    const [includeConfig, setIncludeConfig] = useState<boolean>(false);
    const [pairTicket, setPairTicket] = useState<PairTicket | null>(null);
    const [pairQrUrl, setPairQrUrl] = useState<string>('');
    const [pairExpiresAt, setPairExpiresAt] = useState<number>(0);
    const [pairRemaining, setPairRemaining] = useState<number>(0);
    // The manual pairing-code block starts expanded; the QR flow collapses it
    // so the minted long-lived code never sits next to the 6-digit one-time
    // code reading like a second, competing code.
    const [codeOpen, setCodeOpen] = useState<boolean>(true);

    useEffect(() => {
        if (isOpen) {
            startServer();
            loadSyncToken();
            const interval = setInterval(fetchPeers, 3000);
            return () => clearInterval(interval);
        }
    }, [isOpen]);

    // Close on Escape: the modal content (with the generated QR) can grow
    // taller than the window, so a keyboard escape hatch is essential.
    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [isOpen, onClose]);

    // Countdown for the one-time pairing code; the QR stays visible but is
    // marked expired so the user knows to regenerate instead of retrying.
    useEffect(() => {
        if (!pairExpiresAt) return;
        const tick = () => setPairRemaining(Math.max(0, Math.ceil((pairExpiresAt - Date.now()) / 1000)));
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [pairExpiresAt]);

    const loadSyncToken = async () => {
        try {
            const token = await invoke<string>('get_sync_token');
            setSyncToken(token || '');
            setTokenInput(token || '');
        } catch (e) {
            console.error(e);
        }
    };

    const saveSyncToken = async () => {
        const trimmed = tokenInput.trim();
        if (trimmed.length < 4) {
            setStatus(t('sync.code_too_short'));
            return;
        }
        try {
            await invoke('set_sync_token', { token: trimmed });
            setSyncToken(trimmed);
            setStatus(t('sync.code_saved'));
        } catch (e) {
            setStatus(t('sync.code_save_failed', { error: String(e) }));
        }
    };

    const copySyncToken = async () => {
        if (!syncToken) return;
        try {
            await navigator.clipboard.writeText(syncToken);
            setStatus(t('sync.code_copied'));
        } catch {
            setStatus(t('sync.copy_failed'));
        }
    };

    const buildPairPayload = (ticket: PairTicket): string =>
        `mediatrove://pair?v=1&u=${encodeURIComponent(ticket.username)}&ip=${ticket.ip}&p=${ticket.port}&c=${ticket.code}`;

    const generatePairQr = async () => {
        try {
            const username = useAuthStore.getState().user?.username || 'guest';
            const ticket = await invoke<PairTicket>('create_pair_ticket', { username });
            const url = await qrToDataURL(buildPairPayload(ticket), { width: 256, margin: 1 });
            setPairTicket(ticket);
            setPairQrUrl(url);
            setPairExpiresAt(Date.now() + ticket.expires_in * 1000);
            setCodeOpen(false);
            // The backend just minted the persistent pairing code if none was
            // set, so the manual-code box above must not show a stale value.
            loadSyncToken();
            setStatus(t('sync.qr_ready'));
        } catch (e) {
            setStatus(t('sync.qr_generate_failed', { error: String(e) }));
        }
    };

    const copyPairPayload = async () => {
        if (!pairTicket) return;
        try {
            await navigator.clipboard.writeText(buildPairPayload(pairTicket));
            setStatus(t('sync.pair_info_copied'));
        } catch {
            setStatus(t('sync.copy_failed'));
        }
    };

    const startServer = async () => {
        try {
            setStatus(t('sync.status_starting'));
            await invoke('start_sync_server');
            // No "scanning" line here: the peer list below already shows its
            // own spinner + caption, and a second one above just duplicated it.
            setStatus('');
        } catch (e) {
            setStatus(t('sync.status_start_error', { error: String(e) }));
        }
    };

    const fetchPeers = async () => {
        try {
            const res = await invoke<PeerInfo[]>('get_peers');
            // Deduplicate by ip:port (one IP may legitimately host several instances)
            const unique = res.filter((v, i, a) => a.findIndex(t => t.ip === v.ip && t.port === v.port) === i);
            setPeers(unique);
        } catch (e) {
            console.error(e);
        }
    };

    const handleSync = async (peer: PeerInfo) => {
        setIsSyncing(true);
        setStatus(t('sync.syncing_with', { name: peer.name }));
        try {
            const username = useAuthStore.getState().user?.username || 'guest';
            await invoke('sync_with_peer', { peerIp: peer.ip, peerPort: peer.port, username, includeConfig: includeConfig });
            if (includeConfig) {
                // The synced config now lives in the backend, but the webview
                // stores treat localStorage as the source of truth on reload —
                // adopt the synced values here so the reload keeps them.
                try {
                    const [aiConfig, themeConfig] = await invoke<[any, any]>('get_app_configs');
                    if (aiConfig) useAIStore.getState().importBackendConfig(aiConfig);
                    if (themeConfig && themeConfig.theme) useThemeStore.getState().setTheme(themeConfig.theme);
                } catch (e) {
                    console.error('Failed to adopt synced config into stores', e);
                }
            }
            setStatus(t('sync.sync_completed'));
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } catch (e) {
            const msg = String(e);
            setStatus(msg.includes('sync_auth_failed')
                ? t('sync.sync_failed_auth')
                : msg.includes('sync_config_decrypt_failed')
                ? t('sync.sync_failed_decrypt')
                : t('sync.sync_failed', { error: msg }));
        } finally {
            setIsSyncing(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm" onClick={onClose}>
            <div
                className="bg-white dark:bg-gray-800 p-6 rounded-lg w-96 max-w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto shadow-2xl border dark:border-gray-700"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-2 mb-4">
                    <h2 className="text-xl font-bold dark:text-white flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        {t('sync.title')}
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
                        aria-label={t('common.close')}
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
                {status && <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{status}</p>}

                <div className="mb-4 p-3 rounded border dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                    <div className="flex items-center justify-between gap-2">
                        <button
                            type="button"
                            onClick={() => setCodeOpen(o => !o)}
                            className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
                            aria-expanded={codeOpen}
                        >
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${codeOpen ? '' : '-rotate-90'}`} />
                            {t('sync.pairing_code_label')}
                        </button>
                        <button
                            onClick={copySyncToken}
                            className="text-xs px-2 py-1 rounded border dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                            {t('sync.copy')}
                        </button>
                    </div>
                    {codeOpen && (
                        <>
                            <div className="flex gap-2 mt-2">
                                <input
                                    type="text"
                                    value={tokenInput}
                                    onChange={(e) => setTokenInput(e.target.value)}
                                    placeholder={t('sync.pairing_code_placeholder')}
                                    className="flex-1 px-3 py-1.5 text-sm rounded border dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 outline-none"
                                />
                                <button
                                    onClick={saveSyncToken}
                                    className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700"
                                >
                                    {t('sync.save')}
                                </button>
                            </div>
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                                {t('sync.pairing_code_desc')}
                            </p>
                        </>
                    )}
                </div>

                {/* Quick pairing: one-time code rendered as a QR (plus the code
                    itself as a manual fallback) so the phone can log in and
                    pull the collection in a single step. */}
                <div className="mb-4 p-3 rounded border dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                    <div className="flex items-center gap-2 mb-2">
                        <QrCode className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{t('sync.quick_pair_title')}</span>
                    </div>
                    {!pairQrUrl ? (
                        <button
                            onClick={generatePairQr}
                            className="w-full px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700"
                        >
                            {t('sync.quick_pair_generate')}
                        </button>
                    ) : (
                        <div className="flex flex-col items-center gap-2">
                            <img src={pairQrUrl} alt="MediaTrove pairing QR" className="w-40 h-40 rounded bg-white p-1" />
                            <div className="text-center">
                                <p className="text-sm font-mono font-semibold tracking-widest text-gray-800 dark:text-gray-200">{pairTicket?.code}</p>
                                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                                    {pairRemaining > 0
                                        ? t('sync.quick_pair_expires_in', { seconds: pairRemaining })
                                        : t('sync.quick_pair_expired')}
                                </p>
                            </div>
                            <div className="flex gap-2 w-full">
                                <button
                                    onClick={copyPairPayload}
                                    disabled={pairRemaining === 0}
                                    className="flex-1 px-2 py-1.5 text-xs rounded border dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                                >
                                    {t('sync.quick_pair_copy')}
                                </button>
                                <button
                                    onClick={generatePairQr}
                                    className="flex-1 px-2 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700"
                                >
                                    {t('sync.quick_pair_refresh')}
                                </button>
                            </div>
                        </div>
                    )}
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        {t('sync.quick_pair_desc')}
                    </p>
                </div>

                <label className="flex items-start gap-2 mb-4 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={includeConfig}
                        onChange={(e) => setIncludeConfig(e.target.checked)}
                        disabled={isSyncing}
                        className="mt-0.5 w-4 h-4 accent-blue-600"
                    />
                    <span className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
                        {t('sync.include_config')}
                    </span>
                </label>
                
                <div className="min-h-[200px] max-h-[300px] overflow-y-auto border rounded p-2 mb-4 bg-gray-50 dark:bg-gray-900 dark:border-gray-700">
                    {peers.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-400 mb-2"></div>
                            <span className="text-xs">{t('sync.looking_for_peers')}</span>
                        </div>
                    ) : (
                        peers.map((peer) => (
                            <div key={peer.ip} className="flex justify-between items-center p-3 mb-2 bg-white dark:bg-gray-800 shadow-sm rounded border border-gray-100 dark:border-gray-700 hover:border-blue-500 transition-colors">
                                <div>
                                    <div className="font-semibold dark:text-white text-sm">{peer.name}</div>
                                    <div className="text-xs text-gray-500">{peer.ip}</div>
                                </div>
                                <button 
                                    onClick={() => handleSync(peer)}
                                    disabled={isSyncing}
                                    className="bg-blue-600 text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                                >
                                    {isSyncing ? t('sync.syncing') : t('sync.sync')}
                                </button>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};
