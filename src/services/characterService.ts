import { v4 as uuidv4 } from 'uuid';
import { callAI, callAIStream, describeAIError, providerSupportsTools } from './aiService';
import { getTMDBDetails } from './tmdbService';
import { MediaItem } from '../types/types';
import {
  CharacterCorrection,
  CharacterRelation,
  ChatMessage,
  ChatSession,
  DistilledCharacter,
  DistillOptions,
  ExpressionDNA,
  TimelineEvent,
} from '../types/character';
import { useAIStore } from '../store/useAIStore';

/**
 * Character distillation & roleplay chat.
 *
 * Distillation follows the distilly persona pipeline: source material is
 * analysed along expression DNA / mental models / decision heuristics /
 * interpersonal behaviour / boundaries dimensions into a structured profile,
 * and user corrections are kept in a dedicated layer that overrides the
 * persona instead of rewriting it.
 *
 * The chat prompt is assembled in layers (nanobot-style) and joined with
 * `---` separators: identity -> persona -> expression DNA -> corrections ->
 * archived-context summary -> conversation rules. History is trimmed from the
 * newest message backwards against a token budget and aligned to a user
 * message; older prefixes are folded into a rolling summary.
 */

// Roleplay reads better a bit above the media-analysis default temperature.
const CHAT_TEMPERATURE = 0.8;
// Character-name suggestions: a short list, but thinking models still need
// room for reasoning, hence an explicit budget plus the shared retry ladder.
const SUGGEST_MAX_TOKENS = 4000;
// A persona profile is a large JSON document, and thinking-only models spend
// most of their completion budget on reasoning before emitting it — at the
// default 2000 tokens Kimi K3 returns empty content with finish_reason=length.
// Distillation therefore imposes no cap of its own (`maxTokens: 'auto'`) and
// lets the provider's maximum apply; callAI still raises the budget if the
// provider truncates and lowers it if the provider rejects the value.
// Search stays on: profiles are grounded in web research about the work and the
// character (plus TMDb credits and the user's extra material).
const DISTILL_MAX_TOKENS = 'auto' as const;
// History window: nanobot-style newest-first budget (messages + chars).
const HISTORY_MAX_MESSAGES = 40;
const HISTORY_MAX_CHARS = 24000;
// Fold the oldest slice into the summary once this many fresh messages pile up.
const COMPACT_THRESHOLD = 30;
const COMPACT_KEEP_RECENT = 6;
const SUMMARY_MAX_CHARS = 2400;
const MAX_CORRECTIONS = 50;

const asStringArray = (v: any): string[] =>
  Array.isArray(v) ? v.map(x => String(x)).filter(s => s.trim().length > 0) : [];

/**
 * Models without tool definitions in scope sometimes answer with the tool call
 * as text ("[{\"name\":\"web_search\",\"arguments\":{...}}]"). Those entries must
 * never be mistaken for a character name.
 */
const TOOL_ECHO_NAMES = new Set(['web_search', 'websearch', 'search', 'websearchtool', 'tool', 'functions']);
const looksLikeToolEcho = (name: string, raw?: any): boolean => {
  const bare = String(name || '').trim().toLowerCase().replace(/^functions\./, '');
  if (!bare) return true;
  if (TOOL_ECHO_NAMES.has(bare)) return true;
  // snake_case / dotted identifiers are tool names, not characters
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(bare)) return true;
  if (raw && typeof raw === 'object' && ('arguments' in raw || 'function' in raw || 'parameters' in raw)) return true;
  return false;
};

const normalizeRelation = (v: any): CharacterRelation[] =>
  Array.isArray(v)
    ? v
        .filter(r => r && typeof r === 'object')
        .map(r => ({ name: String(r.name || '').trim(), relation: String(r.relation || '').trim() }))
        .filter(r => r.name && r.relation)
    : [];

const normalizeTimeline = (v: any): TimelineEvent[] =>
  Array.isArray(v)
    ? v
        .filter(e => e && typeof e === 'object')
        .map(e => ({ period: String(e.period || '').trim(), event: String(e.event || '').trim() }))
        .filter(e => e.period && e.event)
    : [];

