import type { AIProvider } from '../store/useAIStore';

/**
 * Model capability catalog.
 *
 * Single source of truth for the model picker (each provider keeps <= 5 latest
 * models) and for per-model AI feature adaptation:
 *  - nativeSearch: the provider API can perform web search natively (no external
 *    search API required). When enabled in settings, native search takes priority
 *    over the app's external search (Google/Serper/Yandex/DuckDuckGo).
 *  - reasoningLevels: which reasoning-effort options the model accepts.
 *  - maxTokensParam: correct request field name for the output token cap.
 *  - fixedTemperature: the model accepts exactly this temperature value; other
 *    values are rejected by the provider, so callers must substitute it.
 *
 * Only fill in what is known for sure. Anything not listed here (other
 * providers, custom endpoints, models newer than this file) is adapted at
 * runtime: aiService learns from the provider's own rejection which temperature
 * to use, when to drop the parameter or the tool definitions, and gives
 * thinking models room by raising a truncated token budget.
 */
export type ReasoningLevel = 'off' | 'auto' | 'low' | 'medium' | 'high' | 'max';

export const REASONING_LEVELS: ReasoningLevel[] = ['off', 'auto', 'low', 'medium', 'high', 'max'];

export interface CatalogModel {
  /** API model id (what is sent to the provider) */
  name: string;
  /** Human readable name shown in the picker */
  version: string;
  releaseDate: string;
  deprecated?: boolean;
  nativeSearch?: boolean;
  reasoningLevels?: ReasoningLevel[];
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Only this temperature value is accepted by the provider (e.g. thinking-only models). */
  fixedTemperature?: number;
}

export interface ProviderDefaults {
  nativeSearch: boolean;
  reasoningLevels: ReasoningLevel[];
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
}

export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  moonshot: { nativeSearch: false, reasoningLevels: ['off', 'auto', 'high'], maxTokensParam: 'max_tokens' },
  openai: { nativeSearch: true, reasoningLevels: ['off', 'auto', 'low', 'medium', 'high'], maxTokensParam: 'max_completion_tokens' },
  deepseek: { nativeSearch: false, reasoningLevels: ['off', 'auto', 'high', 'max'], maxTokensParam: 'max_tokens' },
  qwen: { nativeSearch: false, reasoningLevels: ['off', 'auto', 'high'], maxTokensParam: 'max_tokens' },
  google: { nativeSearch: false, reasoningLevels: ['off', 'auto'], maxTokensParam: 'max_tokens' },
  mistral: { nativeSearch: false, reasoningLevels: ['off', 'auto'], maxTokensParam: 'max_tokens' },
  mimo: { nativeSearch: false, reasoningLevels: ['off', 'low', 'medium', 'high', 'auto'], maxTokensParam: 'max_tokens' },
  zhipu: { nativeSearch: true, reasoningLevels: ['off', 'auto', 'high', 'max'], maxTokensParam: 'max_tokens' },
  custom: { nativeSearch: false, reasoningLevels: ['off', 'auto'], maxTokensParam: 'max_tokens' },
};

