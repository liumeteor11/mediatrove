// Plain-assert tests for the update confidence guard. No framework — run:
//   npx tsx src/services/updateGuard.test.ts
import assert from 'node:assert';
import { buildUpdatePatch, parseUpdateProgress, compareUpdateProgress, UpdateCandidate } from './updateGuard';
import { MediaItem, MediaType } from '../types/types';

let counter = 0;
const makeItem = (over: Partial<MediaItem> = {}): MediaItem => ({
    id: `item-${++counter}`,
    title: '乱马1/2（2024年重制版动画·第3期）',
    directorOrAuthor: '',
    description: '',
    releaseDate: '2024-10-01',
    type: MediaType.TV_SERIES,
    isOngoing: true,
    ...over
});

const cand = (over: Partial<UpdateCandidate> = {}): UpdateCandidate => ({
    id: 'candidate-1',
    latestUpdateInfo: '第3季 第1集',
    isOngoing: true,
    ...over
});

// ---- progress text parsing ----
assert.deepStrictEqual(parseUpdateProgress('第3期'), null, 'bare season ordinal is not episode progress');
assert.deepStrictEqual(parseUpdateProgress('第3期 第1集'), { season: 3, ep: 1 });
assert.deepStrictEqual(parseUpdateProgress('第2季 第12集'), { season: 2, ep: 12 });
assert.deepStrictEqual(parseUpdateProgress('S5E8'), { season: 5, ep: 8 });
assert.deepStrictEqual(parseUpdateProgress('Season 2 Episode 8'), { season: 2, ep: 8 });
assert.deepStrictEqual(parseUpdateProgress('更新至680话'), { season: null, ep: 680 });
assert.deepStrictEqual(parseUpdateProgress('第1052章'), { season: null, ep: 1052 });
assert.strictEqual(parseUpdateProgress('2024年10月15日'), null, 'dates are not progress');
assert.strictEqual(parseUpdateProgress('播出中'), null, 'airing-state prose is not progress');
assert.strictEqual(compareUpdateProgress({ season: null, ep: 12 }, { season: 3, ep: 1 }) < 0, true, 'flat progress sorts before a later season');

// ---- progress text decisions ----
// Regression: stored ahead → the whole update is dropped.
assert.strictEqual(buildUpdatePatch(
    makeItem({ latestUpdateInfo: '第3季 第5集' }),
    cand({ latestUpdateInfo: '第3季 第1集' }),
    false
), null, 'regressed progress is dropped');

// Unparsable incoming text must not erase parsable stored data.
const t2 = buildUpdatePatch(
    makeItem({ latestUpdateInfo: '第3季 第5集', isOngoing: true }),
    cand({ latestUpdateInfo: '播出中', isOngoing: false }),
    false
)!;
assert.strictEqual(t2.latestUpdateInfo, '第3季 第5集', 'unparsable incoming text keeps stored wording');
assert.strictEqual(t2.isOngoing, true, 'same-progress AI guess cannot flip airing state');

// Unparsable stored text: AI guesses keep it, authoritative sources may replace it.
const t3a = buildUpdatePatch(
    makeItem({ latestUpdateInfo: '连载中', isOngoing: true }),
    cand({ latestUpdateInfo: '第5集', isOngoing: true }),
    false
)!;
assert.strictEqual(t3a.latestUpdateInfo, '连载中', 'AI guess may not overwrite unparsable stored text');
const t3b = buildUpdatePatch(
    makeItem({ latestUpdateInfo: '连载中', isOngoing: true }),
    cand({ latestUpdateInfo: '第5集', isOngoing: true }),
    true
)!;
assert.strictEqual(t3b.latestUpdateInfo, '第5集', 'authoritative source may fill unparsable stored text');

// Empty stored text may be filled by the AI check (nothing to corrupt).
const t3c = buildUpdatePatch(
    makeItem({ latestUpdateInfo: undefined }),
    cand({ latestUpdateInfo: '第3季 第1集' }),
    false
)!;
assert.strictEqual(t3c.latestUpdateInfo, '第3季 第1集', 'empty stored progress gets filled');

// Same progress: stored wording wins; only an authoritative source corrects airing state.
const t4a = buildUpdatePatch(
    makeItem({ latestUpdateInfo: '更新至第5集', isOngoing: true }),
    cand({ latestUpdateInfo: '第5集', isOngoing: false }),
    false
)!;
assert.strictEqual(t4a.latestUpdateInfo, '更新至第5集');
assert.strictEqual(t4a.isOngoing, true);
const t4b = buildUpdatePatch(
    makeItem({ latestUpdateInfo: '更新至第5集', isOngoing: true }),
    cand({ latestUpdateInfo: '第5集', isOngoing: false }),
    true
)!;
assert.strictEqual(t4b.isOngoing, false, 'authoritative airing-state correction applies');

