import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import jsQR from 'jsqr';
import { ScanLine, Loader2, Link2, Keyboard } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import { useCollectionStore } from '../store/useCollectionStore';
import { useAIStore } from '../store/useAIStore';
import { useThemeStore } from '../store/useThemeStore';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

interface PeerInfo {
    name: string;
    ip: string;
    port: number;
    last_seen: number;
}

interface PairTarget {
    ip: string;
    port: number;
    code: string;
}

export const PAIR_PAYLOAD_PREFIX = 'mediatrove://pair?';

/** Parse a `mediatrove://pair?...` payload as shown in the desktop QR. */
export const parsePairPayload = (raw: string): PairTarget | null => {
    const text = raw.trim();
    if (!text.startsWith(PAIR_PAYLOAD_PREFIX)) return null;
    try {
        const params = new URLSearchParams(text.slice(PAIR_PAYLOAD_PREFIX.length));
        const ip = params.get('ip') || '';
        const port = Number(params.get('p'));
        const code = (params.get('c') || '').trim();
        if (!ip || !Number.isFinite(port) || port <= 0 || !code) return null;
        return { ip, port, code };
    } catch {
        return null;
    }
};

/** Passwords are per-device: the quick-login profile gets a throwaway one the
 * user never needs (they can set a real one via forgot-password reset). */
const randomPassword = (): string => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
};