export const MODEL_CATALOG: Record<AIProvider, CatalogModel[]> = {
  moonshot: [
    // Moonshot's current Kimi models all pin the sampling temperature to 1
    // ("invalid temperature: only 1 is allowed for this model"); the app's
    // analysis/roleplay temperatures have to be substituted. Kimi K3 is also a
    // thinking-only model: reasoning_effort accepts only "max". Native web
    // search on Moonshot is under maintenance, so it stays external.
    { name: 'kimi-k3', version: 'Kimi K3', releaseDate: '2026-07', nativeSearch: false, reasoningLevels: ['auto', 'max'], fixedTemperature: 1 },
    { name: 'kimi-k2.6', version: 'Kimi K2.6', releaseDate: '2026-04', nativeSearch: false, reasoningLevels: ['off', 'auto', 'high'], fixedTemperature: 1 },
    { name: 'kimi-k2.7-code', version: 'Kimi K2.7 Code', releaseDate: '2026-07', nativeSearch: false, reasoningLevels: ['auto'], fixedTemperature: 1 },
    { name: 'kimi-k2.7-code-highspeed', version: 'Kimi K2.7 Code HighSpeed', releaseDate: '2026-07', nativeSearch: false, reasoningLevels: ['auto'], fixedTemperature: 1 },
    { name: 'kimi-k2.5', version: 'Kimi K2.5 (Sunset 2026-08-31)', releaseDate: '2025-12', deprecated: true, nativeSearch: false, reasoningLevels: ['off', 'auto', 'high'] }
  ],
  openai: [
    // Native search via the chat-completions "web_search" tool; reasoning via reasoning.effort.
    { name: 'gpt-5.6-sol', version: 'GPT-5.6 Sol', releaseDate: '2026-07' },
    { name: 'gpt-5.6-terra', version: 'GPT-5.6 Terra', releaseDate: '2026-07' },
    { name: 'gpt-5.6-luna', version: 'GPT-5.6 Luna', releaseDate: '2026-07' },
    { name: 'gpt-5.5', version: 'GPT-5.5', releaseDate: '2026-07' },
    { name: 'gpt-5.5-pro', version: 'GPT-5.5 Pro', releaseDate: '2026-07' }
  ],
  deepseek: [
    // DeepSeek V4 thinking is on by default; reasoning_effort accepts 'none'
    // (verified against the live API — fully disables thinking), 'high', 'max'.
    // The published chat models are deepseek-flash and deepseek-v4-pro; the
    // older v4.1-flash / v4-flash / v3-2 ids were retired by the provider.
    { name: 'deepseek-flash', version: 'DeepSeek Flash', releaseDate: '2026-09', reasoningLevels: ['off', 'auto', 'high', 'max'] },
    { name: 'deepseek-v4-pro', version: 'DeepSeek V4 Pro', releaseDate: '2026-04', reasoningLevels: ['off', 'auto', 'high', 'max'] }
  ],
  qwen: [
    // Chat Completions native search (enable_search) is documented for qwen3.7-plus/flash only.
    // qwen3.8-max is the 0902 refresh of the flagship (preview graduated 2026-09-03).
    { name: 'qwen3.8-max', version: 'Qwen3.8 Max (0902)', releaseDate: '2026-09', nativeSearch: false },
    { name: 'qwen3.8-max-preview', version: 'Qwen3.8 Max Preview (Token Plan)', releaseDate: '2026-07', nativeSearch: false, deprecated: true },
    { name: 'qwen3.7-max', version: 'Qwen3.7 Max', releaseDate: '2026-05', nativeSearch: false },
    { name: 'qwen3.7-plus', version: 'Qwen3.7 Plus', releaseDate: '2026-05', nativeSearch: true },
    { name: 'qwen3.7-flash', version: 'Qwen3.7 Flash', releaseDate: '2026-07', nativeSearch: true },
    { name: 'qwen3.8-omni-flash', version: 'Qwen3.8 Omni Flash', releaseDate: '2026-09', nativeSearch: false }
  ],
  google: [
    // Grounding/thinkingConfig via the OpenAI-compat endpoint is unstable, so keep external search.
    // Gemini 3.8 family went GA 2026-09 (3.8 Flash / 3.8 Flash-Lite; TTS variants excluded).
    { name: 'gemini-3.8-flash', version: 'Gemini 3.8 Flash', releaseDate: '2026-09' },
    { name: 'gemini-3.8-flash-lite', version: 'Gemini 3.8 Flash Lite', releaseDate: '2026-09' },
    { name: 'gemini-3.6-flash', version: 'Gemini 3.6 Flash', releaseDate: '2026-07' },
    { name: 'gemini-3.5-flash', version: 'Gemini 3.5 Flash', releaseDate: '2026-05' },
    { name: 'gemini-3.1-pro', version: 'Gemini 3.1 Pro', releaseDate: '2026-02' }
  ],
  mistral: [
    { name: 'mistral-large-latest', version: 'Mistral Large 3', releaseDate: '2025-12' },
    { name: 'mistral-medium-latest', version: 'Mistral Medium 3.5', releaseDate: '2026-06' },
    { name: 'mistral-small-latest', version: 'Mistral Small 4', releaseDate: '2026-03' },
    { name: 'codestral-latest', version: 'Codestral', releaseDate: 'rolling' },
    { name: 'ministral-8b-latest', version: 'Ministral 8B', releaseDate: 'rolling' }
  ],
  mimo: [
    // MiMo V2.6 series (2026-09-21) replaces V2.5, which is officially sunset 2026-10-21.
    // Thinking is controlled via thinking.type=disabled (off) or reasoning_effort
    // none/low/medium/high (verified against the live API).
    { name: 'mimo-v2.6-pro', version: 'MiMo V2.6 Pro', releaseDate: '2026-09' },
    { name: 'mimo-v2.6-flash', version: 'MiMo V2.6 Flash', releaseDate: '2026-09' },
    { name: 'mimo-v2.5-pro', version: 'MiMo V2.5 Pro (Sunset 2026-10-21)', releaseDate: '2026-05', deprecated: true },
    { name: 'mimo-v2.5-pro-ultraspeed', version: 'MiMo V2.5 Pro UltraSpeed (Sunset 2026-10-21)', releaseDate: '2026-06', deprecated: true },
    { name: 'mimo-v2.5', version: 'MiMo V2.5 (Sunset 2026-10-21)', releaseDate: '2026-05', deprecated: true }
  ],
  zhipu: [
    // GLM-5.2+ support reasoning_effort; older GLM models use thinking.type.
    { name: 'glm-5.3', version: 'GLM-5.3', releaseDate: '2026-09', reasoningLevels: ['off', 'auto', 'low', 'medium', 'high', 'max'] },
    { name: 'glm-5.2', version: 'GLM-5.2', releaseDate: '2026-06', reasoningLevels: ['off', 'auto', 'low', 'medium', 'high', 'max'] },
    { name: 'glm-5.1', version: 'GLM-5.1', releaseDate: '2026-04', reasoningLevels: ['off', 'auto', 'high'] },
    { name: 'glm-5', version: 'GLM-5', releaseDate: '2026-02', reasoningLevels: ['off', 'auto', 'high'] },
    { name: 'glm-5-turbo', version: 'GLM-5 Turbo', releaseDate: '2026-05', reasoningLevels: ['off', 'auto', 'high'] }
  ],
  custom: []
};

