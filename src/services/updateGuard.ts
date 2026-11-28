import type { MediaItem, SeasonInfo, EpisodeSource } from '../types/types';

// Confidence layer between "newly retrieved data" (TMDB or AI) and the stored
// record. Every automatic writer of tracking data funnels through
// buildUpdatePatch, which compares old vs. new and refuses any change that
// would regress watched progress, shrink a plausible episode count without a
// trustworthy source, or write unverifiable AI guesses.

// Trust ranking of information sources (lower = more trustworthy). The
// STORED provenance (item.episodeSource) is compared against the INCOMING
// source tier on every check: a weaker source may never overwrite a value
// that came from a stronger one — growth and garbage-healing excepted.
// Values stored before provenance existed have no source and count as the
// weakest tier, keeping today's behavior for legacy data.
const SOURCE_TIER: Record<string, number> = { manual: 0, tmdb: 1, official: 2, wiki: 3, aggregator: 4, ai: 5 };
export const episodeSourceTier = (s?: EpisodeSource): number => (s ? (SOURCE_TIER[s.kind] ?? 5) : 5);

// Progress embedded in free-text update info, as (season, episode). Both parts
// are optional: comics/books track a flat chapter ("第1052章"), TV tracks
// season+episode ("第5季 第8集", "S5E8"). Dates and years must not read as
// progress — the digit rules mirror the episode-grid extraction on MediaCard.
export interface UpdateProgress { season: number | null; ep: number | null; }

export const parseUpdateProgress = (text?: string): UpdateProgress | null => {
    const s = String(text || '').trim();
    if (!s) return null;
    // Explicit season+episode markers first: they cannot be confused with dates.
    const se = s.match(/第\s*(\d{1,3})\s*[季期]\s*第?\s*(\d{1,4})\s*[集话話章]/)
        || s.match(/[Ss](\d{1,3})\s*[-·]?\s*[Ee](\d{1,4})\b/)
        || s.match(/season\s*(\d{1,3})\s*(?:[/·,，-]|ep\.?|episode)\s*(\d{1,4})/i);
    if (se) return { season: parseInt(se[1], 10), ep: parseInt(se[2], 10) };
    // Flat counters: an explicit unit wins ("第1052章", "更新至 680 话").
    const unit = s.match(/第\s*(\d{1,5})\s*[集话話章]/)
        || s.match(/(?:更新至|已更新至|更新到|已更新到|chapter|episode)\s*(\d{1,5})/i);
    if (unit) return { season: null, ep: parseInt(unit[1], 10) };
    // Last resort: the last bare number that is not date-shaped or year-like.
    let best: number | null = null;
    for (const m of s.matchAll(/\d+/g)) {
        const v = parseInt(m[0], 10);
        if (!Number.isFinite(v)) continue;
        const before = m.index! > 0 ? s.slice(m.index! - 1, m.index!) : '';
        const after = s.slice(m.index! + m[0].length, m.index! + m[0].length + 1);
        if (/[年月日/-]$/.test(before) || /^[年月日期季期/-]/.test(after)) continue;
        if (v >= 1900 && v <= 2100) continue;
        best = v;
    }
    return best != null ? { season: null, ep: best } : null;
};

// Null season (flat progress) sorts before any real season.
export const compareUpdateProgress = (a: UpdateProgress, b: UpdateProgress): number => {
    const sa = a.season ?? -1, sb = b.season ?? -1;
    if (sa !== sb) return sa - sb;
    return (a.ep ?? 0) - (b.ep ?? 0);
};

// Values in the 1900–2100 band read like years, not counts — the historical
// "year written as total episodes" corruption class. They are never written
// fresh, and an existing year-like stored value is always replaceable (heal).
const isYearLike = (v: number) => v >= 1900 && v <= 2100;

const plausibleCount = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 1 && !isYearLike(v);

