import React, { useState } from 'react';
import { X, Save, Info, Link as LinkIcon, User, Calendar, Tag, Type } from 'lucide-react';
import { useCollectionStore } from '../store/useCollectionStore';
import { MediaItem, MediaType, CollectionCategory } from '../types/types';
import { v4 as uuidv4 } from 'uuid';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

interface AddMediaModalProps {
    onClose: () => void;
}

export const AddMediaModal: React.FC<AddMediaModalProps> = ({ onClose }) => {
    const { t } = useTranslation();
    const { addToCollection } = useCollectionStore();

    const [title, setTitle] = useState('');
    const [type, setType] = useState<MediaType>(MediaType.MOVIE);
    const [director, setDirector] = useState('');
    const [year, setYear] = useState('');
    const [description, setDescription] = useState('');
    const [posterUrl, setPosterUrl] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!title.trim()) {
            toast.error(t('add_modal.title_required', { defaultValue: 'Title is required' }));
            return;
        }

        const newItem: MediaItem = {
            id: uuidv4(),
            title: title.trim(),
            type: type,
            directorOrAuthor: director.trim() || '',
            releaseDate: year.trim() || '',
            description: description.trim() || '',
            posterUrl: posterUrl.trim() || undefined,
            status: 'To Watch',
            addedAt: new Date().toISOString(),
            isOngoing: type === MediaType.TV_SERIES || type === MediaType.COMIC || type === MediaType.SHORT_DRAMA,
            rating: '',
            cast: [],
            userRating: 0,
            category: CollectionCategory.TO_WATCH
        };

        addToCollection(newItem, CollectionCategory.TO_WATCH);
        toast.success(t('add_modal.success', { defaultValue: 'Added successfully' }));
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-2xl bg-theme-surface border border-theme-border rounded-theme shadow-theme overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-theme-border bg-theme-bg">
                    <h2 className="text-xl font-bold text-theme-accent">
                        {t('add_modal.title', { defaultValue: 'Add New Item' })}
                    </h2>
                    <button onClick={onClose} className="p-2 rounded-full hover:bg-theme-surface transition-colors">
                        <X className="w-6 h-6 text-theme-subtext" />
                    </button>
                </div>

                {/* Form Content */}
                <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Title & Type */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="md:col-span-2 space-y-2">
                            <label className="text-sm font-medium text-theme-subtext flex items-center gap-2">
                                <Type className="w-4 h-4" />
                                {t('media_card.title', { defaultValue: 'Title' })} <span className="text-red-500">*</span>
                            </label>
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all"
                                placeholder={t('add_modal.title_placeholder', { defaultValue: 'Enter title...' })}
                                autoFocus
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-subtext flex items-center gap-2">
                                <Tag className="w-4 h-4" />
                                {t('media_card.type', { defaultValue: 'Type' })}
                            </label>
                            <select
                                value={type}
                                onChange={(e) => setType(e.target.value as MediaType)}
                                className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all appearance-none"
                            >
                                {Object.values(MediaType).map((t) => (
                                    <option key={t} value={t}>{t}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Director & Year */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-subtext flex items-center gap-2">
                                <User className="w-4 h-4" />
                                {t('add_modal.director_label', { defaultValue: 'Director / Author' })}
                            </label>
                            <input
                                type="text"
                                value={director}
                                onChange={(e) => setDirector(e.target.value)}
                                className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all"
                                placeholder={t('add_modal.director_placeholder', { defaultValue: 'e.g. Christopher Nolan' })}
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-subtext flex items-center gap-2">
                                <Calendar className="w-4 h-4" />
                                {t('add_modal.year_label', { defaultValue: 'Year' })}
                            </label>
                            <input
                                type="text"
                                value={year}
                                onChange={(e) => setYear(e.target.value)}
                                className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all"
                                placeholder="YYYY"
                            />
                        </div>
                    </div>

                    {/* Poster URL */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-subtext flex items-center gap-2">
                            <LinkIcon className="w-4 h-4" />
                            {t('add_modal.poster_url_label', { defaultValue: 'Poster URL' })}
                        </label>
                        <input
                            type="url"
                            value={posterUrl}
                            onChange={(e) => setPosterUrl(e.target.value)}
                            className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none transition-all"
                            placeholder="https://..."
                        />
                        <p className="text-xs text-theme-subtext opacity-70">
                            {t('add_modal.poster_hint', { defaultValue: 'Leave empty to use a generated placeholder.' })}
                        </p>
                    </div>

                    {/* Description */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-subtext flex items-center gap-2">
                            <Info className="w-4 h-4" />
                            {t('add_modal.description_label', { defaultValue: 'Description' })}
                        </label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={4}
                            className="w-full p-3 rounded-xl border bg-theme-surface border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent focus:border-transparent outline-none resize-none"
                            placeholder={t('add_modal.description_placeholder', { defaultValue: 'Enter a brief summary...' })}
                        />
                    </div>
                </form>

                {/* Footer */}
                <div className="px-6 py-4 border-t flex justify-end items-center gap-3 border-theme-border bg-theme-bg">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 rounded-lg font-medium transition-colors text-theme-subtext hover:text-theme-text"
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        onClick={handleSubmit}
                        className="px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors bg-theme-accent text-theme-bg hover:bg-theme-accent-hover"
                    >
                        <Save className="w-4 h-4" />
                        {t('common.add', { defaultValue: 'Add Item' })}
                    </button>
                </div>
            </div>
        </div>
    );
};
