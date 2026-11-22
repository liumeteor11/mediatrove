import { invoke } from '@tauri-apps/api/core';
import { MediaItem } from '../types/types';
import { isPlaceholderPosterUrl } from './aiService';

/**
 * Posters are cached as local files (app_data/posters/{id}.img) by the Rust
 * backend so rendered posters survive URL decay, offline use and censored
 * networks. The webview reads them back as data URIs through get_poster_base64;
 * keeping the bytes out of collection.json keeps the sync payload sane while
 * the sync itself carries the files alongside the metadata.
 */

const localMemo = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

/** Returns a data URI for the locally cached poster, or null when absent. */
export const getLocalPoster = async (id: string): Promise<string | null> => {
    const memo = localMemo.get(id);
    if (memo) return memo;
    const running = inFlight.get(id);
    if (running) return running;
    const task = (async () => {
        try {
            if (!isTauri) return null;
            const res = await invoke<{ b64: string; mime: string } | null>('get_poster_base64', { id });
            if (!res?.b64) return null;
            const uri = `data:${res.mime};base64,${res.b64}`;
            localMemo.set(id, uri);
            return uri;
        } catch {
            return null;
        } finally {
            inFlight.delete(id);
        }
    })();
    inFlight.set(id, task);
    return task;
};

/** Downloads url into the local poster cache (proxy-aware on desktop). */
export const cachePoster = async (id: string, url: string): Promise<boolean> => {
    try {
        if (!isTauri || !url) return false;
        await invoke('cache_poster', { id, url });
        const uri = await getLocalPoster(id);
        return !!uri;
    } catch {
        return false;
    }
};

/**
 * Backfills the local cache for every tracked item that has a remote poster
 * but no local copy. Idempotent: already-cached items only cost one memoized
 * lookup. Fire-and-forget by design; call it after the collection loads and
 * whenever items are added or synced.
 */
export const sweepPosterCache = (items: MediaItem[], updateItem: (id: string, updates: Partial<MediaItem>) => void) => {
    (async () => {
        for (const item of items) {
            try {
                if (!item.posterUrl || isPlaceholderPosterUrl(item.posterUrl)) continue;
                if (item.posterLocalAt) continue;
                const local = await getLocalPoster(item.id);
                if (local) {
                    updateItem(item.id, { posterLocalAt: Date.now() });
                    continue;
                }
                const ok = await cachePoster(item.id, item.posterUrl);
                if (ok) updateItem(item.id, { posterLocalAt: Date.now() });
                await sleep(250); // gentle pacing so a cold sweep doesn't hammer the network
            } catch {
                // network misses are expected on unproxied devices; the sync
                // backfill will deliver the file instead
            }
        }
    })();
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