const normalizeExpression = (v: any): ExpressionDNA | null => {
  if (!v || typeof v !== 'object') return null;
  const formality = Number(v.formality);
  return {
    tone: v.tone ? String(v.tone) : undefined,
    formality: Number.isFinite(formality) ? Math.min(5, Math.max(0, Math.round(formality))) : 0,
    catchphrases: asStringArray(v.catchphrases),
    vocabulary: asStringArray(v.vocabulary),
    sentenceStyle: v.sentenceStyle ? String(v.sentenceStyle) : undefined,
    exampleLines: asStringArray(v.exampleLines),
  };
};

/** Turn a raw AI JSON object into a complete DistilledCharacter. */
export const normalizeCharacterDraft = (raw: any, source: { title: string; mediaId?: string; type?: string }): DistilledCharacter | null => {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;
  // A leaked tool call is not a character ("web_search" once became a profile).
  if (looksLikeToolEcho(name, raw)) return null;
  const now = Date.now();
  return {
    id: uuidv4(),
    name,
    aliases: asStringArray(raw.aliases),
    sourceTitle: source.title,
    sourceMediaId: source.mediaId,
    sourceType: source.type,
    tagline: raw.tagline ? String(raw.tagline) : undefined,
    appearance: raw.appearance ? String(raw.appearance) : undefined,
    personality: asStringArray(raw.personality),
    mentalModels: asStringArray(raw.mentalModels),
    decisionHeuristics: asStringArray(raw.decisionHeuristics),
    interpersonal: raw.interpersonal ? String(raw.interpersonal) : undefined,
    boundaries: asStringArray(raw.boundaries),
    background: raw.background ? String(raw.background) : undefined,
    expression: normalizeExpression(raw.expression),
    relationships: normalizeRelation(raw.relationships),
    quotes: asStringArray(raw.quotes),
    externalViews: asStringArray(raw.externalViews),
    timeline: normalizeTimeline(raw.timeline),
    corrections: [],
    version: 1,
    greeting: raw.greeting ? String(raw.greeting) : undefined,
    createdAt: now,
    updatedAt: now,
  };
};

/** Incremental merge (distilly merger): new analysis fills/updates the profile
 *  without touching the character's identity, corrections or history. */
export const mergeCharacterDraft = (existing: DistilledCharacter, draft: DistilledCharacter): DistilledCharacter => {
  const fillStr = (a?: string, b?: string) => (b && b.trim() ? b : a);
  const mergeArr = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));
  return {
    ...existing,
    aliases: mergeArr(existing.aliases, draft.aliases),
    tagline: fillStr(existing.tagline, draft.tagline),
    appearance: fillStr(existing.appearance, draft.appearance),
    personality: mergeArr(existing.personality, draft.personality),
    mentalModels: mergeArr(existing.mentalModels, draft.mentalModels),
    decisionHeuristics: mergeArr(existing.decisionHeuristics, draft.decisionHeuristics),
    interpersonal: fillStr(existing.interpersonal, draft.interpersonal),
    boundaries: mergeArr(existing.boundaries, draft.boundaries),
    background: fillStr(existing.background, draft.background),
    expression: draft.expression || existing.expression,
    relationships: (() => {
      const map = new Map(existing.relationships.map(r => [r.name.toLowerCase(), r]));
      draft.relationships.forEach(r => map.set(r.name.toLowerCase(), r));
      return Array.from(map.values());
    })(),
    quotes: mergeArr(existing.quotes, draft.quotes),
    externalViews: mergeArr(existing.externalViews, draft.externalViews),
    timeline: (() => {
      const seen = new Set(existing.timeline.map(t => `${t.period}|${t.event}`));
      const added = draft.timeline.filter(t => !seen.has(`${t.period}|${t.event}`));
      return [...existing.timeline, ...added];
    })(),
    greeting: fillStr(existing.greeting, draft.greeting),
    sourceMediaId: existing.sourceMediaId || draft.sourceMediaId,
    sourceType: existing.sourceType || draft.sourceType,
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
};