// What a check can deliver. TMDB sets totalEpisodesPartial when its season
// total is merely the aired-so-far count of an in-progress season (the real
// total is still unknown); AI sets verified only when it actually confirmed
// the entry via search results or the supplied Wikipedia excerpts.
export interface UpdateCandidate {
    id?: string;
    latestUpdateInfo?: string;
    isOngoing?: boolean;
    totalEpisodes?: number;
    totalEpisodesPartial?: boolean;
    seasons?: SeasonInfo[];
    tmdbId?: number;
    tmdbMediaType?: 'movie' | 'tv';
    verified?: boolean;
    sourceUrl?: string; // Page the counts were read from (persisted as provenance)
}

// The vetted result: fields that were rejected are simply absent, so callers
// never overwrite the stored value. latestUpdateInfo/isOngoing are always
// present (the stored wording when the update adds nothing) so the "changed?"
// logic at the apply sites stays honest.
export interface SafeUpdate {
    id: string;
    latestUpdateInfo: string;
    isOngoing: boolean;
    totalEpisodes?: number;
    seasons?: SeasonInfo[];
    tmdbId?: number;
    tmdbMediaType?: 'movie' | 'tv';
    episodeSource?: EpisodeSource;
    updateConflict?: string;
}

// The stored watched/claimed progress a new total must still cover. A
// season-scoped total only has to cover progress in the same season; flat
// progress ("E12") bounds a flat total. When the text carries no number at
// all, only flat watched progress bounds the (current-season) total.
const progressFloor = (item: MediaItem, next: UpdateProgress | null): number => {
    let floor = 0;
    const watched = parseUpdateProgress(item.userProgress);
    if (next?.ep != null) {
        floor = next.ep;
        const sameScope = !next.season || !watched?.season || watched.season === next.season;
        if (sameScope && watched?.ep != null) floor = Math.max(floor, watched.ep);
    } else if (watched && watched.season == null && watched.ep != null) {
        floor = watched.ep;
    }
    return floor;
};

// Decide whether `incoming` may replace the stored totalEpisodes. Returns
// undefined = keep stored. Old data CAN be wrong, so replacement is allowed
// when the source is trustworthy — the bar differs by confidence tier:
// - authoritative (structured TMDB) may correct any plausible stored value as
//   long as it is not the partial "only aired episodes listed" count of an
//   in-progress season (and not a wrong-show match being healed);
// - verified AI (confirmed via search/Wikipedia) may correct too, floor-checked;
// - anything else only fills gaps or heals year-like garbage.
const decideTotal = (
    stored: number | undefined,
    incoming: number,
    opts: { authoritative: boolean; partial?: boolean; tmdbIdChanged: boolean; verified: boolean; floor: number; storedTier?: number; incomingTier?: number; storedManual?: boolean }
): number | undefined => {
    if (!plausibleCount(incoming)) return undefined;
    if (incoming < opts.floor) return undefined;
    if (stored == null) return incoming;               // fill gap
    if (isYearLike(stored)) return incoming;           // heal year-as-count garbage
    // A hand-entered total (manual provenance) is the user's word: no
    // automated source may move it — growth included — so a correction
    // survives every refresh. Disagreements surface as updateConflict on
    // the card; editing the card again re-pins the value.
    if (opts.storedManual) return undefined;
    if (incoming >= stored) return incoming;           // growth is always safe
    // Provenance gate: a weaker source may not talk a stronger-stored value
    // down (real regression: AI "verified" counts overwriting authoritative
    // TMDB data). Growth and garbage-healing above are still allowed.
    if ((opts.storedTier ?? 5) < (opts.incomingTier ?? 5)) return undefined;
    if (opts.authoritative && opts.tmdbIdChanged) return incoming; // previous match was another show
    if (opts.authoritative && !opts.partial) return incoming;      // complete structured data
    if (!opts.authoritative && opts.verified) return incoming;     // verified AI correction
    return undefined;                                  // protect the stored value
};