// Genuine advance is accepted.
const t5 = buildUpdatePatch(
    makeItem({ latestUpdateInfo: '第2季 第12集' }),
    cand({ latestUpdateInfo: '第3季 第1集' }),
    false
)!;
assert.strictEqual(t5.latestUpdateInfo, '第3季 第1集');
assert.strictEqual(t5.isOngoing, true);

// ---- totalEpisodes decisions ----
// Authoritative + complete data may correct a wrong stored total (shrink).
const t6a = buildUpdatePatch(
    makeItem({ totalEpisodes: 24, latestUpdateInfo: '第2季 第12集' }),
    cand({ latestUpdateInfo: '第3季 第1集', totalEpisodes: 13, totalEpisodesPartial: false }),
    true
)!;
assert.strictEqual(t6a.totalEpisodes, 13, 'authoritative complete count corrects stored value');

// Authoritative + partial airing-season count must not shrink stored data.
const t6b = buildUpdatePatch(
    makeItem({ totalEpisodes: 12, latestUpdateInfo: '第3季 第5集' }),
    cand({ latestUpdateInfo: '第3季 第5集', totalEpisodes: 1, totalEpisodesPartial: true }),
    true
)!;
assert.strictEqual(t6b.totalEpisodes, undefined, 'partial airing-season count never shrinks a stored total');

// The floor: a total smaller than the claimed/stored progress is rejected even when complete.
const t6c = buildUpdatePatch(
    makeItem({ totalEpisodes: 12, latestUpdateInfo: '第3季 第5集' }),
    cand({ latestUpdateInfo: '第3季 第5集', totalEpisodes: 5, totalEpisodesPartial: false }),
    true
)!;
assert.strictEqual(t6c.totalEpisodes, 5, 'complete authoritative count may correct (same as claimed progress)');

const t6d = buildUpdatePatch(
    makeItem({ totalEpisodes: 12, latestUpdateInfo: '第3季 第5集', userProgress: 'S3E8' }),
    cand({ latestUpdateInfo: '第3季 第5集', totalEpisodes: 5, totalEpisodesPartial: false }),
    true
)!;
assert.strictEqual(t6d.totalEpisodes, undefined, 'a total below watched progress is rejected');

// Growth is always allowed.
const t6e = buildUpdatePatch(
    makeItem({ totalEpisodes: 12, latestUpdateInfo: '第3季 第5集' }),
    cand({ latestUpdateInfo: '第3季 第5集', totalEpisodes: 13, totalEpisodesPartial: false }),
    true
)!;
assert.strictEqual(t6e.totalEpisodes, 13);

// Year-like garbage in the stored count is always healable.
const t6f = buildUpdatePatch(
    makeItem({ totalEpisodes: 2024, latestUpdateInfo: '第1集' }),
    cand({ latestUpdateInfo: '第1集', totalEpisodes: 13 }),
    false
)!;
assert.strictEqual(t6f.totalEpisodes, 13, 'year-as-count garbage is healed');

// Verified AI may correct a plausible stored total; unverified AI may not.
const t6g = buildUpdatePatch(
    makeItem({ totalEpisodes: 24, latestUpdateInfo: '第3季 第5集' }),
    cand({ latestUpdateInfo: '第3季 第5集', totalEpisodes: 13, verified: true }),
    false
)!;
assert.strictEqual(t6g.totalEpisodes, 13, 'verified AI correction applies');
const t6h = buildUpdatePatch(
    makeItem({ totalEpisodes: 24, latestUpdateInfo: '第3季 第5集' }),
    cand({ latestUpdateInfo: '第3季 第5集', totalEpisodes: 13 }),
    false
)!;
assert.strictEqual(t6h.totalEpisodes, undefined, 'unverified AI shrink is omitted from the patch');

// Filling a missing total is always allowed — multi-season watched progress
// does not block a new season's count (different season scope).
const t6i = buildUpdatePatch(
    makeItem({ userProgress: 'S1E12', latestUpdateInfo: '' }),
    cand({ latestUpdateInfo: '第3季 第1集', totalEpisodes: 1, totalEpisodesPartial: true }),
    false
)!;
assert.strictEqual(t6i.totalEpisodes, 1, 'new season total fills; watched S1 progress is out of scope');
assert.strictEqual(t6i.latestUpdateInfo, '第3季 第1集');