const buildDistillSystemPrompt = (language: 'zh' | 'en'): string => {
  const outputLang = language === 'en'
    ? 'Write all profile content in English.'
    : '所有画像内容使用中文书写（角色名可保留原文）。';
  return `You are an expert fictional-character analyst and persona modeller. Distill characters from a media work into structured, dialogue-ready persona profiles.

Analyse every character along these dimensions (distilly persona framework):
1. Expression DNA: overall tone, formality (1 = very formal ... 5 = very colloquial), catchphrases, characteristic vocabulary, sentence style (short sentences / rhetorical questions / conclusion-first...), and example lines (3-6, quote the original work faithfully when possible).
2. Mental models: core beliefs, thinking patterns, values (3-6 items).
3. Decision heuristics: what they prioritise when choosing, what triggers them to act, how they disagree or respond to challenges (2-5 items).
4. Interpersonal behaviour: how they treat different kinds of people, one paragraph.
5. Boundaries: things they resist, topics they avoid, red lines (1-4 items).
6. Timeline: key life events in order (period + event, 3-6 items).
7. External views: how other characters and the audience typically perceive them (1-4 items).
8. Relationships: ties to other characters (name + relation).

Rules:
- Priority: user-provided extra material > work metadata > your own knowledge. When in doubt, follow the original work.
- Leave a dimension empty (empty array / omit string) when the material does not support it. Never fabricate quotes.
- ${outputLang}
- Output ONLY a valid JSON array — no markdown fences, no commentary.

Each array element must use exactly these fields:
{
  "name": string,
  "aliases": string[],
  "tagline": string (one-sentence persona, under 40 chars),
  "appearance": string,
  "personality": string[] (3-6 trait labels),
  "mentalModels": string[],
  "decisionHeuristics": string[],
  "interpersonal": string,
  "boundaries": string[],
  "background": string (life story, under 160 words),
  "expression": { "tone": string, "formality": number, "catchphrases": string[], "vocabulary": string[], "sentenceStyle": string, "exampleLines": string[] },
  "relationships": [{ "name": string, "relation": string }],
  "quotes": string[] (3-6 signature quotes),
  "externalViews": string[],
  "timeline": [{ "period": string, "event": string }],
  "greeting": string (an in-character opening line the character says to greet the user, 1-3 sentences)
}`;
};

const buildDistillUserPrompt = (item: MediaItem, opts: DistillOptions, creditLines: string[], existingNames: string[], searchEnabled: boolean): string => {
  const parts: string[] = [];
  parts.push(`[Work] ${item.title} (${item.type}${item.releaseDate ? `, ${item.releaseDate}` : ''}${item.directorOrAuthor ? `, by ${item.directorOrAuthor}` : ''})`);
  if (searchEnabled) {
    parts.push('[Research] You have a web_search tool. Search for this work and the target character — cast list, plot, background, notable scenes and quotes — before writing the profile, and ground the quote/timeline fields in what the search returns. Never fabricate quotes; leave the field empty instead.');
  }
  if (item.description) parts.push(`[Synopsis] ${item.description}`);
  if (creditLines.length > 0) parts.push(`[Cast & characters]\n${creditLines.join('\n')}`);
  else if (item.cast && item.cast.length > 0) parts.push(`[Cast & characters]\n${item.cast.join(', ')}`);
  if (item.userReview) parts.push(`[Owner's notes] ${item.userReview}`);
  if (opts.extraMaterial && opts.extraMaterial.trim()) parts.push(`[Extra material]\n${opts.extraMaterial.trim()}`);
  if (opts.characterName && opts.characterName.trim()) {
    parts.push(`[Target character] ${opts.characterName.trim()}\nDistill ONLY this character and output a single-element array. If the material barely covers them, still build the best-supported profile for them instead of picking someone else.`);
  }
  if (opts.focus && opts.focus.trim()) parts.push(`[Focus] ${opts.focus.trim()}`);
  parts.push(`[Limit] Distill at most ${opts.maxCharacters || 3} characters, main characters first.`);
  parts.push(`[Existing profiles] ${existingNames.length > 0 ? existingNames.join(', ') : 'none'}`);
  if (existingNames.length > 0) {
    parts.push('For characters that already exist in [Existing profiles], produce an updated full profile; the caller will merge it incrementally (corrections and history are preserved).');
  }
  return parts.join('\n\n');
};