// Merge per-season counts: TMDB stays authoritative for seasons it reports as
// complete knowledge (finished season, or unaired episodes already listed);
// a partial airing season never shrinks a larger stored total.
const mergeSeasons = (
    stored: SeasonInfo[] | undefined,
    incoming: SeasonInfo[],
    opts: { authoritative: boolean; tmdbIdChanged: boolean; ongoing: boolean }
): SeasonInfo[] | undefined => {
    const clean = incoming.filter(s =>
        plausibleCount(s.total) && typeof s.season === 'number' && s.season > 0 && s.season <= 1000);
    if (clean.length === 0) return undefined;
    if (!stored || stored.length === 0) return clean;
    // A different TMDB id means the stored seasons belong to another show.
    if (opts.authoritative && opts.tmdbIdChanged) return clean;
    const byNumber = new Map(stored.map(s => [s.season, s]));
    const merged = clean.map(inc => {
        const prev = byNumber.get(inc.season);
        // "Partial" = the source only knows aired episodes of a season it
        // says is still running; such a total must not shrink stored data.
        const partial = opts.ongoing && inc.released != null && inc.released >= inc.total;
        let total = inc.total;
        if (prev) {
            total = decideTotal(prev.total, inc.total, {
                authoritative: opts.authoritative, partial, tmdbIdChanged: opts.tmdbIdChanged, verified: false, floor: 0
            }) ?? prev.total;
        }
        // The season the source explicitly reports airing state for wins;
        // otherwise keep the larger of the two released counts.
        let released: number;
        if (opts.authoritative && inc.released != null) {
            released = Math.max(0, Math.min(inc.released, total));
        } else {
            released = Math.min(Math.max(prev?.released ?? prev?.total ?? 0, inc.released ?? total), total);
        }
        const out: SeasonInfo = { season: inc.season, total };
        if (inc.released != null || prev?.released != null) out.released = released;
        return out;
    });
    // Stored seasons the source no longer reports are kept (non-regression),
    // unless the match itself changed.
    for (const prev of stored) {
        if (!clean.some(inc => inc.season === prev.season)) merged.push(prev);
    }
    merged.sort((a, b) => a.season - b.season);
    const same = stored.length === merged.length && stored.every((s, i) =>
        s.season === merged[i].season && s.total === merged[i].total && (s.released ?? undefined) === (merged[i].released ?? undefined));
    return same ? undefined : merged;
};

const drop = (item: MediaItem, reason: string) => {
    console.info(`[updateGuard] dropped update for "${item.title}": ${reason}`);
};

