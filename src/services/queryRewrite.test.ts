// Plain-assert tests for the query-rewrite cache and response parsing. No
// framework — run:
//   npx tsx src/services/queryRewrite.test.ts
import assert from 'node:assert';
import { getCachedRewrite, cacheRewrite, parseRewriteTerms, MAX_REWRITE_TERMS } from './queryRewrite';

// Minimal localStorage stub (plain node has no storage).
const backing = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
    removeItem: (k: string) => { backing.delete(k); }
};

// ---- parseRewriteTerms ----
assert.deepStrictEqual(
    parseRewriteTerms('["Agents of S.H.I.E.L.D."]', 'AOS'),
    ['Agents of S.H.I.E.L.D.'],
    'clean JSON array passes through'
);
assert.deepStrictEqual(
    parseRewriteTerms('```json\n["Dickinson", "Emily Dickinson (doc)"]\n```', 'emily dickinson'),
    ['Dickinson', 'Emily Dickinson (doc)'],
    'code fences are stripped'
);
assert.deepStrictEqual(
    parseRewriteTerms('I would suggest "Falling Skies" or “V” (2009).', 'alien show'),
    ['Falling Skies', 'V'],
    'prose falls back to quoted-string extraction (straight and smart quotes)'
);
assert.deepStrictEqual(
    parseRewriteTerms('{"terms": ["The Expanse"]}', 'space show'),
    ['The Expanse'],
    'object wrapper is tolerated'
);
assert.deepStrictEqual(parseRewriteTerms('', 'AOS'), [], 'empty response');
assert.deepStrictEqual(parseRewriteTerms('[]', 'AOS'), [], 'empty array');
assert.deepStrictEqual(
    parseRewriteTerms('["aos", "Agents of S.H.I.E.L.D."]', 'AOS'),
    ['Agents of S.H.I.E.L.D.'],
    'candidates equal to the query (normalized) are dropped'
);
assert.deepStrictEqual(
    parseRewriteTerms('["A", "B", "C", "D"]', 'q'),
    ['A', 'B', 'C'],
    `candidates capped at MAX_REWRITE_TERMS (${MAX_REWRITE_TERMS})`
);
assert.deepStrictEqual(
    parseRewriteTerms('["same", "same", "other"]', 'q'),
    ['same', 'other'],
    'duplicate candidates deduped'
);
assert.deepStrictEqual(
    parseRewriteTerms('[123, null, "Valid"]', 'q'),
    ['Valid'],
    'non-string entries are dropped'
);

// ---- cache round-trip ----
cacheRewrite('AOS', ['Agents of S.H.I.E.L.D.']);
assert.deepStrictEqual(getCachedRewrite('AOS'), ['Agents of S.H.I.E.L.D.'], 'cached terms round-trip');
assert.deepStrictEqual(getCachedRewrite('aos '), ['Agents of S.H.I.E.L.D.'], 'cache key is case/pad-insensitive');
assert.deepStrictEqual(getCachedRewrite('never-cached'), [], 'unknown query returns []');

cacheRewrite('AOS', []); // empty terms must not overwrite
assert.deepStrictEqual(getCachedRewrite('AOS'), ['Agents of S.H.I.E.L.D.'], 'empty cache write is a no-op');

console.log('queryRewrite.test.ts: all assertions passed');