/**
 * Whether a search provider is usable right now: forcing a tool round with no
 * credentials wastes a request and makes models echo the tool call back as text.
 */
const searchBackendConfigured = (): boolean => {
  const {
    searchProvider,
    getDecryptedVertexKey,
    vertexSearchProject,
    vertexSearchEngine,
    getDecryptedSerperKey,
    getDecryptedYandexKey,
    yandexSearchLogin,
  } = useAIStore.getState();
  if (searchProvider === 'vertex') return !!(getDecryptedVertexKey() && vertexSearchProject && vertexSearchEngine);
  if (searchProvider === 'serper') return !!getDecryptedSerperKey();
  if (searchProvider === 'yandex') return !!(getDecryptedYandexKey() && yandexSearchLogin);
  return true; // duckduckgo needs no credentials
};

/** Best-effort cast/character lines from TMDb credits when the item is linked. */
const gatherCreditLines = async (item: MediaItem): Promise<string[]> => {
  if (!item.tmdbId || !item.tmdbMediaType) return [];
  const { enableTmdb, getDecryptedTmdbKey } = useAIStore.getState();
  if (!enableTmdb) return [];
  try {
    const details = await getTMDBDetails(item.tmdbId, item.tmdbMediaType as 'movie' | 'tv');
    const cast = details?.credits?.cast;
    if (!Array.isArray(cast)) return [];
    return cast
      .slice(0, 12)
      .map((c: any) => {
        const character = c.character ? ` as ${c.character}` : '';
        return `- ${c.name}${character}`;
      })
      .filter((l: string) => l.trim().length > 2);
  } catch (e) {
    console.warn('Character distillation: TMDb credits unavailable', e);
    return [];
  }
};

const extractJsonArray = (text: string): any[] | null => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const collect = (parsed: any): any[] | null => {
    if (!Array.isArray(parsed)) return null;
    // Drop leaked tool calls ("[{\"name\":\"web_search\",\"arguments\":…}]") so they
    // can never become a character profile.
    const kept = parsed.filter(item => item && typeof item === 'object' && !looksLikeToolEcho(String(item.name || ''), item));
    return kept.length > 0 ? kept : null;
  };
  const match = candidate.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (match) {
    try {
      const parsed = collect(JSON.parse(match[0]));
      if (parsed) return parsed;
    } catch {}
  }
  const single = candidate.match(/\{\s*"name"[\s\S]*\}/);
  if (single) {
    try {
      const parsed = collect([JSON.parse(single[0])]);
      if (parsed) return parsed;
    } catch {}
  }
  return null;
};

export interface DistillResult {
  characters: DistilledCharacter[];
  created: number;
  updated: number;
}

/**
 * Distill characters for a media item and merge them into `existing`.
 * Returns only the affected characters (new + updated); the caller persists them.
 */