// Compare the stored record against a freshly retrieved update and return the
// fields that may be written, or null when the update must be discarded
// entirely. `authoritative` marks structured TMDB data; AI results pass false.
export const buildUpdatePatch = (
    item: MediaItem,
    update: UpdateCandidate,
    authoritative: boolean
): SafeUpdate | null => {
    const prevText = item.latestUpdateInfo;
    const nextText = (update.latestUpdateInfo ?? '').trim();
    const prev = parseUpdateProgress(prevText);
    const next = parseUpdateProgress(nextText);

    let info: string;
    let progressed = false; // a genuine advance (or authoritative fill of empty data)
    if (prev && next) {
        const cmp = compareUpdateProgress(prev, next);
        if (cmp > 0) {
            drop(item, `stored progress is ahead (${prevText} > ${nextText})`);
            return null; // the source regressed — the match or the answer is wrong
        }
        if (cmp === 0) {
            info = prevText ?? ''; // same progress: keep the stored wording
        } else {
            info = nextText;
            progressed = true;
        }
    } else if (!prev && next) {
        if (authoritative || !prevText) {
            // Structured sources may always fill in; an empty stored text has
            // nothing that could be corrupted by the fill either.
            info = nextText;
            progressed = true;
        } else {
            info = prevText; // stored unparsable text stays — no AI guess overwrite
        }
    } else if (prev && !next) {
        // Incoming text parses to nothing ("播出中", "TBD") — never let it
        // erase parsable stored data.
        info = prevText;
    } else {
        info = prevText ?? ''; // nothing parsable on either side: no churn
    }

    const ongoing = progressed || authoritative
        ? update.isOngoing ?? item.isOngoing
        : item.isOngoing; // a same-progress AI guess never flips airing state

    const patch: SafeUpdate = {
        id: update.id ?? item.id,
        latestUpdateInfo: info,
        isOngoing: ongoing
    };

    // Counts. Never carry userProgress — watched data is only ever written by
    // the user (grid click / edit modal), not by an update check. The floor is
    // derived from the text that will be stored plus the watched progress.
    const floor = progressFloor(item, parseUpdateProgress(info));
    // Provenance: what the stored value came from vs. what this check is.
    const storedTier = episodeSourceTier(item.episodeSource);
    const incomingTier = authoritative ? 1 : (update.verified === true && update.sourceUrl ? 4 : 5);
    const storedManual = item.episodeSource?.kind === 'manual';
    if (plausibleCount(update.totalEpisodes)) {
        const total = decideTotal(item.totalEpisodes, update.totalEpisodes, {
            authoritative,
            partial: update.totalEpisodesPartial,
            tmdbIdChanged: !!(item.tmdbId && update.tmdbId && item.tmdbId !== update.tmdbId),
            verified: update.verified === true,
            floor,
            storedTier,
            incomingTier,
            storedManual
        });
        if (total != null) {
            patch.totalEpisodes = total;
            patch.updateConflict = undefined; // a clean accepted update clears a past conflict
        } else if (storedTier < incomingTier && item.totalEpisodes != null && update.totalEpisodes < item.totalEpisodes) {
            // The rejection above was a provenance conflict, not junk: keep
            // the stored value and surface the disagreement to the user.
            const storedKind = item.episodeSource?.kind ?? 'legacy';
            patch.updateConflict = `已保留 ${item.totalEpisodes} 集（信源 ${storedKind}${item.episodeSource?.url ? '，' + item.episodeSource.url : ''}）；${authoritative ? 'TMDB' : 'AI'} 信源声称 ${update.totalEpisodes} 集`;
        } else if (storedManual && item.totalEpisodes != null && update.totalEpisodes !== item.totalEpisodes) {
            // Manual pin rejected the source: show what the source claims so
            // a persistently wrong source never silently overwrites (and the
            // user knows why the number refuses to change).
            patch.updateConflict = `总集数已锁定为手动值 ${item.totalEpisodes}（再次编辑卡片可修改）；${authoritative ? 'TMDB' : 'AI'} 信源报告 ${update.totalEpisodes} 集`;
        }
    }
    if (patch.totalEpisodes != null || patch.seasons || patch.latestUpdateInfo !== item.latestUpdateInfo) {
        // A manual pin survives a rejected source: the check was not allowed
        // to move the total, so it must not claim provenance over it either
        // (otherwise the next check would see a weak source and trample).
        if (!storedManual || patch.totalEpisodes != null) {
            patch.episodeSource = {
                kind: authoritative ? 'tmdb' : (update.verified === true && update.sourceUrl ? 'aggregator' : 'ai'),
                ...(update.sourceUrl ? { url: update.sourceUrl } : {}),
                at: Date.now(),
                ...(patch.totalEpisodes != null ? { total: patch.totalEpisodes } : {})
            };
        }
    }
    if (update.seasons && update.seasons.length > 0) {
        const seasons = mergeSeasons(item.seasons, update.seasons, {
            authoritative,
            tmdbIdChanged: !!(item.tmdbId && update.tmdbId && item.tmdbId !== update.tmdbId),
            ongoing: update.isOngoing === true
        });
        if (seasons) patch.seasons = seasons;
    }
    if (update.tmdbId != null) {
        patch.tmdbId = update.tmdbId;
        patch.tmdbMediaType = update.tmdbMediaType ?? 'tv';
    }
    return patch;
};
