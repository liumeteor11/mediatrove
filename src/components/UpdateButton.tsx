import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { RefreshCw, ArrowDownToLine, RotateCw, X } from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'react-toastify';
import {
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  relaunchApp,
  isUpdaterSupported,
  type AppUpdateInfo
} from '../services/updateService';

// Navbar entry for in-app updates: silently checks once on mount, shows a
// badge when a new release is published on GitHub, and offers a one-click
// download + install + relaunch flow in a modal.
export const UpdateButton: React.FC = () => {
  const { t } = useTranslation();
  const [currentVersion, setCurrentVersion] = useState('');
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    if (!isUpdaterSupported) return;
    getVersion().then(setCurrentVersion).catch(() => {});
    // One silent check per launch; failures stay quiet for offline users.
    checkForAppUpdate(true).then((info) => {
      if (info) {
        setUpdate(info);
        toast.info(t('update.available_toast', { version: info.version }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isUpdaterSupported) return null;

  const handleClick = async () => {
    if (update) {
      setShowModal(true);
      return;
    }
    setChecking(true);
    try {
      const info = await checkForAppUpdate(false);
      if (info) {
        setUpdate(info);
        setShowModal(true);
      } else {
        toast.info(t('update.up_to_date'));
      }
    } catch (e: any) {
      toast.error(`${t('update.check_failed')} ${e?.message || ''}`);
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = async () => {
    setDownloading(true);
    setInstalled(false);
    try {
      await downloadAndInstallAppUpdate((done, tot) => {
        setDownloaded(done);
        setTotal(tot);
      });
      setInstalled(true);
    } catch (e: any) {
      toast.error(`${t('update.update_failed')} ${e?.message || ''}`);
    } finally {
      setDownloading(false);
    }
  };

  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  return (
    <>
      <button
        onClick={handleClick}
        className="relative flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50 focus:outline-none focus:ring-2 focus:ring-theme-accent"
        title={t('update.button_tooltip')}
      >
        <RefreshCw className={clsx("w-4 h-4", checking && "animate-spin")} />
        {update && !showModal && (
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        )}
      </button>

      {showModal && update && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !downloading && setShowModal(false)}>
          <div className="bg-theme-surface border border-theme-border rounded-xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-theme-border">
              <h3 className="text-lg font-bold text-theme-text">{t('update.modal_title')}</h3>
              <button
                onClick={() => setShowModal(false)}
                disabled={downloading}
                className="p-1 rounded-md text-theme-subtext hover:bg-theme-bg hover:text-theme-text transition-colors disabled:opacity-40"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="flex items-center gap-6 text-sm">
                <div>
                  <p className="text-xs text-theme-subtext">{t('update.current_version')}</p>
                  <p className="font-medium text-theme-text">v{currentVersion || '-'}</p>
                </div>
                <div className="text-theme-subtext">→</div>
                <div>
                  <p className="text-xs text-theme-subtext">{t('update.new_version')}</p>
                  <p className="font-bold text-theme-accent">v{update.version}</p>
                </div>
              </div>

              {downloading && (
                <div>
                  <div className="flex justify-between text-xs text-theme-subtext mb-1">
                    <span>{t('update.downloading')}</span>
                    {percent !== null && <span>{percent}%</span>}
                  </div>
                  <div className="w-full h-2 rounded-full bg-theme-border overflow-hidden">
                    <div
                      className="h-full bg-theme-accent transition-all duration-200"
                      style={{ width: percent !== null ? `${percent}%` : '50%' }}
                    />
                  </div>
                </div>
              )}

              {installed && (
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-sm text-green-600 dark:text-green-500">
                  {t('update.install_done')}
                  <p className="mt-1 text-xs text-theme-subtext">{t('update.restart_hint')}</p>
                </div>
              )}

              {update.notes && !installed && (
                <div>
                  <p className="text-xs font-medium text-theme-subtext mb-1">{t('update.release_notes')}</p>
                  <div className="max-h-40 overflow-y-auto custom-scrollbar p-3 rounded-lg bg-theme-bg border border-theme-border text-sm text-theme-text whitespace-pre-wrap break-words">
                    {update.notes}
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-theme-border flex justify-end gap-2">
              {installed ? (
                <button
                  onClick={() => relaunchApp()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-theme-accent text-theme-bg font-bold hover:bg-theme-accent-hover transition-colors"
                >
                  <RotateCw className="w-4 h-4" />
                  {t('update.restart_now')}
                </button>
              ) : (
                <button
                  onClick={handleInstall}
                  disabled={downloading}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-theme-accent text-theme-bg font-bold hover:bg-theme-accent-hover transition-colors disabled:opacity-50"
                >
                  <ArrowDownToLine className={clsx("w-4 h-4", downloading && "animate-bounce")} />
                  {downloading ? t('update.downloading') : t('update.install_now')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
