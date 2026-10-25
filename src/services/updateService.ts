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