export interface ModelCapabilities {
  nativeSearch: boolean;
  reasoningLevels: ReasoningLevel[];
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  fixedTemperature?: number;
}

export function getModelCapabilities(provider: AIProvider, model?: string | null): ModelCapabilities {
  const def = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
  const m = (MODEL_CATALOG[provider] || []).find(x => x.name === model);
  return {
    nativeSearch: m?.nativeSearch ?? def.nativeSearch,
    reasoningLevels: m?.reasoningLevels ?? def.reasoningLevels,
    maxTokensParam: m?.maxTokensParam ?? def.maxTokensParam,
    fixedTemperature: m?.fixedTemperature,
  };
}

/** Native search tools for providers that implement it as a chat-completions tool. */
export function getNativeSearchTools(provider: AIProvider): any[] {
  if (provider === 'openai') {
    return [{ type: 'web_search' }];
  }
  if (provider === 'zhipu') {
    return [{
      type: 'web_search',
      web_search: { enable: 'True', search_engine: 'search_pro', search_result: 'True', count: '5' }
    }];
  }
  return [];
}

/**
 * Build the extra chat-completions body fields for the current provider/model.
 * Native-search params for Moonshot/Qwen are top-level flags; OpenAI/GLM use tools.
 */
export function buildRequestExtras(opts: {
  provider: AIProvider;
  model?: string | null;
  reasoningEffort?: ReasoningLevel;
  maxTokens?: number;
  nativeSearch?: boolean;
}): Record<string, any> {
  const { provider, model, reasoningEffort = 'auto', maxTokens, nativeSearch = false } = opts;
  const caps = getModelCapabilities(provider, model);
  const out: Record<string, any> = {};

  if (nativeSearch) {
    if (provider === 'moonshot') {
      out.enable_search = true;
    } else if (provider === 'qwen') {
      out.enable_search = true;
      out.search_options = { search_strategy: 'agent' };
    }
  }

  const level = caps.reasoningLevels.includes(reasoningEffort) ? reasoningEffort : 'auto';
  if (level !== 'auto') {
  if (level === 'off') {
      if (provider === 'qwen') {
        out.enable_thinking = false;
      } else if (provider === 'moonshot' && caps.reasoningLevels.includes('off')) {
        out.enable_thinking = false;
      } else if (provider === 'zhipu' || provider === 'mimo') {
        // Verified against the live API: both accept thinking.type=disabled.
        out.thinking = { type: 'disabled' };
      } else if (provider === 'deepseek') {
        // Verified against the live API: reasoning_effort 'none' fully
        // disables V4 thinking.
        out.reasoning_effort = 'none';
      }
      // OpenAI/Gemini/Mistral: "off" means leave the provider default.
    } else {
      switch (provider) {
        case 'openai':
          out.reasoning = { effort: level };
          break;
        case 'deepseek':
          out.reasoning_effort = level === 'max' ? 'max' : 'high';
          break;
        case 'mimo':
          // mimo exposes reasoning_effort = none/low/medium/high (no 'max').
          out.reasoning_effort = level === 'max' ? 'high' : level;
          break;
        case 'moonshot':
          if (caps.reasoningLevels.includes('max') && level === 'max') {
            out.reasoning_effort = 'max';
          } else if (caps.reasoningLevels.includes('high')) {
            out.enable_thinking = true;
          }
          break;
        case 'qwen':
          out.enable_thinking = true;
          break;
        case 'zhipu':
          if (caps.reasoningLevels.includes('max')) {
            out.reasoning_effort = level;
          } else {
            out.thinking = { type: 'enabled' };
          }
          break;
        default:
          break;
      }
    }
  }

  const mt = Number(maxTokens) || 0;
  if (mt > 0) {
    out[caps.maxTokensParam] = mt;
  }

  return out;
}
