import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ArrowDownToLine, RotateCw, X } from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'react-toastify';
import { isUpdaterSupported, describeUpdateError } from '../services/updateService';
import { useAppUpdateStore } from '../store/useAppUpdateStore';

// Dashboard entry for in-app updates: a labeled text button that checks GitHub
// releases, shows a badge state when a new version is published, and offers a
// one-click download + install + relaunch flow in a modal. The silent
// once-per-launch check lives in Layout (useAppUpdateStore.silentCheck).
export const UpdateButton: React.FC = () => {
  const { t } = useTranslation();
  const [showModal, setShowModal] = useState(false);
  const {
    currentVersion,
    update,
    checking,
    downloading,
    installed,
    downloaded,
    total,
    checkNow,
    install,
    relaunch
  } = useAppUpdateStore();

  if (!isUpdaterSupported) return null;

  // Explain the failure instead of surfacing a raw plugin error: friendly
  // reason + suggestion from describeUpdateError, plus the original message.
  const showError = (e: unknown, titleKey: 'update.check_failed' | 'update.update_failed') => {
    const info = describeUpdateError(e);
    toast.error(
      <div className="text-left">
        <p className="font-semibold">{t(titleKey)}</p>
        <p className="text-xs mt-1 leading-relaxed">{t(`update.error.${info.key}`, info.params)}</p>
        {info.raw && (
          <p className="text-[10px] font-mono opacity-60 mt-1 break-all">{info.raw}</p>
        )}
      </div>,
      { autoClose: 10000 }
    );
  };

  const handleClick = async () => {
    if (update) {
      setShowModal(true);
      return;
    }
    try {
      const found = await checkNow();
      if (found) {
        setShowModal(true);
      } else {
        toast.info(t('update.up_to_date'));
      }
    } catch (e) {
      showError(e, 'update.check_failed');
    }
  };

  const handleInstall = async () => {
    try {
      await install();
    } catch (e) {
      showError(e, 'update.update_failed');
    }
  };

  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  return (
    <>
      <button
        onClick={handleClick}
        className={clsx(
          'relative flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors focus:outline-none focus:ring-2 focus:ring-theme-accent',
          update && !showModal
            ? 'text-theme-accent hover:bg-theme-accent/10'
            : 'text-theme-subtext hover:text-theme-text hover:bg-theme-surface/50'
        )}
        title={t('update.button_tooltip')}
      >
        {update ? (
          <ArrowDownToLine className="w-4 h-4" />
        ) : (
          <RefreshCw className={clsx('w-4 h-4', checking && 'animate-spin')} />
        )}
        <span className="hidden sm:inline">
          {update
            ? t('update.update_available_short', { version: update.version })
            : checking
              ? t('update.checking')
              : t('update.button_label')}
        </span>
        {update && !showModal && (
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 animate-pulse sm:hidden" />
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
                  onClick={relaunch}
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