export const QuickPairLogin: React.FC<{ onDone: () => void; onExit?: () => void }> = ({ onDone, onExit }) => {
    const { t } = useTranslation();
    const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'scanning' | 'error'>('idle');
    const [cameraError, setCameraError] = useState<string>('');
    const [peers, setPeers] = useState<PeerInfo[]>([]);
    const [selectedPeer, setSelectedPeer] = useState<string>('');
    const [manualCode, setManualCode] = useState<string>('');
    const [pastePayload, setPastePayload] = useState<string>('');
    const [manualOpen, setManualOpen] = useState<boolean>(false);
    const [includeConfig, setIncludeConfig] = useState<boolean>(false);
    const [busy, setBusy] = useState<boolean>(false);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const rafRef = useRef<number>(0);
    // Latest non-reactive handlers for the rAF scan loop, so the loop never
    // works with a stale `includeConfig`/`pairAndSync` closure.
    const handlePayloadRef = useRef<(payload: string) => void>(() => {});
    const stopCameraRef = useRef<() => void>(() => {});

    // LAN discovery for manual pairing: the phone also starts its own sync
    // server (start implies mDNS browsing, so desktop peers show up here).
    useEffect(() => {
        if (!isTauri) return;
        invoke('start_sync_server').catch(console.error);
        const fetchPeers = async () => {
            try {
                const res = await invoke<PeerInfo[]>('get_peers');
                const unique = res.filter((v, i, a) => a.findIndex(x => x.ip === v.ip && x.port === v.port) === i);
                setPeers(unique);
                setSelectedPeer(prev => prev || (unique[0] ? `${unique[0].ip}:${unique[0].port}` : ''));
            } catch (e) {
                console.error(e);
            }
        };
        fetchPeers();
        const interval = setInterval(fetchPeers, 3000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => () => stopCameraRef.current(), []);

    const stopCamera = () => {
        cancelAnimationFrame(rafRef.current);
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameraState('idle');
    };
    stopCameraRef.current = stopCamera;

    const pairAndSync = async (target: PairTarget) => {
        if (busy) return;
        setBusy(true);
        try {
            // 1. Exchange the one-time code for the account + pairing token.
            const claim = await invoke<{ username: string; token: string }>('pair_with_peer', {
                peerIp: target.ip,
                peerPort: target.port,
                code: target.code,
            });
            if (!claim.username || !claim.token) {
                throw new Error('invalid pairing response');
            }
            // 2. Adopt the peer's persistent pairing code so later Device Sync
            // runs (including config sync) use the same credentials.
            await invoke('set_sync_token', { token: claim.token });
            // 3. Seat the account locally (per-device profile; USER_EXISTS is
            // fine and keeps the existing local profile).
            try {
                await useAuthStore.getState().register(claim.username, randomPassword());
            } catch (e) {
                console.error('local profile setup', e);
            }
            useAuthStore.getState().adoptUser(claim.username);
            // 4. Pull the collection right away.
            await invoke('sync_with_peer', {
                peerIp: target.ip,
                peerPort: target.port,
                username: claim.username,
                includeConfig,
            });
            if (includeConfig) {
                // Mirror SyncModal: adopt the synced backend config into the
                // webview stores or a reload would revert them.
                try {
                    const [aiConfig, themeConfig] = await invoke<[any, any]>('get_app_configs');
                    if (aiConfig) useAIStore.getState().importBackendConfig(aiConfig);
                    if (themeConfig && themeConfig.theme) useThemeStore.getState().setTheme(themeConfig.theme);
                } catch (e) {
                    console.error('Failed to adopt synced config into stores', e);
                }
            }
            await useCollectionStore.getState().refreshForUser();
            toast.success(t('login.quick.success'));
            stopCamera();
            onDone();
        } catch (e) {
            const msg = String(e);
            toast.error(
                msg.includes('pair_code_invalid')
                    ? t('login.quick.invalid_code')
                    : t('login.quick.pair_failed', { reason: msg })
            );
        } finally {
            setBusy(false);
        }
    };

    const scanLoop = () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || video.readyState < video.HAVE_ENOUGH_DATA) {
            // The preview element mounts a frame after the stream starts; keep
            // trying to attach so a missed first assignment can't go black.
            if (video && streamRef.current && !video.srcObject) {
                video.srcObject = streamRef.current;
                video.play().catch(console.error);
            }
            rafRef.current = requestAnimationFrame(scanLoop);
            return;
        }
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
                canvas.width = w;
                canvas.height = h;
                ctx.drawImage(video, 0, 0, w, h);
                const img = ctx.getImageData(0, 0, w, h);
                const found = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
                if (found?.data && found.data.startsWith(PAIR_PAYLOAD_PREFIX)) {
                    stopCamera();
                    handlePayloadRef.current(found.data);
                    return;
                }
            }
        }
        rafRef.current = requestAnimationFrame(scanLoop);
    };

    const startCamera = async () => {
        setCameraError('');
        setCameraState('starting');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } },
                audio: false,
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            setCameraState('scanning');
            rafRef.current = requestAnimationFrame(scanLoop);
        } catch (e) {
            console.error(e);
            setCameraError(String(e));
            setCameraState('error');
        }
    };

    const handlePayload = (payload: string) => {
        const parsed = parsePairPayload(payload);
        if (parsed) void pairAndSync(parsed);
        else toast.error(t('login.quick.invalid_payload'));
    };
    handlePayloadRef.current = handlePayload;

    const connectManual = () => {
        if (!selectedPeer) return;
        const [ip, portStr] = selectedPeer.split(':');
        const port = Number(portStr);
        if (!ip || !Number.isFinite(port) || !manualCode.trim()) {
            toast.error(t('login.quick.missing_manual_fields'));
            return;
        }
        void pairAndSync({ ip, port, code: manualCode.trim() });
    };

    const connectPaste = () => {
        const parsed = parsePairPayload(pastePayload);
        if (!parsed) {
            toast.error(t('login.quick.invalid_payload'));
            return;
        }
        void pairAndSync(parsed);
    };

    return (
        <div className="space-y-4">
            <p className="text-sm text-theme-subtext">{t('login.quick.subtitle')}</p>

            {!isTauri && (
                <p className="text-xs rounded-lg px-3 py-2 bg-amber-50 text-amber-600 border border-amber-200">
                    {t('login.quick.preview_only')}
                </p>
            )}

            {(cameraState === 'scanning' || cameraState === 'starting') ? (
                <div className="relative rounded-xl overflow-hidden border border-theme-border bg-black aspect-[4/3]">
                    <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
                    <div className="absolute inset-8 border-2 border-white/70 rounded-lg pointer-events-none" />
                    <canvas ref={canvasRef} className="hidden" />
                    <button
                        type="button"
                        onClick={stopCamera}
                        className="absolute bottom-2 right-2 px-3 py-1.5 text-xs rounded bg-black/60 text-white hover:bg-black/80 transition-colors"
                    >
                        {cameraState === 'starting' ? t('login.quick.starting_camera') : t('login.quick.cancel_scan')}
                    </button>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={startCamera}
                    disabled={!isTauri || busy}
                    className="w-full py-3 font-medium rounded-lg transition-all shadow-lg disabled:opacity-70 disabled:cursor-not-allowed bg-theme-accent text-theme-bg hover:bg-theme-accent-hover flex items-center justify-center gap-2"
                >
                    <ScanLine className="w-5 h-5" />
                    {t('login.quick.scan')}
                </button>
            )}
            {cameraState === 'error' && (
                <p className="text-xs text-red-500">{t('login.quick.camera_error')}</p>
            )}

            {busy && (
                <div className="flex items-center justify-center gap-2 text-sm text-theme-subtext">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('login.quick.pairing')}
                </div>
            )}

            <button
                type="button"
                onClick={() => setManualOpen(o => !o)}
                className="w-full flex items-center justify-center gap-2 text-sm text-theme-accent hover:underline"
            >
                <Keyboard className="w-4 h-4" />
                {manualOpen ? t('login.quick.hide_manual') : t('login.quick.show_manual')}
            </button>

            {manualOpen && (
                <div className="space-y-3 rounded-lg border border-theme-border p-3 bg-theme-bg">
                    <div>
                        <p className="text-xs font-medium mb-1 text-theme-subtext">{t('login.quick.select_peer')}</p>
                        {peers.length === 0 ? (
                            <p className="text-xs text-theme-subtext py-1">{t('login.quick.no_peers')}</p>
                        ) : (
                            <div className="space-y-1 max-h-28 overflow-y-auto">
                                {peers.map(peer => {
                                    const id = `${peer.ip}:${peer.port}`;
                                    return (
                                        <label key={id} className="flex items-center gap-2 text-sm text-theme-text cursor-pointer">
                                            <input
                                                type="radio"
                                                name="pair-peer"
                                                checked={selectedPeer === id}
                                                onChange={() => setSelectedPeer(id)}
                                                className="accent-[var(--accent-primary)]"
                                            />
                                            <span className="truncate">
                                                {peer.name.replace(/^MediaTrove_/i, '')}
                                                <span className="text-theme-subtext ml-1 text-xs">{peer.ip}</span>
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            inputMode="numeric"
                            value={manualCode}
                            onChange={(e) => setManualCode(e.target.value)}
                            placeholder={t('login.quick.code_placeholder')}
                            className="flex-1 px-3 py-2 text-sm rounded-lg border outline-none transition-all bg-theme-surface border-theme-border text-theme-text focus:border-theme-accent focus:ring-1 focus:ring-theme-accent placeholder-theme-subtext"
                        />
                        <button
                            type="button"
                            onClick={connectManual}
                            disabled={busy || !isTauri}
                            className="px-4 py-2 text-sm rounded-lg font-medium transition-all disabled:opacity-50 bg-theme-accent text-theme-bg hover:bg-theme-accent-hover flex items-center gap-1"
                        >
                            <Link2 className="w-4 h-4" />
                            {t('login.quick.connect')}
                        </button>
                    </div>
                    <div className="pt-1 border-t border-theme-border">
                        <p className="text-xs font-medium mb-1 text-theme-subtext">{t('login.quick.paste_label')}</p>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={pastePayload}
                                onChange={(e) => setPastePayload(e.target.value)}
                                placeholder="mediatrove://pair?..."
                                className="flex-1 px-3 py-2 text-xs rounded-lg border outline-none transition-all bg-theme-surface border-theme-border text-theme-text focus:border-theme-accent focus:ring-1 focus:ring-theme-accent placeholder-theme-subtext"
                            />
                            <button
                                type="button"
                                onClick={connectPaste}
                                disabled={busy || !isTauri}
                                className="px-4 py-2 text-sm rounded-lg font-medium transition-all disabled:opacity-50 bg-theme-accent text-theme-bg hover:bg-theme-accent-hover"
                            >
                                {t('login.quick.connect')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <label className="flex items-start gap-2 cursor-pointer">
                <input
                    type="checkbox"
                    checked={includeConfig}
                    onChange={(e) => setIncludeConfig(e.target.checked)}
                    disabled={busy}
                    className="mt-0.5 w-4 h-4 accent-[var(--accent-primary)]"
                />
                <span className="text-xs text-theme-subtext leading-relaxed">{t('login.quick.include_config')}</span>
            </label>

            <p className="text-xs text-theme-subtext">{t('login.quick.lan_note')}</p>

            {/* Escape hatch: without this, a failed pairing (no camera, expired
                code, no peers) strands the user on this screen with no way back. */}
            {onExit && (
                <div className="pt-2 text-center">
                    <button
                        type="button"
                        disabled={busy}
                        className="text-theme-accent hover:underline text-sm disabled:opacity-50"
                        onClick={onExit}
                    >
                        {t('login.back_to_login')}
                    </button>
                </div>
            )}
        </div>
    );
};
