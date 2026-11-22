// Learned query→title associations. When a user searches something the
// structured sources can't match ("AOS") and then explicitly collects the
// work the AI surfaced ("神盾局特工"), that add is a human-confirmed
// resolution of the query. Recording it lets the next identical query hit
// the structured search directly instead of re-deriving the same
// association through the slow AI round-trip.
//
// Storage is device-local (localStorage); carrying it across devices would
// need an entry in the sync payload.

const LEARNED_ALIAS_KEY = 'media_tracker_learned_aliases_v1';
const LEARNED_ALIAS_CAP = 200;

interface LearnedAliasEntry {
    title: string;
    ts: number;
}

type LearnedAliasStore = Record<string, LearnedAliasEntry>;

// Keys keep their inner whitespace (queries are matched the same way later);
// only casing and edge padding are normalized.
const aliasKey = (query: string): string =>
    String(query || '').toLowerCase().trim().replace(/\s+/g, ' ');

// Match text strips everything non-alphanumeric so "Agents of S.H.I.E.L.D."
// and "agents of shield" compare equal — the same normalization the search
// pipeline applies to titles.
const aliasText = (v: string): string =>
    String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const readAliasStore = (): LearnedAliasStore => {
    try {
        const raw = localStorage.getItem(LEARNED_ALIAS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch {}
    return {};
};

const writeAliasStore = (store: LearnedAliasStore): void => {
    try {
        localStorage.setItem(LEARNED_ALIAS_KEY, JSON.stringify(store));
    } catch {}
};

// Returns the human-confirmed title for a previously resolved query, or ''.
export const getLearnedAlias = (query: string): string => {
    const entry = readAliasStore()[aliasKey(query)];
    return entry && entry.title ? entry.title : '';
};

// Records a confirmed query→title mapping. Only exact-normalized matches are
// skipped ("dickinson" → "Dickinson" learned nothing). Containment is NOT a
// skip condition: "agent of shield" → "Marvel's Agents of S.H.I.E.L.D."
// overlaps textually, yet the raw query can still miss the structured
// sources — the recorded title is exactly what makes it hit next time.
export const recordLearnedAlias = (query: string, resolvedTitle: string): void => {
    const key = aliasKey(query);
    const title = String(resolvedTitle || '').trim();
    if (!key || !title) return;
    const qNorm = aliasText(key);
    const tNorm = aliasText(title);
    if (!qNorm || !tNorm) return;
    if (tNorm === qNorm) return;

    const store = readAliasStore();
    const existing = store[key];
    if (existing && aliasText(existing.title) === tNorm) return;

    // Cap the table: drop the oldest entry when a new one must fit.
    if (!existing) {
        const keys = Object.keys(store);
        if (keys.length >= LEARNED_ALIAS_CAP) {
            const oldest = keys.sort((a, b) => (store[a]?.ts || 0) - (store[b]?.ts || 0))[0];
            if (oldest) delete store[oldest];
        }
    }
    store[key] = { title, ts: Date.now() };
    writeAliasStore(store);
};
