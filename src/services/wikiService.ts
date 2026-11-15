// Wikipedia as a secondary retrieval source for episode/chapter totals: series
// articles state counts ("全12话", "共13集", "24 episodes") in their lead
// section, which grounds the AI update check in a citable source. Purely
// best-effort — unreachable networks (the zh site is not directly reachable
// everywhere) simply contribute no context, never an error.

const WIKI_HOSTS: Record<string, string[]> = {
    zh: ['zh.wikipedia.org', 'en.wikipedia.org'],
    en: ['en.wikipedia.org']
};

const FETCH_TIMEOUT_MS = 8000;
const FRESH_TTL_MS = 6 * 60 * 60 * 1000;   // successful lookups
const EMPTY_TTL_MS = 30 * 60 * 1000;       // failures/blocked — retry sooner
const MAX_EXTRACT_CHARS = 1500;            // per article lead
const MAX_CONTEXT_CHARS = 2400;            // per title overall

const cache = new Map<string, { text: string; at: number }>();

const apiGet = async (host: string, params: Record<string, string>): Promise<any> => {
    const url = `https://${host}/w/api.php?${new URLSearchParams({
        format: 'json',
        formatversion: '2',
        origin: '*', // anonymous CORS
        ...params
    })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`wiki ${res.status}`);
    return res.json();
};

const searchPageIds = async (host: string, title: string): Promise<number[]> => {
    const data = await apiGet(host, {
        action: 'query',
        list: 'search',
        srsearch: title,
        srlimit: '3',
        srnamespace: '0'
    });
    const hits: any[] = data?.query?.search || [];
    return hits.map(h => h.pageid).filter((id: any) => typeof id === 'number');
};

const fetchExtracts = async (host: string, pageIds: number[]): Promise<string[]> => {
    const data = await apiGet(host, {
        action: 'query',
        prop: 'extracts',
        explaintext: '1',
        exintro: '1', // lead section: where totals are stated, keeps payloads small
        pageids: pageIds.join('|')
    });
    const pages: any[] = data?.query?.pages || [];
    return pages
        .map(p => (typeof p?.extract === 'string' ? p.extract.trim() : ''))
        .filter(t => t.length > 0);
};

// Lead-section extracts from the top-matching Wikipedia articles, joined and
// length-capped, ready to be embedded in an AI prompt. Returns '' when
// nothing usable was found (offline, blocked, or no article).
export const getWikiContext = async (title: string, lang: string = 'zh'): Promise<string> => {
    const q = String(title || '').trim();
    if (!q) return '';
    const key = `${lang}:${q}`;
    const hit = cache.get(key);
    if (hit) {
        const ttl = hit.text ? FRESH_TTL_MS : EMPTY_TTL_MS;
        if (Date.now() - hit.at < ttl) return hit.text;
    }
    let text = '';
    for (const host of WIKI_HOSTS[lang] || WIKI_HOSTS.en) {
        try {
            const ids = await searchPageIds(host, q);
            if (ids.length === 0) continue;
            const parts = await fetchExtracts(host, ids);
            text = parts
                .map(p => (p.length > MAX_EXTRACT_CHARS ? p.slice(0, MAX_EXTRACT_CHARS) + '…' : p))
                .join('\n');
            if (text) break;
        } catch {
            // blocked / offline / rate-limited: try the next host, else give up quietly
        }
    }
    if (text.length > MAX_CONTEXT_CHARS) text = text.slice(0, MAX_CONTEXT_CHARS) + '…';
    cache.set(key, { text, at: Date.now() });
    return text;
};
