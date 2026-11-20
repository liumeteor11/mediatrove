import React, { useState } from 'react';
import { X, Upload, AlertCircle, CheckCircle, FileText, Loader2, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCollectionStore } from '../store/useCollectionStore';
import { parseImportFile, ImportSource } from '../services/importService';
import clsx from 'clsx';
import { toast } from 'react-toastify';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

interface ImportMediaModalProps {
    onClose: () => void;
}

export const ImportMediaModal: React.FC<ImportMediaModalProps> = ({ onClose }) => {
    const { t } = useTranslation();
    const { importCollection } = useCollectionStore();
    useEscapeToClose(onClose);
    const [source, setSource] = useState<ImportSource>('trakt');
    const [file, setFile] = useState<File | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [result, setResult] = useState<{ success: number; failed: number; errors: string[] } | null>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
            setResult(null);
        }
    };

    const handleImport = async () => {
        if (!file) return;

        setIsProcessing(true);
        try {
            const content = await file.text();
            const res = await parseImportFile(content, source);
            
            if (res.items.length > 0) {
                importCollection(res.items);
                toast.success(t('import.success_msg', { count: res.items.length , defaultValue: `Imported ${res.items.length} items` }));
            }
            
            setResult({
                success: res.success,
                failed: res.failed,
                errors: res.errors
            });
        } catch (e: any) {
            toast.error(`${t('import.failed_msg', { defaultValue: 'Import Failed' })}: ${e.message}`);
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-2xl bg-theme-surface rounded-2xl shadow-2xl border border-theme-border flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-theme-border">
                    <h2 className="text-xl font-bold text-theme-text flex items-center gap-2">
                        <Upload className="w-6 h-6 text-theme-accent" />
                        {t('import.title', { defaultValue: "Import Media" })}
                    </h2>
                    <button 
                        onClick={onClose}
                        className="text-theme-subtext hover:text-theme-text transition-colors p-1 hover:bg-theme-bg rounded-lg"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 overflow-y-auto custom-scrollbar flex-1">
                    {!result ? (
                        <div className="space-y-6">
                            {/* Source Selection */}
                            <div>
                                <label className="block text-sm font-medium text-theme-text mb-2">
                                    {t('import.source_label', { defaultValue: "Source Platform" })}
                                </label>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    {(['trakt', 'letterboxd', 'douban'] as ImportSource[]).map((s) => (
                                        <button
                                            key={s}
                                            onClick={() => setSource(s)}
                                            className={clsx(
                                                "px-4 py-3 rounded-xl border-2 text-sm font-medium transition-all flex flex-col items-center gap-2",
                                                source === s
                                                    ? "border-theme-accent bg-theme-accent/5 text-theme-accent"
                                                    : "border-theme-border bg-theme-bg text-theme-subtext hover:border-theme-subtext/50"
                                            )}
                                        >
                                            <span className="capitalize">{s}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* File Upload */}
                            <div>
                                <label className="block text-sm font-medium text-theme-text mb-2">
                                    {t('import.file_label', { defaultValue: "CSV File" })}
                                </label>
                                <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-theme-border border-dashed rounded-xl hover:bg-theme-bg/50 transition-colors relative">
                                    <div className="space-y-1 text-center">
                                        <FileText className="mx-auto h-12 w-12 text-theme-subtext" />
                                        <div className="flex text-sm text-theme-subtext">
                                            <label htmlFor="file-upload" className="relative cursor-pointer rounded-md font-medium text-theme-accent hover:text-theme-accent-hover focus-within:outline-none">
                                                <span>{t('import.upload_btn', { defaultValue: "Upload a file" })}</span>
                                                <input id="file-upload" name="file-upload" type="file" accept=".csv" className="sr-only" onChange={handleFileChange} />
                                            </label>
                                            <p className="pl-1">{t('import.drag_drop', { defaultValue: "or drag and drop" })}</p>
                                        </div>
                                        <p className="text-xs text-theme-subtext">CSV up to 10MB</p>
                                    </div>
                                    {file && (
                                        <div className="absolute inset-0 bg-theme-surface flex items-center justify-center rounded-xl border-2 border-theme-accent">
                                            <div className="flex items-center gap-3">
                                                <FileText className="w-6 h-6 text-theme-accent" />
                                                <span className="text-sm font-medium text-theme-text">{file.name}</span>
                                                <button 
                                                    onClick={(e) => { e.preventDefault(); setFile(null); }}
                                                    className="p-1 hover:bg-theme-bg rounded-full text-theme-subtext hover:text-red-500"
                                                >
                                                    <X className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Help Text */}
                            <div className="bg-theme-bg/50 p-4 rounded-lg border border-theme-border">
                                <h4 className="text-sm font-medium text-theme-text mb-2 flex items-center gap-2">
                                    <Info className="w-4 h-4 text-theme-accent" />
                                    {t('import.guide_title', { defaultValue: "Import Guide" })}
                                </h4>
                                <ul className="text-xs text-theme-subtext space-y-1 list-disc list-inside">
                                    <li>{t('import.help_trakt')}</li>
                                    <li>{t('import.help_letterboxd')}</li>
                                    <li>{t('import.help_douban')}</li>
                                </ul>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            <div className="flex flex-col items-center justify-center py-8">
                                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4 text-green-600">
                                    <CheckCircle className="w-8 h-8" />
                                </div>
                                <h3 className="text-xl font-bold text-theme-text mb-1">{t('import.completed', { defaultValue: "Import Completed" })}</h3>
                                <p className="text-theme-subtext text-sm">
                                    {t('import.summary', { success: result.success, failed: result.failed , defaultValue: `Successfully imported ${result.success} items. ${result.failed} failed.` })}
                                </p>
                            </div>

                            {result.errors.length > 0 && (
                                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 max-h-40 overflow-y-auto custom-scrollbar">
                                    <h4 className="text-sm font-medium text-red-600 mb-2 flex items-center gap-2">
                                        <AlertCircle className="w-4 h-4" />
                                        {t('import.errors', { defaultValue: "Errors" })}
                                    </h4>
                                    <ul className="text-xs text-red-600/80 space-y-1">
                                        {result.errors.map((err, i) => (
                                            <li key={i}>{err}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-6 border-t border-theme-border flex justify-end gap-3">
                    {!result ? (
                        <>
                            <button
                                onClick={onClose}
                                className="px-4 py-2 rounded-lg font-medium transition-colors bg-theme-bg text-theme-subtext hover:bg-theme-border"
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                onClick={handleImport}
                                disabled={!file || isProcessing}
                                className={clsx(
                                    "px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2",
                                    !file || isProcessing
                                        ? "bg-theme-subtext/20 text-theme-subtext cursor-not-allowed"
                                        : "bg-theme-accent text-theme-bg hover:bg-theme-accent-hover"
                                )}
                            >
                                {isProcessing && <Loader2 className="w-4 h-4 animate-spin" />}
                                {t('import.start_btn', { defaultValue: "Start Import" })}
                            </button>
                        </>
                    ) : (
                        <button
                            onClick={onClose}
                            className="px-4 py-2 rounded-lg font-medium transition-colors bg-theme-accent text-theme-bg hover:bg-theme-accent-hover"
                        >
                            {t('common.close')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
