// Plain-assert tests for the learned alias store. No framework — run:
//   npx tsx src/services/learnedAlias.test.ts
import assert from 'node:assert';
import { getLearnedAlias, recordLearnedAlias } from './learnedAlias';

// Minimal localStorage stub: the module targets browsers/Tauri webviews,
// but plain node has no storage — back it with a Map for the assertions.
const backing = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
    removeItem: (k: string) => { backing.delete(k); }
};

// ---- recording ----
recordLearnedAlias('AOS', '神盾局特工');
assert.strictEqual(getLearnedAlias('AOS'), '神盾局特工', 'confirmed mapping is returned');

recordLearnedAlias('  aos  ', '神盾局特工 第2季');
assert.strictEqual(getLearnedAlias('AOS'), '神盾局特工 第2季', 'key is case/pad-insensitive; later confirmation wins');

// ---- normalization ----
recordLearnedAlias('agent of shield', "Marvel's Agents of S.H.I.E.L.D.");
assert.strictEqual(getLearnedAlias('agent of shield'), "Marvel's Agents of S.H.I.E.L.D.",
    'cross-language and punctuation-differing mappings are recorded');

recordLearnedAlias('emily dickinson', 'Dickinson');
assert.strictEqual(getLearnedAlias('emily dickinson'), 'Dickinson',
    'containment overlap still records: the raw query can miss the structured sources');

// ---- exact-normalized match learns nothing ----
recordLearnedAlias('dickinson', 'Dickinson!');
assert.strictEqual(getLearnedAlias('dickinson'), '',
    'normalized-equal title adds no information and is skipped');

// ---- empty / invalid inputs ----
recordLearnedAlias('', 'whatever');
recordLearnedAlias('valid query', '');
recordLearnedAlias('   ', 'title');
assert.strictEqual(getLearnedAlias(''), '');
assert.strictEqual(getLearnedAlias('valid query'), '', 'empty title add must not record');
assert.strictEqual(getLearnedAlias('   '), '');

// ---- unknown query ----
assert.strictEqual(getLearnedAlias('never-recorded'), '');

console.log('learnedAlias.test.ts: all assertions passed');
