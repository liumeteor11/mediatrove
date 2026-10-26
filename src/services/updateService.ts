import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

// The updater plugin is desktop-only; the JS API is unavailable on Android.
export const isUpdaterSupported = isTauri && !/android/i.test(navigator.userAgent);

export interface AppUpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

// The Update object from check() must be kept around: downloadAndInstall
// lives on it and re-checking would spawn a new download.
let pendingUpdate: Update | null = null;

export const checkForAppUpdate = async (silent: boolean = false): Promise<AppUpdateInfo | null> => {
  if (!isUpdaterSupported) return null;
  try {
    const update = await check();
    pendingUpdate = update;
    return update
      ? { version: update.version, notes: update.body ?? undefined, date: update.date ?? undefined }
      : null;
  } catch (e) {
    if (silent) {
      console.warn('Silent update check failed', e);
      return null;
    }
    throw e;
  }
};

export const downloadAndInstallAppUpdate = async (
  onProgress: (downloaded: number, total: number | null) => void
): Promise<void> => {
  if (!pendingUpdate) throw new Error('No pending update');
  let total: number | null = null;
  let downloaded = 0;
  await pendingUpdate.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null;
        downloaded = 0;
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        break;
      case 'Finished':
        downloaded = total ?? downloaded;
        break;
    }
    onProgress(downloaded, total);
  });
  // Consumed: force a fresh check before offering another update.
  pendingUpdate = null;
};

export const relaunchApp = async (): Promise<void> => {
  await relaunch();
};

export interface UpdateErrorInfo {
  /** i18n key suffix under `update.error.*` describing the root cause */
  key: string;
  params?: Record<string, unknown>;
  /** Original error text, shown to the user for transparency */
  raw?: string;
}

// Updater errors arrive as free-form strings from the Rust plugin. Classify
// them by substring so the UI can explain the actual failure reason
// (offline, GitHub rate limit, missing latest.json, bad signature, ...).
// Order matters: more specific patterns must be matched first.
export const describeUpdateError = (error: unknown): UpdateErrorInfo => {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const s = raw.toLowerCase();
  const pick = (key: string, params?: Record<string, unknown>): UpdateErrorInfo => ({
    key,
    params,
    raw: raw || undefined,
  });

  if (/(timed?\s*out|timeout)/.test(s)) return pick('timeout');
  if (/(dns|getaddrinfo|name\s*resolution|name or service not known|resolve)/.test(s)) return pick('network');
  if (/(tls|ssl|certificate)/.test(s)) return pick('tls');
  if (/(signature|pubkey|public\s*key|verify)/.test(s)) return pick('signature');
  if (/(404|not\s*found|no\s*release|norelease)/.test(s)) return pick('not_found');
  if (/(403|rate\s*limit|too\s*many\s*requests)/.test(s)) return pick('rate_limit');
  if (/(40[0589]|50\d|internal\s*server|bad\s*gateway|service\s*unavailable)/.test(s)) return pick('server');
  if (/(parse|decode|malformed|unexpected|invalid|json)/.test(s)) return pick('parse');
  if (/(network|connect|unreachable|reset|refused|aborted|offline|socket|proxy)/.test(s)) return pick('network');
  return pick('unknown');
};