// With no parsable progress on either side, flat watched progress still bounds the total.
const t6j = buildUpdatePatch(
    makeItem({ userProgress: 'E12', latestUpdateInfo: '播出中' }),
    cand({ latestUpdateInfo: '播出中', totalEpisodes: 5, totalEpisodesPartial: false }),
    true
)!;
assert.strictEqual(t6j.totalEpisodes, undefined, 'a total below flat watched progress is rejected');

// ---- seasons decisions ----
// Ended show: authoritative per-season totals correct wrong stored values.
const t7a = buildUpdatePatch(
    makeItem({ tmdbId: 55, seasons: [{ season: 1, total: 12 }, { season: 2, total: 13 }], latestUpdateInfo: '第2季 第12集', isOngoing: false }),
    cand({ latestUpdateInfo: '第2季 第12集', isOngoing: false, totalEpisodes: 12, totalEpisodesPartial: false, seasons: [{ season: 1, total: 12 }, { season: 2, total: 12, released: 12 }] }),
    true
)!;
assert.deepStrictEqual(t7a.seasons, [{ season: 1, total: 12 }, { season: 2, total: 12, released: 12 }], 'complete authoritative season counts correct stored values');

// In-progress season with only aired episodes listed: stored total is kept.
const t7b = buildUpdatePatch(
    makeItem({ tmdbId: 55, seasons: [{ season: 3, total: 12 }], totalEpisodes: 12, latestUpdateInfo: '第3季 第5集' }),
    cand({ latestUpdateInfo: '第3季 第5集', isOngoing: true, totalEpisodesPartial: true, seasons: [{ season: 3, total: 6, released: 6 }] }),
    true
)!;
assert.deepStrictEqual(t7b.seasons, [{ season: 3, total: 12, released: 6 }], 'partial airing season keeps the stored total but takes the airing state');

// A newly discovered season is appended.
const t7c = buildUpdatePatch(
    makeItem({ tmdbId: 55, seasons: [{ season: 1, total: 12 }], latestUpdateInfo: '第1季 第12集' }),
    cand({ latestUpdateInfo: '第2季 第3集', isOngoing: true, totalEpisodes: 13, totalEpisodesPartial: false, seasons: [{ season: 1, total: 12 }, { season: 2, total: 13, released: 3 }] }),
    true
)!;
assert.deepStrictEqual(t7c.seasons, [{ season: 1, total: 12 }, { season: 2, total: 13, released: 3 }]);
assert.strictEqual(t7c.totalEpisodes, 13, 'missing total is filled from the new season');

// A changed TMDB id means the stored seasons belong to another show: replace wholesale.
const t7d = buildUpdatePatch(
    makeItem({ tmdbId: 111, seasons: [{ season: 7, total: 161 }], totalEpisodes: 161, latestUpdateInfo: '第7季 第161集' }),
    cand({ tmdbId: 222, latestUpdateInfo: '第7季 第162集', isOngoing: true, totalEpisodes: 163, totalEpisodesPartial: false, seasons: [{ season: 7, total: 163, released: 162 }] }),
    true
)!;
assert.deepStrictEqual(t7d.seasons, [{ season: 7, total: 163, released: 162 }], 'wrong-show seasons are replaced wholesale');
assert.strictEqual(t7d.tmdbId, 222);

// Unchanged seasons are omitted from the patch (no churn).
const t7e = buildUpdatePatch(
    makeItem({ tmdbId: 55, seasons: [{ season: 1, total: 12 }], latestUpdateInfo: '第1季 第12集' }),
    cand({ latestUpdateInfo: '第1季 第12集', isOngoing: true, seasons: [{ season: 1, total: 12 }] }),
    true
)!;
assert.strictEqual(t7e.seasons, undefined, 'identical seasons are not rewritten');

// ---- watched data safety ----
// The patch structurally never carries userProgress, whatever comes in —
// even a candidate that smuggles a userProgress field is ignored.
const t8 = buildUpdatePatch(
    makeItem({ userProgress: 'S3E5', latestUpdateInfo: '第3季 第5集' }),
    { ...cand({ latestUpdateInfo: '第3季 第5集', totalEpisodes: 12 }), userProgress: 'S9E99' } as UpdateCandidate,
    false
)!;
assert.strictEqual('userProgress' in t8, false, 'watched progress is never written by an update check');

console.log('updateGuard tests passed');
