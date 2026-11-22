// AI query-rewrite cache for "hard" search queries. When the structured
// sources can't match a query (acronyms like "AOS", loose descriptions,
// actor names), a short no-search AI call maps it to a few canonical title
// candidates that a second TMDB round can try. The mapping is cached so a
// repeated hard query doesn't pay the rewrite cost again — and once the user
// collects a confirmed work, the learned-alias store takes over as the
// authoritative mapping anyway.

const REWRITE_CACHE_KEY = 'media_tracker_query_rewrites_v1';
const REWRITE_CACHE_CAP = 100;
export const MAX_REWRITE_TERMS = 3;
const MAX_TERM_LENGTH = 80;

interface RewriteEntry {
    terms: string[];
    ts: number;
}

type RewriteStore = Record<string, RewriteEntry>;

const rewriteKey = (query: string): string =>
    String(query || '').toLowerCase().trim().replace(/\s+/g, ' ');

// Same normalization the search pipeline applies to titles: lowercase and
// strip everything non-alphanumeric.
const rewriteText = (v: string): string =>
    String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const readStore = (): RewriteStore => {
    try {
        const raw = localStorage.getItem(REWRITE_CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch {}
    return {};
};

const writeStore = (store: RewriteStore): void => {
    try {
        localStorage.setItem(REWRITE_CACHE_KEY, JSON.stringify(store));
    } catch {}
};

const sanitizeTerms = (terms: unknown[], originalQuery: string): string[] => {
    const origNorm = rewriteText(originalQuery);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of terms) {
        const term = String(raw || '').trim();
        if (!term || term.length > MAX_TERM_LENGTH) continue;
        const norm = rewriteText(term);
        // A "candidate" equal to the query itself adds nothing.
        if (!norm || norm === origNorm || seen.has(norm)) continue;
        seen.add(norm);
        out.push(term);
        if (out.length >= MAX_REWRITE_TERMS) break;
    }
    return out;
};

// Returns the cached rewrite candidates for a query, or [].
export const getCachedRewrite = (query: string): string[] => {
    const entry = readStore()[rewriteKey(query)];
    return entry && Array.isArray(entry.terms) ? entry.terms : [];
};

// Caches sanitized rewrite candidates for a query (oldest entry evicted when
// the table is full).
export const cacheRewrite = (query: string, terms: string[]): void => {
    const key = rewriteKey(query);
    const cleaned = sanitizeTerms(terms, query);
    if (!key || cleaned.length === 0) return;
    const store = readStore();
    if (!store[key]) {
        const keys = Object.keys(store);
        if (keys.length >= REWRITE_CACHE_CAP) {
            const oldest = keys.sort((a, b) => (store[a]?.ts || 0) - (store[b]?.ts || 0))[0];
            if (oldest) delete store[oldest];
        }
    }
    store[key] = { terms: cleaned, ts: Date.now() };
    writeStore(store);
};

const pullQuoted = (text: string, pattern: RegExp): string[] => {
    const out: string[] = [];
    const re = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
};

// Parses a rewrite model response into sanitized candidate terms. The model
// is asked for a JSON string array; anything else (code fences, prose, a
// {"terms": [...]} object) falls back to quoted-string extraction. The result
// is trimmed, capped, deduped, and stripped of the original query itself.
export const parseRewriteTerms = (raw: string, originalQuery: string): string[] => {
    const text = String(raw || '').replace(/```json|```/g, '').trim();
    if (!text) return [];
    let candidates: unknown[] = [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) candidates = parsed;
        else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).terms)) {
            candidates = (parsed as any).terms;
        }
    } catch {
        candidates = [
            ...pullQuoted(text, /"([^"]{1,80})"/),
            ...pullQuoted(text, /“([^”]{1,80})”/),
            ...pullQuoted(text, /'([^']{1,80})'/)
        ];
    }
    return sanitizeTerms(candidates.filter(s => typeof s === 'string'), originalQuery);
};
