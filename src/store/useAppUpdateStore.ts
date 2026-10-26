import { create } from 'zustand';
import { getVersion } from '@tauri-apps/api/app';
import { toast } from 'react-toastify';
import i18n from '../i18n';
import {
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  relaunchApp,
  isUpdaterSupported,
  type AppUpdateInfo
} from '../services/updateService';

interface AppUpdateState {
  currentVersion: string;
  update: AppUpdateInfo | null;
  checking: boolean;
  downloading: boolean;
  installed: boolean;
  downloaded: number;
  total: number | null;
  /** One silent check per launch, triggered from Layout; failures stay quiet. */
  silentCheck: () => Promise<void>;
  /** Manual check from the dashboard; throws raw error for UI classification. */
  checkNow: () => Promise<boolean>;
  /** Download + install the pending update; throws raw error for UI classification. */
  install: () => Promise<void>;
  relaunch: () => void;
}

let silentCheckStarted = false;

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  currentVersion: '',
  update: null,
  checking: false,
  downloading: false,
  installed: false,
  downloaded: 0,
  total: null,

  silentCheck: async () => {
    if (!isUpdaterSupported || silentCheckStarted) return;
    silentCheckStarted = true;
    try {
      set({ currentVersion: await getVersion() });
    } catch {
      // Version display only; ignore.
    }
    try {
      const info = await checkForAppUpdate(true);
      if (info) {
        set({ update: info });
        toast.info(i18n.t('update.available_toast', { version: info.version }));
      }
    } catch (e) {
      console.warn('Silent update check failed', e);
    }
  },

  checkNow: async () => {
    if (get().checking) return false;
    set({ checking: true });
    try {
      if (!get().currentVersion) {
        try {
          set({ currentVersion: await getVersion() });
        } catch {
          // ignore
        }
      }
      const info = await checkForAppUpdate(false);
      set({ update: info });
      return !!info;
    } finally {
      set({ checking: false });
    }
  },

  install: async () => {
    if (get().downloading) return;
    set({ downloading: true, installed: false, downloaded: 0 });
    try {
      await downloadAndInstallAppUpdate((downloaded, total) => set({ downloaded, total }));
      set({ installed: true });
    } finally {
      set({ downloading: false });
    }
  },

  relaunch: () => {
    void relaunchApp();
  }
}));
