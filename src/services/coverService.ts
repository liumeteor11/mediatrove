import { MediaItem, MediaType } from '../types/types';
import { fetchPosterFromSearch } from './aiService';
import { searchTMDB, getTMDBPosterUrl, tmdbLanguageForItem } from './tmdbService';
import { useAIStore } from '../store/useAIStore';

const RETRY_COUNT = 3;
const RETRY_DELAY = 2000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const fetchCover = async (item: MediaItem): Promise<string | undefined> => {
    let attempt = 0;
    while (attempt < RETRY_COUNT) {
        try {
            let coverUrl: string | undefined;
            console.log(`Fetching cover for ${item.title} (${item.type}), attempt ${attempt + 1}`);
            
            switch (item.type) {
                case MediaType.MOVIE:
                case MediaType.TV_SERIES:
                case MediaType.SHORT_DRAMA:
                    coverUrl = await fetchMovieCover(item);
                    break;
                case MediaType.BOOK:
                case MediaType.COMIC:
                    coverUrl = await fetchBookCover(item);
                    break;
                case MediaType.MUSIC:
                    coverUrl = await fetchMusicCover(item);
                    break;
                default:
                    {
                        const res = await fetchPosterFromSearch(item.title, item.releaseDate?.split('-')[0] || '', item.type);
                        coverUrl = res?.picked;
                    }
            }
            
            if (coverUrl) {
                console.log(`Found cover for ${item.title}: ${coverUrl}`);
                return coverUrl;
            }
            
            // If specific fetch returned nothing, try generic search as last resort for all types
            // (Only if specific fetch didn't already fallback to search internally)
            if (item.type === MediaType.BOOK || item.type === MediaType.MUSIC) {
                 const res = await fetchPosterFromSearch(item.title, item.releaseDate?.split('-')[0] || '', item.type);
                 coverUrl = res?.picked;
                 if (coverUrl) return coverUrl;
            }

            throw new Error("No cover found");
        } catch (e) {
            console.warn(`Attempt ${attempt + 1} failed for ${item.title}:`, e);
            attempt++;
            if (attempt < RETRY_COUNT) await sleep(RETRY_DELAY);
        }
    }
    console.warn(`Final failure to fetch cover for ${item.title}`);
    return undefined;
};

const fetchMovieCover = async (item: MediaItem): Promise<string | undefined> => {
    const s = useAIStore.getState();
    if (s.enableTmdb) {
        const tmdbType: 'movie' | 'tv' =
            item.type === MediaType.TV_SERIES || item.type === MediaType.SHORT_DRAMA ? 'tv' : 'movie';
        const year = (item.releaseDate || '').trim().slice(0, 4);
        const candidates = await searchTMDB(item.title, tmdbType, tmdbLanguageForItem(item));
        const best = (year && /^\d{4}$/.test(year))
            ? candidates.find(c => (c.release_date || c.first_air_date || '').startsWith(year))
            : candidates[0];
        const poster = best ? (getTMDBPosterUrl(best.poster_path) || undefined) : undefined;
        if (poster) return poster;
    }
    {
        const res = await fetchPosterFromSearch(item.title, item.releaseDate?.split('-')[0] || '', 'movie');
        return res?.picked;
    }
};

const fetchBookCover = async (item: MediaItem): Promise<string | undefined> => {
    // Try OpenLibrary
    try {
        const query = `title=${encodeURIComponent(item.title)}`;
        const author = item.directorOrAuthor ? `&author=${encodeURIComponent(item.directorOrAuthor)}` : '';
        // OpenLibrary Search API
        const res = await fetch(`https://openlibrary.org/search.json?${query}${author}&limit=1`);
        if (res.ok) {
            const data = await res.json();
            if (data.docs && data.docs.length > 0) {
                const doc = data.docs[0];
                if (doc.cover_i) {
                    return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
                } else if (doc.isbn && doc.isbn.length > 0) {
                    return `https://covers.openlibrary.org/b/isbn/${doc.isbn[0]}-L.jpg`;
                }
            }
        }
    } catch (e) {
        console.warn("OpenLibrary fetch failed", e);
    }
    
    return undefined;
};

const fetchMusicCover = async (item: MediaItem): Promise<string | undefined> => {
    // Try MusicBrainz
    try {
        const query = `release:${encodeURIComponent(item.title)}`;
        const artist = item.directorOrAuthor ? ` AND artist:${encodeURIComponent(item.directorOrAuthor)}` : '';
        // MusicBrainz Search API
        // User-Agent is required by MusicBrainz
        const res = await fetch(`https://musicbrainz.org/ws/2/release?query=${query}${artist}&fmt=json&limit=1`, {
            headers: {
                'User-Agent': 'MediaTrove/1.0'
            }
        });
        
        if (res.ok) {
            const data = await res.json();
            if (data.releases && data.releases.length > 0) {
                const release = data.releases[0];
                if (release.id) {
                    // Check Cover Art Archive
                    const artRes = await fetch(`https://coverartarchive.org/release/${release.id}`);
                    if (artRes.ok) {
                        const artData = await artRes.json();
                        if (artData.images && artData.images.length > 0) {
                            return artData.images[0].image;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn("MusicBrainz fetch failed", e);
    }

    return undefined;
};