export const distillCharacters = async (
  item: MediaItem,
  existing: DistilledCharacter[],
  opts: DistillOptions = {}
): Promise<DistillResult> => {
  const language: 'zh' | 'en' = opts.language || 'zh';
  const maxCharacters = opts.characterName?.trim()
    ? 1
    : Math.min(8, Math.max(1, opts.maxCharacters || 3));

  const creditLines = await gatherCreditLines(item);
  const sameSource = existing.filter(
    c =>
      (item.id && c.sourceMediaId === item.id) ||
      c.sourceTitle.trim().toLowerCase() === item.title.trim().toLowerCase()
  );

  const messages = [
    { role: 'system', content: buildDistillSystemPrompt(language) },
    // The [Research] directive is only honest for providers that actually get
    // the web_search tool injected (see providerSupportsTools) and only useful
    // when a search provider is configured.
    { role: 'user', content: buildDistillUserPrompt(item, { ...opts, maxCharacters }, creditLines, sameSource.map(c => c.name), providerSupportsTools(useAIStore.getState().provider) && searchBackendConfigured()) },
  ];

  // Attempt 1 searches when possible; if the model answers with something we
  // cannot read (typically a leaked tool call), retry once with no tools in
  // scope and an explicit format nudge before giving up.
  const attempt = async (withSearch: boolean): Promise<any[] | null> => {
    const search = withSearch && searchBackendConfigured();
    const text = await callAI(messages, 0.3, {
      maxTokens: DISTILL_MAX_TOKENS,
      forceSearch: search,
      disableSearch: !search,
      reasoningEffort: useAIStore.getState().distillReasoning,
    });
    if (!text) throw new Error('empty-ai-response');
    return extractJsonArray(text);
  };

  let rawList = await attempt(true);
  if (!rawList) {
    messages.push({
      role: 'user',
      content: 'Output only the JSON array of character profiles now, using exactly the fields listed above. Do not call or name any tool, and do not add commentary.',
    });
    rawList = await attempt(false);
  }
  if (!rawList || rawList.length === 0) throw new Error('no-json-array');

  const source = { title: item.title, mediaId: item.id, type: String(item.type) };
  const affected: DistilledCharacter[] = [];
  let created = 0;
  let updated = 0;

  for (const raw of rawList.slice(0, maxCharacters)) {
    const draft = normalizeCharacterDraft(raw, source);
    if (!draft) continue;
    const norm = (s: string) => s.trim().toLowerCase();
    const matchIdx = sameSource.findIndex(
      c =>
        norm(c.name) === norm(draft.name) ||
        c.aliases.some(a => norm(a) === norm(draft.name)) ||
        draft.aliases.some(a => norm(a) === norm(c.name))
    );
    if (matchIdx >= 0) {
      const merged = mergeCharacterDraft(sameSource[matchIdx], draft);
      sameSource[matchIdx] = merged;
      affected.push(merged);
      updated++;
    } else {
      sameSource.push(draft);
      affected.push(draft);
      created++;
    }
  }

  if (affected.length === 0) throw new Error('no-characters');
  return { characters: affected, created, updated };
};

export interface CharacterNameSuggestions {
  /** Character names already known from the work's credits (no AI call needed). */
  fromCredits: string[];
  /** Names the model found for this work; empty when it returned nothing usable. */
  fromAI: string[];
}

/** Lookups already paid for, keyed by work title + language + limit. */
const nameSuggestionCache = new Map<string, CharacterNameSuggestions>();

/** Tolerant read of a name list from model output (JSON array, fenced or not). */
const extractNameList = (text: string): string[] => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .map(x => (typeof x === 'string' ? x : String(x?.name || x?.character || '')))
          .map(s => s.trim())
          .filter(s => s.length > 0 && s.length <= 40 && !looksLikeToolEcho(s));
      }
    } catch {}
  }
  // Fallback: one name per line, stripped of bullets and numbering.
  return candidate
    .split(/\r?\n|[、,；;]/)
    .map(s => s.replace(/^[\s\-*•\d.)、]+/, '').trim())
    .filter(s => s.length > 0 && s.length <= 40);
};

/** Character names we already know from the work's TMDb credits ("Actor as Character"). */
const creditCharacterNames = async (item: MediaItem): Promise<string[]> => {
  const lines = await gatherCreditLines(item);
  return lines
    .map(line => line.split(/\s+as\s+/i)[1] || '')
    .map(name => name.trim())
    .filter(name => name.length > 0);
};

/**
 * Suggest characters for a work: TMDb credits when the item is linked, plus the
 * model's own list (with web search available for works it may not know).
 * Results are cached per work/language so reopening the dialog is free; pass
 * `refresh: true` (the "search again" button) to force a fresh lookup.
 * Throws when the AI call fails so the caller can surface the real reason.
 */
