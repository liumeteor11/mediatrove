import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/useAuthStore';

interface PeerInfo {
    name: string;
    ip: string;
    port: number;
    last_seen: number;
}

interface SyncModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const SyncModal: React.FC<SyncModalProps> = ({ isOpen, onClose }) => {
    const [peers, setPeers] = useState<PeerInfo[]>([]);
    const [status, setStatus] = useState<string>('Idle');
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncToken, setSyncToken] = useState<string>('');
    const [tokenInput, setTokenInput] = useState<string>('');

    useEffect(() => {
        if (isOpen) {
            startServer();
            loadSyncToken();
            const interval = setInterval(fetchPeers, 3000);
            return () => clearInterval(interval);
        }
    }, [isOpen]);

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
            setStatus('Pairing code must be at least 4 characters');
            return;
        }
        try {
            await invoke('set_sync_token', { token: trimmed });
            setSyncToken(trimmed);
            setStatus('Pairing code saved');
        } catch (e) {
            setStatus('Failed to save pairing code: ' + String(e));
        }
    };

    const copySyncToken = async () => {
        if (!syncToken) return;
        try {
            await navigator.clipboard.writeText(syncToken);
            setStatus('Pairing code copied');
        } catch {
            setStatus('Copy failed - select the code manually');
        }
    };

    const startServer = async () => {
        try {
            setStatus('Starting Sync Service...');
            await invoke('start_sync_server');
            setStatus('Scanning for devices...');
        } catch (e) {
            setStatus('Error starting service: ' + String(e));
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
        setStatus(`Syncing with ${peer.name}...`);
        try {
            const username = useAuthStore.getState().user?.username || 'guest';
            await invoke('sync_with_peer', { peerIp: peer.ip, peerPort: peer.port, username });
            setStatus('Sync Completed!');
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } catch (e) {
            const msg = String(e);
            setStatus(msg.includes('sync_auth_failed')
                ? 'Sync Failed: pairing code mismatch. Set the same code on both devices.'
                : 'Sync Failed: ' + msg);
        } finally {
            setIsSyncing(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm">
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg w-96 shadow-2xl border dark:border-gray-700">
                <h2 className="text-xl font-bold mb-4 dark:text-white flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Device Sync
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{status}</p>

                <div className="mb-4 p-3 rounded border dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Pairing Code (shared with peers)</span>
                        <button
                            onClick={copySyncToken}
                            className="text-xs px-2 py-1 rounded border dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                            Copy
                        </button>
                    </div>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={tokenInput}
                            onChange={(e) => setTokenInput(e.target.value)}
                            placeholder="e.g. MT-4821"
                            className="flex-1 px-3 py-1.5 text-sm rounded border dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 outline-none"
                        />
                        <button
                            onClick={saveSyncToken}
                            className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700"
                        >
                            Save
                        </button>
                    </div>
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        Both devices must use the same code. Copy it from this device and paste it on the peer, or set a code you both agree on.
                    </p>
                </div>
                
                <div className="min-h-[200px] max-h-[300px] overflow-y-auto border rounded p-2 mb-4 bg-gray-50 dark:bg-gray-900 dark:border-gray-700">
                    {peers.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-400 mb-2"></div>
                            <span className="text-xs">Looking for devices on LAN...</span>
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
                                    {isSyncing ? 'Syncing...' : 'Sync'}
                                </button>
                            </div>
                        ))
                    )}
                </div>

                <div className="flex justify-end">
                    <button 
                        onClick={onClose} 
                        className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};