export const suggestCharacterNames = async (
  item: MediaItem,
  opts: { language?: 'zh' | 'en'; limit?: number; refresh?: boolean } = {}
): Promise<CharacterNameSuggestions> => {
  const language: 'zh' | 'en' = opts.language || 'zh';
  const limit = Math.min(20, Math.max(3, opts.limit || 12));
  const cacheKey = `${item.title.trim().toLowerCase()}|${language}|${limit}`;
  if (!opts.refresh) {
    const cached = nameSuggestionCache.get(cacheKey);
    if (cached) return cached;
  }
  const fromCredits = await creditCharacterNames(item);

  const hasSearchBackend = searchBackendConfigured();

  const parts: string[] = [];
  parts.push(`[Work] ${item.title} (${item.type}${item.releaseDate ? `, ${item.releaseDate}` : ''}${item.directorOrAuthor ? `, by ${item.directorOrAuthor}` : ''})`);
  if (item.description) parts.push(`[Synopsis] ${item.description}`);
  if (fromCredits.length > 0) parts.push(`[Known characters] ${fromCredits.join(', ')}`);
  parts.push(`[Task] List the main characters of this work — named people/roles only, protagonists first, then important supporting characters, at most ${limit}. Exclude objects, gadgets, places, organizations, one-off extras, and anything you are not confident actually appears in the work.${hasSearchBackend ? ' Use the web_search tool when you are not certain about this work.' : ''}`);
  parts.push('Reply with a JSON array of character-name strings only — no markdown, no commentary, no descriptions, and never a tool call, function name or object.');
  parts.push(language === 'en'
    ? 'Keep the names as they appear in the original work (non-English names stay in their original script).'
    : '角色名保留原文写法（中文作品用中文名）。');

  const systemPrompt = 'You are a media encyclopedia. You answer only with a JSON array of character names.';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: parts.join('\n\n') },
  ];

  const title = item.title.trim().toLowerCase();
  const cleanNames = (raw: string): string[] => {
    const seen = new Set<string>();
    return extractNameList(raw).filter(name => {
      const key = name.toLowerCase();
      if (key === title || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
  };

  let fromAI = cleanNames(await callAI(messages, 0.2, { maxTokens: SUGGEST_MAX_TOKENS, forceSearch: hasSearchBackend, disableSearch: !hasSearchBackend, reasoningEffort: useAIStore.getState().distillReasoning }));
  if (fromAI.length === 0) {
    // Nothing usable — typically the model answered with a leaked tool call.
    // Ask once more with no tools in scope and an explicit format nudge.
    messages.push({ role: 'user', content: 'Output only the JSON array of character-name strings now. Do not call or name any tool.' });
    fromAI = cleanNames(await callAI(messages, 0.2, { maxTokens: SUGGEST_MAX_TOKENS, disableSearch: true, reasoningEffort: useAIStore.getState().distillReasoning }));
  }

  const result: CharacterNameSuggestions = { fromCredits: fromCredits.slice(0, limit), fromAI };
  if (nameSuggestionCache.size >= 50) {
    const oldest = nameSuggestionCache.keys().next().value;
    if (oldest) nameSuggestionCache.delete(oldest);
  }
  nameSuggestionCache.set(cacheKey, result);
  return result;
};

/** Layered character chat system prompt (nanobot-style sections joined by ---). */
export const buildCharacterSystemPrompt = (character: DistilledCharacter, sessionSummary?: string): string => {
  const e = character.expression;
  const bullets = (items: string[]) => items.map(i => `- ${i}`).join('\n');

  const identity = `# Role
You ARE ${character.name}${character.aliases.length > 0 ? ` (also known as ${character.aliases.join(', ')})` : ''}, a character from the work "${character.sourceTitle}". Speak and act as this character at all times.`;

  const personaParts: string[] = [];
  if (character.tagline) personaParts.push(`One-line persona: ${character.tagline}`);
  if (character.personality.length > 0) personaParts.push(`Personality traits: ${character.personality.join(', ')}`);
  if (character.background) personaParts.push(`Background: ${character.background}`);
  if (character.appearance) personaParts.push(`Appearance: ${character.appearance}`);
  if (character.mentalModels.length > 0) personaParts.push(`Core beliefs & thinking patterns:\n${bullets(character.mentalModels)}`);
  if (character.decisionHeuristics.length > 0) personaParts.push(`Decision patterns:\n${bullets(character.decisionHeuristics)}`);
  if (character.interpersonal) personaParts.push(`Interpersonal behaviour: ${character.interpersonal}`);
  if (character.boundaries.length > 0) personaParts.push(`Boundaries & sore spots:\n${bullets(character.boundaries)}`);
  if (character.relationships.length > 0) personaParts.push(`Relationships:\n${character.relationships.map(r => `- ${r.name}: ${r.relation}`).join('\n')}`);
  if (character.quotes.length > 0) personaParts.push(`Signature quotes:\n${bullets(character.quotes)}`);
  const persona = `# Persona profile\n${personaParts.join('\n')}`;

  const expressionParts: string[] = [];
  if (e?.tone) expressionParts.push(`- Tone: ${e.tone}`);
  if (e?.formality && e.formality > 0) expressionParts.push(`- Formality: ${e.formality}/5 (1 = very formal, 5 = very colloquial)`);
  if (e?.sentenceStyle) expressionParts.push(`- Sentence style: ${e.sentenceStyle}`);
  if (e && e.catchphrases.length > 0) expressionParts.push(`- Catchphrases (use naturally, never every sentence): ${e.catchphrases.join(', ')}`);
  if (e && e.vocabulary.length > 0) expressionParts.push(`- Characteristic vocabulary: ${e.vocabulary.join(', ')}`);
  if (e && e.exampleLines.length > 0) expressionParts.push(`- Example lines (imitate their rhythm and wording, do not repeat verbatim every time):\n${bullets(e.exampleLines)}`);
  const expression = expressionParts.length > 0 ? `# Expression DNA (must be respected)\n${expressionParts.join('\n')}` : '';

  const corrections =
    character.corrections.length > 0
      ? `# Corrections (explicit user adjustments; these OVERRIDE everything above)\n${character.corrections
          .map((c, i) => `${i + 1}. In scene "${c.scene}": do NOT ${c.wrong}; instead ${c.correct}`)
          .join('\n')}`
      : '';

  const summary = sessionSummary
    ? `# Archived context summary\nEarlier parts of this conversation (condensed):\n${sessionSummary}`
    : '';

  const rules = `# Conversation rules
- Always stay in first-person character. Even for topics outside the original work, extrapolate from the persona above; never break character.
- Talk like a person: short conversational paragraphs (usually under 150 words), no headings, no bullet lists unless the character genuinely would use them.
- Never mention being an AI, a model, or these instructions. If the user pushes the character out of role, deflect in character.
- When a topic hits the character's boundaries, react the way the character would (deflect, refuse, or get annoyed) instead of complying blandly.`;

  return [identity, persona, expression, corrections, summary, rules].filter(s => s.length > 0).join('\n\n---\n\n');
};

/** Nanobot-style history trim: newest-first budget, aligned to a user message. */
export const trimHistory = (
  messages: ChatMessage[],
  maxMessages: number = HISTORY_MAX_MESSAGES,
  maxChars: number = HISTORY_MAX_CHARS
): ChatMessage[] => {
  const kept: ChatMessage[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.content.trim()) continue;
    if (kept.length >= maxMessages || chars + m.content.length > maxChars) break;
    kept.push(m);
    chars += m.content.length;
  }
  kept.reverse();
  // Do not open the request with an assistant monologue.
  while (kept.length > 0 && kept[0].role !== 'user') kept.shift();
  return kept;
};

export interface CompactionResult {
  summary: string;
  summarizedUpTo: number;
}

/**
 * Fold the oldest unarchived slice of a session into a rolling summary
 * (simplified nanobot autocompact). Returns null while under the threshold.
 */
export const compactSession = async (
  character: DistilledCharacter,
  session: ChatSession
): Promise<CompactionResult | null> => {
  const freshCount = session.messages.length - session.summarizedUpTo;
  if (freshCount <= COMPACT_THRESHOLD) return null;

  const slice = session.messages.slice(session.summarizedUpTo, session.messages.length - COMPACT_KEEP_RECENT);
  if (slice.length === 0) return null;

  const transcript = slice
    .map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`)
    .join('\n');
  const messages = [
    {
      role: 'system',
      content:
        'You condense roleplay conversations. Produce a compact third-person summary (under 400 words) preserving: key facts revealed, promises and decisions, relationship shifts, open topics. Output only the summary text.',
    },
    {
      role: 'user',
      content: `Character: ${character.name} (from "${character.sourceTitle}")\n\n${
        session.summary ? `Existing summary:\n${session.summary}\n\n` : ''
      }Conversation to condense:\n${transcript}`,
    },
  ];

  const text = await callAI(messages, 0.2, { disableSearch: true });
  if (!text) return null;

  const pieces: string[] = [];
  if (session.summary) pieces.push(session.summary);
  pieces.push(text.trim().slice(0, SUMMARY_MAX_CHARS));
  let summary = pieces.join('\n\n');
  if (summary.length > SUMMARY_MAX_CHARS) summary = `...${summary.slice(-SUMMARY_MAX_CHARS)}`;

  return { summary, summarizedUpTo: session.messages.length - COMPACT_KEEP_RECENT };
};

/** Build the request messages for one character chat turn. */
export const buildChatRequestMessages = (
  character: DistilledCharacter,
  session: ChatSession
): any[] => {
  const system = buildCharacterSystemPrompt(character, session.summary || undefined);
  const history = trimHistory(session.messages.slice(session.summarizedUpTo));
  return [{ role: 'system', content: system }, ...history.map(m => ({ role: m.role, content: m.content }))];
};

/**
 * One full chat turn: streams the assistant reply, forwarding each delta to
 * `onDelta`, and resolves with the full text (throws on failure).
 */
export const sendCharacterMessage = async (
  character: DistilledCharacter,
  session: ChatSession,
  onDelta?: (text: string) => void
): Promise<string> => {
  const messages = buildChatRequestMessages(character, session);
  let reply = '';
  try {
    reply = await callAIStream(messages, CHAT_TEMPERATURE, {
      onDelta: onDelta || (() => {}),
    });
  } catch (e) {
    // Streaming is the nicer path, not the only one: a provider that does not
    // speak SSE (or a mid-flight hiccup) should still produce a reply. Search
    // stays disabled — roleplay runs on the persona, not on the web.
    console.warn('Streaming reply failed, retrying without streaming', e);
    reply = await callAI(messages, CHAT_TEMPERATURE, { disableSearch: true });
  }
  if (!reply || !reply.trim()) throw new Error('empty-ai-response');
  return reply.trim();
};

/** i18n key (+ params) describing why a distillation failed, for toasts/UI. */
export const distillErrorKey = (e: unknown): { key: string; params?: Record<string, unknown> } => {
  const msg = String((e as any)?.message || e || '');
  const { auth, detail } = describeAIError(e);
  if (msg.includes('empty-ai-response')) return { key: 'characters.error_no_ai' };
  if (auth) return { key: 'characters.error_key_rejected' };
  if (msg.includes('no-json-array') || msg.includes('no-characters')) return { key: 'characters.error_bad_output' };
  if (detail) return { key: 'characters.distill_failed_detail', params: { detail: detail.slice(0, 180) } };
  return { key: 'characters.distill_failed' };
};

/** Add a correction (distilly correction layer), capped and merged by newest-first preference. */
export const addCorrectionToCharacter = (
  character: DistilledCharacter,
  correction: { scene: string; wrong: string; correct: string }
): DistilledCharacter => {
  const entry: CharacterCorrection = { ...correction, createdAt: Date.now() };
  const corrections = [entry, ...character.corrections].slice(0, MAX_CORRECTIONS);
  return { ...character, corrections, version: character.version + 1, updatedAt: Date.now() };
};

/** Create a new session for a character, seeding the in-character greeting. */
export const createCharacterSession = (character: DistilledCharacter, title?: string): ChatSession => {
  const now = Date.now();
  const messages: ChatMessage[] = [];
  if (character.greeting && character.greeting.trim()) {
    messages.push({ id: uuidv4(), role: 'assistant', content: character.greeting.trim(), createdAt: now });
  }
  return {
    id: uuidv4(),
    characterId: character.id,
    title: title && title.trim() ? title.trim().slice(0, 60) : `${character.name} · ${new Date(now).toLocaleDateString()}`,
    summary: undefined,
    summarizedUpTo: 0,
    messages,
    createdAt: now,
    updatedAt: now,
  };
};
