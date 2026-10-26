import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAIStore, AIProvider, SearchProvider, DEFAULT_SYSTEM_PROMPT, TrendingMode } from '../store/useAIStore';
import { callAI, testSearchConnection, testOmdbConnection, clearTrendingHistory, getTrendingHistory } from '../services/aiService';
import { testTmdbConnection } from '../services/tmdbService';
import { testBangumiConnection } from '../services/bangumiService';
import { Activity, CheckCircle, AlertCircle, Eye, EyeOff, Info, List, Globe, Search, Plug, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { toast } from 'react-toastify';
import { PluginManagerModal } from './PluginManagerModal';
import { MODEL_CATALOG, REASONING_LEVELS, getModelCapabilities, type ReasoningLevel } from '../services/modelCatalog';

export const AIConfigPanel: React.FC = () => {
  const { t } = useTranslation();
  const PROVIDER_OPTIONS: { value: AIProvider; label: string }[] = [
    { value: 'openai', label: t('ai_config.provider_openai') },
    { value: 'moonshot', label: t('ai_config.provider_moonshot') },
    { value: 'deepseek', label: t('ai_config.provider_deepseek') },
    { value: 'qwen', label: t('ai_config.provider_qwen') },
    { value: 'google', label: t('ai_config.provider_google') },
    { value: 'mistral', label: t('ai_config.provider_mistral') },
    { value: 'mimo', label: t('ai_config.provider_mimo') },
    { value: 'zhipu', label: t('ai_config.provider_zhipu') },
    { value: 'custom', label: t('ai_config.provider_custom') }
  ];

  const SEARCH_PROVIDER_OPTIONS: { value: SearchProvider; label: string }[] = [
    { value: 'google', label: t('ai_config.search_provider_google') },
    { value: 'serper', label: t('ai_config.search_provider_serper') },
    { value: 'yandex', label: t('ai_config.search_provider_yandex') },
    { value: 'duckduckgo', label: t('ai_config.search_provider_duckduckgo') },
  ];

  const {
    provider, apiKey, apiKeyProvider, model, baseUrl, maxTokens, systemPrompt,
    enableSearch, searchProvider, googleSearchCx, yandexSearchLogin,
    omdbApiKey, tmdbApiKey, bangumiToken, enableTmdb, enableBangumi,
    enableNetworking, reasoningEffort, enableTrending, trendingMode, trendingPrompt,
    useSystemProxy, proxyProtocol, proxyHost, proxyPort, proxyUsername,
    setProvider, setConfig, getDecryptedApiKey, getDecryptedGoogleKey, getDecryptedSerperKey, getDecryptedYandexKey, getDecryptedOmdbKey, getDecryptedTmdbKey, getDecryptedBangumiToken, getProxyUrl
  } = useAIStore();

  const providerLabel = (value: string) => PROVIDER_OPTIONS.find(opt => opt.value === value)?.label || value;
  // Keys are issued per provider: a key saved under another provider (or left
  // over from a provider switch) is the usual reason calls start failing with 401.
  const keyProviderMismatch = !!apiKey && apiKeyProvider !== provider;

  const [localKey, setLocalKey] = useState(getDecryptedApiKey());
  const [localGoogleKey, setLocalGoogleKey] = useState(getDecryptedGoogleKey());
  const [localSerperKey, setLocalSerperKey] = useState(getDecryptedSerperKey());
  const [localYandexKey, setLocalYandexKey] = useState(getDecryptedYandexKey());
  const [localOmdbKey, setLocalOmdbKey] = useState(getDecryptedOmdbKey());
  const [localTmdbKey, setLocalTmdbKey] = useState(getDecryptedTmdbKey());
  const [localBangumiToken, setLocalBangumiToken] = useState(getDecryptedBangumiToken());
  // Trending recommendation config: draft for the custom prompt + size of the
  // "already recommended" history used to keep every round different.
  const [trendingPromptDraft, setTrendingPromptDraft] = useState(trendingPrompt || '');
  const [trendingHistoryCount, setTrendingHistoryCount] = useState(() => getTrendingHistory().length);
  useEffect(() => { setTrendingPromptDraft(trendingPrompt || ''); }, [trendingPrompt]);
  const [showKey, setShowKey] = useState(false);
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [showSerperKey, setShowSerperKey] = useState(false);
  const [showYandexKey, setShowYandexKey] = useState(false);
  const [showOmdbKey, setShowOmdbKey] = useState(false);
  const [showTmdbKey, setShowTmdbKey] = useState(false);
  const [showBangumiToken, setShowBangumiToken] = useState(false);
  const [localUseSystemProxy, setLocalUseSystemProxy] = useState(useSystemProxy);
  const [localProxyProtocol, setLocalProxyProtocol] = useState<'http' | 'socks5'>(proxyProtocol || 'http');
  const [localProxyHost, setLocalProxyHost] = useState(proxyHost || '');
  const [localProxyPort, setLocalProxyPort] = useState(proxyPort || '');
  const [localProxyUsername, setLocalProxyUsername] = useState(proxyUsername || '');
  const [localProxyPassword, setLocalProxyPassword] = useState('');

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{status: 'success' | 'error' | null, latency: number | null, message: string}>({
    status: null,
    latency: null,
    message: ''
  });
  const [isManualInput, setIsManualInput] = useState(false);
  const [isProxyHelpOpen, setIsProxyHelpOpen] = useState(false);
  const [isSearchTesting, setIsSearchTesting] = useState(false);
  const [isOmdbTesting, setIsOmdbTesting] = useState(false);
  const [isTmdbTesting, setIsTmdbTesting] = useState(false);
  const [isBangumiTesting, setIsBangumiTesting] = useState(false);
  const [isPluginManagerOpen, setIsPluginManagerOpen] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);

  const handleTestSearch = async () => {
    if (searchProvider === 'google' && !localGoogleKey) return toast.error(t('ai_config.api_key_required'));
    if (searchProvider === 'serper' && !localSerperKey) return toast.error(t('ai_config.api_key_required'));
  if (searchProvider === 'yandex' && (!localYandexKey || !yandexSearchLogin)) return toast.error(t('ai_config.api_key_required'));
    setIsSearchTesting(true);
    try {
      const config = {
         googleSearchApiKey: localGoogleKey,
         googleSearchCx,
         serperApiKey: localSerperKey,
         yandexSearchApiKey: localYandexKey,
         yandexSearchLogin
      };
      const result = await testSearchConnection(searchProvider, config);
      if (result.ok) {
        toast.success(`${t('ai_config.connection_verified')} (${result.count} results)`);
        // Auto-save the key if validation succeeds
        setConfig({
            googleSearchApiKey: localGoogleKey,
            googleSearchCx,
            serperApiKey: localSerperKey,
            yandexSearchApiKey: localYandexKey,
            yandexSearchLogin
        });
      } else {
        toast.error(`${t('ai_config.connection_failed_prefix')}${result.error}`);
      }
    } finally {
      setIsSearchTesting(false);
    }
  };

  const handleTestOmdb = async () => {
    if (!localOmdbKey) return toast.error(t('ai_config.api_key_required'));
    setIsOmdbTesting(true);
    try {
      const result = await testOmdbConnection(localOmdbKey);
      if (result.ok) {
        toast.success(t('ai_config.connection_verified'));
        setConfig({ omdbApiKey: localOmdbKey });
      } else {
        toast.error(`${t('ai_config.connection_failed_prefix')}${result.error}`);
      }
    } finally {
      setIsOmdbTesting(false);
    }
  };

  const handleTestTmdb = async () => {
    if (!localTmdbKey) return toast.error(t('ai_config.api_key_required'));
    setIsTmdbTesting(true);
    try {
      const result = await testTmdbConnection(localTmdbKey);
      if (result.ok) {
        toast.success(t('ai_config.connection_verified'));
        setConfig({ tmdbApiKey: localTmdbKey, enableTmdb });
      } else {
        toast.error(`${t('ai_config.connection_failed_prefix')}${result.error}`);
      }
    } finally {
      setIsTmdbTesting(false);
    }
  };

  const handleTestBangumi = async () => {
    setIsBangumiTesting(true);
    try {
        const result = await testBangumiConnection(localBangumiToken);
        if (result.ok) {
            toast.success(t('ai_config.connection_verified'));
            setConfig({ bangumiToken: localBangumiToken, enableBangumi });
        } else {
            toast.error(`${t('ai_config.connection_failed_prefix')}${result.error}`);
        }
    } finally {
        setIsBangumiTesting(false);
    }
  };

  const handleTestProxy = async () => {
    setIsTesting(true);
    setTestResult({ status: null, latency: null, message: '' });
    const start = performance.now();
    try {
      const url = 'https://www.google.com/generate_204';
      const result = await invoke<string>('test_proxy', {
        config: {
          url,
          proxy_url: getProxyUrl(),
          use_system_proxy: localUseSystemProxy
        }
      });
      const parsed = JSON.parse(result || '{}');
      const ok = !!parsed.ok;
      const latency = typeof parsed.latency_ms === 'number' ? parsed.latency_ms : Math.round(performance.now() - start);
      setTestResult({ status: ok ? 'success' : 'error', latency, message: `HTTP ${parsed.status}` });
      if (ok) {
        toast.success(t('ai_config.proxy_test_success'));
        setConfig({
            useSystemProxy: localUseSystemProxy,
            proxyProtocol: localProxyProtocol,
            proxyHost: localProxyHost,
            proxyPort: localProxyPort,
            proxyUsername: localProxyUsername,
            proxyPassword: localProxyPassword
        });
        toast.success(t('ai_config.auto_saved_after_test'));
      } else {
        toast.error(`${t('ai_config.proxy_test_failed')} HTTP ${parsed.status}`);
      }
    } catch (e: any) {
      setTestResult({ status: 'error', latency: null, message: e?.message || 'Proxy test failed' });
      toast.error(`${t('ai_config.proxy_test_failed')} ${e?.message || ''}`);
    } finally {
      setIsTesting(false);
    }
  };

  // Update local keys and reset manual input when provider changes or store updates
  useEffect(() => {
    setLocalKey(getDecryptedApiKey());
    setLocalGoogleKey(getDecryptedGoogleKey());
    setLocalSerperKey(getDecryptedSerperKey());
    setLocalYandexKey(getDecryptedYandexKey());
    setLocalOmdbKey(getDecryptedOmdbKey());
    setLocalTmdbKey(getDecryptedTmdbKey());
    setLocalBangumiToken(getDecryptedBangumiToken());
    setIsManualInput(false);
  }, [provider, getDecryptedApiKey, getDecryptedGoogleKey, getDecryptedSerperKey, getDecryptedYandexKey, getDecryptedOmdbKey, getDecryptedTmdbKey, getDecryptedBangumiToken, enableTmdb, enableBangumi]);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult({ status: null, latency: null, message: '' });
    const startTime = performance.now();

    try {
        const sanitized = (baseUrl || '').trim().replace(/[\s)]+$/g, '');
        const text = await callAI([
          { role: 'system', content: 'Ping' },
          { role: 'user', content: 'Hi' }
        ], 0.1, { configOverride: { baseURL: sanitized, apiKey: localKey, model, provider } });
        if (!text) {
          throw new Error('Connection failed');
        }

        const endTime = performance.now();
        setTestResult({
            status: 'success',
            latency: Math.round(endTime - startTime),
            message: 'Connection successful'
        });
        toast.success(t('ai_config.connection_verified'));
        // Auto-save on success
        setConfig({
          apiKey: localKey,
          model,
          baseUrl,
          maxTokens,
          enableSearch,
          searchProvider,
          googleSearchApiKey: localGoogleKey,
          googleSearchCx,
          serperApiKey: localSerperKey,
          yandexSearchApiKey: localYandexKey,
          yandexSearchLogin,
          omdbApiKey: localOmdbKey,
          tmdbApiKey: localTmdbKey,
          bangumiToken: localBangumiToken,
          enableTmdb,
          enableBangumi,
          enableTrending,
          useSystemProxy: localUseSystemProxy,
          proxyProtocol: localProxyProtocol,
          proxyHost: localProxyHost,
          proxyPort: localProxyPort,
          proxyUsername: localProxyUsername,
          proxyPassword: localProxyPassword
        });
        toast.success(t('ai_config.auto_saved_after_test'));

    } catch (error: any) {
        setTestResult({
            status: 'error',
            latency: null,
            message: error.message || 'Connection failed'
        });
        toast.error(`${t('ai_config.connection_failed_prefix')}${error.message}`);
    } finally {
        setIsTesting(false);
    }
  };

  const availableModels = MODEL_CATALOG[provider] || [];
  const isKnownModel = availableModels.some(m => m.name === model);
  const showInput = provider === 'custom' || !isKnownModel || isManualInput;
  const modelCaps = getModelCapabilities(provider, model);
  const reasoningOptions = REASONING_LEVELS.filter(l => modelCaps.reasoningLevels.includes(l));

  return (
    <div className="bg-theme-surface border border-theme-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4 border-b border-theme-border pb-3">
        <Activity className="w-6 h-6 text-theme-accent" />
        <h2 className="text-xl font-bold text-theme-text">{t('ai_config.title')}</h2>
        <button
          onClick={() => setIsPluginManagerOpen(true)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-theme-border bg-theme-bg text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors"
        >
          <Plug className="w-3.5 h-3.5" />
          {t('plugin_manager.title')}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Left Column */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.provider_label')}</label>
            <select 
              value={provider} 
              onChange={(e) => setProvider(e.target.value as AIProvider)}
              className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
            >
              {PROVIDER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.base_url_label')}</label>
            <input 
              type="text" 
              value={baseUrl}
              onChange={(e) => setConfig({ baseUrl: e.target.value })}
              className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
              placeholder="https://api.example.com/v1"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.api_key_label')}</label>
            <div className="relative">
              <input 
                type={showKey ? "text" : "password"} 
                value={localKey}
                onChange={(e) => setLocalKey(e.target.value)}
                onBlur={() => {
                  const next = localKey.trim();
                  if (next !== getDecryptedApiKey()) setConfig({ apiKey: next });
                }}
                className="w-full px-4 py-2 pr-10 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                placeholder={t('ai_config.api_key_placeholder', { defaultValue: "sk-..." })}
              />
              <button 
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-subtext hover:text-theme-text"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex justify-between items-start mt-1">
              <div className="flex flex-col gap-1">
                <p className="text-xs text-theme-subtext flex items-center gap-1">
                  <Info className="w-3 h-3" />
                  {t('ai_config.stored_locally')}
                </p>
                <p className="text-xs text-theme-subtext/70 italic">
                  {t('ai_config.multi_key_hint', { defaultValue: "Support multiple keys separated by semicolons (;). Auto-switch on error." })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {testResult.status && (
                    <div className={clsx(
                        "text-xs px-2 py-0.5 rounded border flex items-center gap-1",
                        testResult.status === 'success' 
                            ? "bg-green-500/10 border-green-500/20 text-green-600"
                            : "bg-red-500/10 border-red-500/20 text-red-600"
                    )}>
                        {testResult.status === 'success' ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                        <span>{testResult.status === 'success' ? `${testResult.latency}ms` : 'Failed'}</span>
                    </div>
                )}
                <button 
                    onClick={handleTestConnection}
                    disabled={isTesting}
                    className="text-xs px-3 py-1.5 rounded border border-theme-accent text-theme-accent hover:bg-theme-accent hover:text-white transition-colors disabled:opacity-50 flex-shrink-0 ml-2 flex items-center gap-1"
                >
                    {isTesting && <Activity className="w-3 h-3 animate-spin" />}
                    {t('ai_config.test_connection_btn')}
                </button>
              </div>
            </div>
            {keyProviderMismatch && (
              <div className="mt-2 flex items-start gap-2 p-2 rounded-lg bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 text-xs">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  {apiKeyProvider
                    ? t('ai_config.key_provider_mismatch', { saved: providerLabel(apiKeyProvider), current: providerLabel(provider) })
                    : t('ai_config.key_provider_unverified', { current: providerLabel(provider) })}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.model_name_label')}</label>
            <div className="relative">
               {showInput ? (
                 <div className="flex gap-2">
                   <input 
                     type="text" 
                     value={model} 
                     onChange={(e) => setConfig({ model: e.target.value })}
                     className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                     placeholder={provider === 'custom' ? t('ai_config.enter_model_name') : t('ai_config.enter_custom_model_name')}
                   />
                   {provider !== 'custom' && (
                     <button
                        onClick={() => {
                            setIsManualInput(false);
                            // If current model is not in list, revert to default
                            if (!availableModels.some(m => m.name === model)) {
                                 setConfig({ model: availableModels[0]?.name || '' });
                            }
                        }}
                        className="px-3 py-2 rounded-lg border border-theme-border bg-theme-surface hover:bg-theme-bg text-theme-subtext transition-colors"
                        title={t('ai_config.switch_to_list')}
                     >
                        <List className="w-4 h-4" />
                     </button>
                   )}
                 </div>
               ) : (
                 <select 
                   value={model} 
                   onChange={(e) => {
                       if (e.target.value === '__manual__') {
                           setIsManualInput(true);
                       } else {
                           setConfig({ model: e.target.value });
                       }
                   }}
                   className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                 >
                   {availableModels.map(m => (
                     <option key={m.name} value={m.name} className={m.deprecated ? 'text-theme-subtext/50' : ''}>
                       {m.name} ({m.version} - {m.releaseDate}){m.deprecated ? ' ⚠' : ''}
                     </option>
                   ))}
                   <option value="__manual__" className="text-theme-accent font-medium bg-theme-surface">
                       {t('ai_config.manual_input')}
                   </option>
                 </select>
               )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.max_tokens')}</label>
            <input 
              type="number" 
              value={maxTokens}
              onChange={(e) => setConfig({ maxTokens: parseInt(e.target.value) })}
              className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-theme-text mb-2">{t('ai_config.model_capabilities')}</label>
            <div className="space-y-3 bg-theme-bg/30 p-3 rounded-lg border border-theme-border">
                 <div className="flex items-center justify-between">
                    <span className="text-sm text-theme-text">{t('ai_config.enable_networking')}</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            checked={enableNetworking} 
                            onChange={(e) => setConfig({ enableNetworking: e.target.checked })} 
                            className="sr-only peer" 
                        />
                        <div className="w-11 h-6 bg-theme-border border-2 border-theme-subtext/20 rounded-full peer peer-focus:ring-2 peer-focus:ring-theme-accent peer-checked:bg-gradient-to-r peer-checked:from-theme-accent-warm peer-checked:to-theme-accent-warm-2 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
                    </label>
                </div>
                <p className="text-xs text-theme-subtext/70">
                    {modelCaps.nativeSearch ? t('ai_config.native_search_supported') : t('ai_config.native_search_unsupported')}
                </p>
                 <div className="flex items-center justify-between">
                    <span className="text-sm text-theme-text">{t('ai_config.reasoning_effort')}</span>
                    <select 
                        value={reasoningEffort} 
                        onChange={(e) => setConfig({ reasoningEffort: e.target.value as ReasoningLevel })}
                        className="w-32 px-2 py-1 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none text-sm"
                    >
                        {reasoningOptions.map(l => (
                            <option key={l} value={l}>{t(`ai_config.reasoning_${l}`)}</option>
                        ))}
                    </select>
                </div>

                <div className="flex items-center justify-between">
                    <span className="text-sm text-theme-text">{t('ai_config.enable_trending')}</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input
                            type="checkbox"
                            checked={enableTrending}
                            onChange={(e) => setConfig({ enableTrending: e.target.checked })}
                            className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-theme-border border-2 border-theme-subtext/20 rounded-full peer peer-focus:ring-2 peer-focus:ring-theme-accent peer-checked:bg-gradient-to-r peer-checked:from-theme-accent-warm peer-checked:to-theme-accent-warm-2 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
                    </label>
                </div>

                {enableTrending && (
                    <div className="mt-1 p-3 rounded-lg bg-theme-bg/50 border border-theme-border space-y-3">
                        <div>
                            <label className="block text-sm font-medium text-theme-text mb-1.5">{t('ai_config.trending_mode')}</label>
                            <div className="grid grid-cols-3 gap-2">
                                {(['recent', 'preference', 'custom'] as const).map((m) => (
                                    <button
                                        key={m}
                                        type="button"
                                        onClick={() => setConfig({ trendingMode: m as TrendingMode })}
                                        className={clsx(
                                            'px-2 py-1.5 text-xs font-medium rounded-md border-2 transition-colors',
                                            (trendingMode || 'recent') === m
                                                ? 'bg-theme-accent text-theme-bg border-theme-accent'
                                                : 'bg-theme-surface text-theme-subtext border-theme-border hover:text-theme-text hover:border-theme-accent/50'
                                        )}
                                    >
                                        {t(`ai_config.trending_mode_${m}`)}
                                    </button>
                                ))}
                            </div>
                            <p className="mt-1.5 text-xs text-theme-subtext">
                                {t(`ai_config.trending_mode_${trendingMode || 'recent'}_desc`)}
                            </p>
                        </div>

                        {(trendingMode || 'recent') === 'custom' && (
                            <div>
                                <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.trending_custom_prompt_label')}</label>
                                <textarea
                                    value={trendingPromptDraft}
                                    onChange={(e) => setTrendingPromptDraft(e.target.value)}
                                    placeholder={t('ai_config.trending_custom_prompt_placeholder')}
                                    className="w-full h-28 p-2 rounded-lg bg-theme-bg border border-theme-border text-theme-text text-xs font-mono focus:ring-1 focus:ring-theme-accent focus:border-transparent resize-none"
                                />
                                <div className="flex justify-end mt-1.5">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setConfig({ trendingPrompt: trendingPromptDraft });
                                            toast.success(t('common.save_success', { defaultValue: 'Saved' }));
                                        }}
                                        className="px-3 py-1 text-xs rounded-md border-2 border-theme-accent bg-theme-accent text-theme-bg hover:bg-theme-accent-hover transition-colors"
                                    >
                                        {t('search_page.save_prompt')}
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="flex items-center justify-between">
                            <span className="text-xs text-theme-subtext">
                                {t('ai_config.trending_history_desc', { count: trendingHistoryCount })}
                            </span>
                            <button
                                type="button"
                                disabled={trendingHistoryCount === 0}
                                onClick={() => {
                                    clearTrendingHistory();
                                    setTrendingHistoryCount(0);
                                    toast.success(t('ai_config.trending_history_cleared'));
                                }}
                                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border border-theme-border bg-theme-surface text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                <Trash2 className="w-3 h-3" />
                                {t('ai_config.trending_clear_history')}
                            </button>
                        </div>
                    </div>
                )}
            </div>
          </div>

          <div className="flex justify-end">
            <a 
                href={
                    provider === 'moonshot' ? 'https://platform.moonshot.cn/docs' :
                    provider === 'openai' ? 'https://platform.openai.com/docs' :
                    provider === 'deepseek' ? 'https://api-docs.deepseek.com/' :
                    provider === 'qwen' ? 'https://help.aliyun.com/zh/model-studio/developer-reference/use-compatible-text-generation-interfaces' :
                    provider === 'google' ? 'https://ai.google.dev/gemini-api/docs/openai' :
                    provider === 'mistral' ? 'https://docs.mistral.ai/' :
                    '#'
                } 
                target="_blank" 
                rel="noopener noreferrer" 
                className="text-xs text-theme-accent hover:underline"
            >
                {t('ai_config.view_api_docs')}
            </a>
          </div>
        </div>
      </div>

      {/* Web Search Configuration */}
      <div className="mt-5 border-t border-theme-border pt-4">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <div>
        <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-theme-accent" />
                <h3 className="text-lg font-semibold text-theme-text">{t('ai_config.web_search_capabilities')}</h3>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                checked={enableSearch} 
                onChange={(e) => setConfig({ enableSearch: e.target.checked })} 
                className="sr-only peer" 
              />
              <div className="w-11 h-6 bg-theme-border border-2 border-theme-subtext/20 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-theme-accent rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gradient-to-r peer-checked:from-theme-accent-warm peer-checked:to-theme-accent-warm-2"></div>
              <span className="ms-3 text-sm font-medium text-theme-text">{t('ai_config.enable_web_search')}</span>
            </label>
        </div>

        {enableSearch && (
          <div className="bg-theme-bg/50 p-3 rounded-lg border border-theme-border space-y-3">
                {/* Search Provider Selection */}
                <div>
                    <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.search_engine')}</label>
                    <div className="flex items-center gap-2">
                        <Search className="w-4 h-4 text-theme-subtext" />
                        <select 
                            value={searchProvider} 
                            onChange={(e) => setConfig({ searchProvider: e.target.value as SearchProvider })}
                            className="flex-1 px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                        >
                            {SEARCH_PROVIDER_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Google Configuration */}
                {searchProvider === 'google' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.google_key_label')}</label>
                            <div className="relative">
                                <input 
                                    type={showGoogleKey ? "text" : "password"} 
                                    value={localGoogleKey}
                                    onChange={(e) => setLocalGoogleKey(e.target.value)}
                                    className="w-full px-4 py-2 pr-10 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                                    placeholder="AIza..."
                                />
                                 <button 
                                    type="button"
                                    onClick={() => setShowGoogleKey(!showGoogleKey)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-subtext hover:text-theme-text"
                                  >
                                    {showGoogleKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                  </button>
                            </div>
                            <p className="text-xs text-theme-subtext/70 italic mt-1">
                                {t('ai_config.multi_key_hint')}
                            </p>
                             <a href="https://developers.google.com/custom-search/v1/overview" target="_blank" rel="noreferrer" className="text-xs text-theme-accent hover:underline mt-1 inline-block">
                                {t('ai_config.get_google_key')}
                            </a>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.google_cx_label')}</label>
                            <input 
                                type="text" 
                                value={googleSearchCx}
                                onChange={(e) => setConfig({ googleSearchCx: e.target.value })}
                                className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                                placeholder="0123456789..."
                            />
                            <a href="https://programmablesearchengine.google.com/controlpanel/all" target="_blank" rel="noreferrer" className="text-xs text-theme-accent hover:underline mt-1 inline-block">
                                {t('ai_config.get_google_cx')}
                            </a>
                        </div>
                        <div className="md:col-span-2 flex justify-end">
                            <button onClick={handleTestSearch} disabled={isSearchTesting} className="text-xs px-3 py-1.5 rounded border border-theme-accent text-theme-accent hover:bg-theme-accent hover:text-white transition-colors disabled:opacity-50">
                                {isSearchTesting ? 'Testing...' : t('ai_config.test_connection_btn')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Serper Configuration */}
                {searchProvider === 'serper' && (
                     <div>
                        <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.serper_key_label')}</label>
                        <div className="relative">
                            <input 
                                type={showSerperKey ? "text" : "password"} 
                                value={localSerperKey}
                                onChange={(e) => setLocalSerperKey(e.target.value)}
                                className="w-full px-4 py-2 pr-10 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                                placeholder={t('ai_config.serper_key_placeholder')}
                            />
                             <button 
                                type="button"
                                onClick={() => setShowSerperKey(!showSerperKey)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-subtext hover:text-theme-text"
                              >
                                {showSerperKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                        </div>
                        <p className="text-xs text-theme-subtext/70 italic mt-1">
                            {t('ai_config.multi_key_hint')}
                        </p>
                         <div className="flex justify-between items-center mt-1">
                             <a href="https://serper.dev/" target="_blank" rel="noreferrer" className="text-xs text-theme-accent hover:underline inline-block">
                                {t('ai_config.get_serper_key')}
                            </a>
                            <button onClick={handleTestSearch} disabled={isSearchTesting} className="text-xs px-3 py-1.5 rounded border border-theme-accent text-theme-accent hover:bg-theme-accent hover:text-white transition-colors disabled:opacity-50">
                                {isSearchTesting ? 'Testing...' : t('ai_config.test_connection_btn')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Yandex Configuration */}
                {searchProvider === 'yandex' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.yandex_user_label')}</label>
                            <input 
                                type="text" 
                                value={yandexSearchLogin}
                                onChange={(e) => setConfig({ yandexSearchLogin: e.target.value })}
                                className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                                placeholder={t('ai_config.yandex_user_placeholder')}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.yandex_key_label')}</label>
                            <div className="relative">
                                <input 
                                    type={showYandexKey ? "text" : "password"} 
                                    value={localYandexKey}
                                    onChange={(e) => setLocalYandexKey(e.target.value)}
                                    className="w-full px-4 py-2 pr-10 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                                    placeholder={t('ai_config.yandex_key_placeholder')}
                                />
                                 <button 
                                    type="button"
                                    onClick={() => setShowYandexKey(!showYandexKey)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-subtext hover:text-theme-text"
                                  >
                                    {showYandexKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                  </button>
                            </div>
                            <p className="text-xs text-theme-subtext/70 italic mt-1">
                                {t('ai_config.multi_key_hint')}
                            </p>
                             <a href="https://xml.yandex.com/" target="_blank" rel="noreferrer" className="text-xs text-theme-accent hover:underline mt-1 inline-block">
                                {t('ai_config.get_yandex_key')}
                            </a>
                          </div>
                        <div className="md:col-span-2 flex justify-end">
                            <button onClick={handleTestSearch} disabled={isSearchTesting} className="text-xs px-3 py-1.5 rounded border border-theme-accent text-theme-accent hover:bg-theme-accent hover:text-white transition-colors disabled:opacity-50">
                                {isSearchTesting ? 'Testing...' : t('ai_config.test_connection_btn')}
                            </button>
                        </div>
                     </div>
                )}

                {/* DuckDuckGo Configuration */}
                {searchProvider === 'duckduckgo' && (
                    <div>
                        <div className="text-sm text-theme-subtext mb-2 bg-theme-bg/30 p-3 rounded border border-theme-border flex items-start gap-2">
                            <Info className="w-4 h-4 mt-0.5 text-theme-accent" />
                            <span>{t('ai_config.ddg_info', { defaultValue: "DuckDuckGo search does not require an API key." })}</span>
                        </div>
                        <div className="flex justify-end">
                            <button onClick={handleTestSearch} disabled={isSearchTesting} className="text-xs px-3 py-1.5 rounded border border-theme-accent text-theme-accent hover:bg-theme-accent hover:text-white transition-colors disabled:opacity-50">
                                {isSearchTesting ? 'Testing...' : t('ai_config.test_connection_btn')}
                            </button>
                        </div>
                    </div>
                )}



            </div>
          )}
        </div>

        {/* Metadata Sources */}
        <div className="bg-theme-bg/30 rounded-lg border border-theme-border p-3">
            <h3 className="text-sm font-bold text-theme-text mb-3 uppercase tracking-wider">{t('ai_config.metadata_sources', { defaultValue: 'Metadata Sources' })}</h3>
            <div className="space-y-4">
                        {/* Bangumi Toggle */}
                        <div className="flex items-center justify-between">
                            <div>
                                <label className="text-sm font-medium text-theme-text">{t('ai_config.bangumi_label')}</label>
                                <p className="text-xs text-theme-subtext">Anime, Comics, Games metadata</p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    checked={enableBangumi} 
                                    onChange={(e) => {
                                        const checked = e.target.checked;
                                        setConfig({ enableBangumi: checked });
                                    }} 
                                    className="sr-only peer" 
                                />
                                <div className="w-11 h-6 bg-theme-border border-2 border-theme-subtext/20 rounded-full peer peer-focus:ring-2 peer-focus:ring-theme-accent peer-checked:bg-gradient-to-r peer-checked:from-theme-accent-warm peer-checked:to-theme-accent-warm-2 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
                            </label>
                        </div>
                        {enableBangumi && (
                            <div className="pl-4 border-l-2 border-theme-border/50">
                                <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.bangumi_token_label', { defaultValue: "Bangumi Access Token (Optional)" })}</label>
                                <div className="relative">
                                    <input 
                                        type={showBangumiToken ? "text" : "password"} 
                                        value={localBangumiToken}
                                        onChange={(e) => setLocalBangumiToken(e.target.value)}
                                        className="w-full px-4 py-2 pr-10 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                                        placeholder="Access Token"
                                    />
                                    <button 
                                        type="button"
                                        onClick={() => setShowBangumiToken(!showBangumiToken)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-subtext hover:text-theme-text"
                                    >
                                        {showBangumiToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                                <div className="flex justify-between items-start mt-1">
                                    <div className="flex flex-col gap-1">
                                        <p className="text-xs text-theme-subtext flex items-center gap-1">
                                            <Info className="w-3 h-3" />
                                            {t('ai_config.bangumi_token_note', { defaultValue: "Required for higher rate limits" })}
                                        </p>
                                        <a href="https://bangumi.tv/dev/app" target="_blank" rel="noreferrer" className="text-xs text-theme-accent hover:underline">
                                            {t('ai_config.get_bangumi_token')}
                                        </a>
                                    </div>
                                    <button onClick={handleTestBangumi} disabled={isBangumiTesting} className="text-xs px-3 py-1.5 rounded border border-theme-accent text-theme-accent hover:bg-theme-accent hover:text-white transition-colors disabled:opacity-50 flex-shrink-0 ml-2">
                                        {isBangumiTesting ? 'Testing...' : t('ai_config.test_connection_btn')}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* TMDB Toggle & Key */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div>
                                    <label className="text-sm font-medium text-theme-text">TMDB</label>
                                    <p className="text-xs text-theme-subtext">Movies & TV Series metadata</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input 
                                        type="checkbox" 
                                    checked={enableTmdb} 
                                    onChange={(e) => setConfig({ enableTmdb: e.target.checked })} 
                                        className="sr-only peer" 
                                    />
                                    <div className="w-11 h-6 bg-theme-border border-2 border-theme-subtext/20 rounded-full peer peer-focus:ring-2 peer-focus:ring-theme-accent peer-checked:bg-gradient-to-r peer-checked:from-theme-accent-warm peer-checked:to-theme-accent-warm-2 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
                                </label>
                            </div>
                        {enableTmdb && (
                                <div className="pl-4 border-l-2 border-theme-border/50">
                                    <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.tmdb_key_label')}</label>
                                    <div className="relative">
                                        <input 
                                            type={showTmdbKey ? "text" : "password"} 
                                            value={localTmdbKey}
                                            onChange={(e) => setLocalTmdbKey(e.target.value)}
                                            className="w-full px-4 py-2 pr-10 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                                            placeholder="TMDB API Key"
                                        />
                                        <button 
                                            type="button"
                                            onClick={() => setShowTmdbKey(!showTmdbKey)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-subtext hover:text-theme-text"
                                        >
                                            {showTmdbKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                    </div>
                                    <div className="flex justify-between items-start mt-1">
                                        <div className="flex flex-col gap-1">
                                            <p className="text-xs text-theme-subtext flex items-center gap-1">
                                                <Info className="w-3 h-3" />
                                                {t('ai_config.tmdb_key_optional_note')}
                                            </p>
                                            <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className="text-xs text-theme-accent hover:underline">
                                                {t('ai_config.get_tmdb_key')}
                                            </a>
                                        </div>
                                        <button onClick={handleTestTmdb} disabled={isTmdbTesting} className="text-xs px-3 py-1.5 rounded border border-theme-accent text-theme-accent hover:bg-theme-accent hover:text-white transition-colors disabled:opacity-50 flex-shrink-0 ml-2">
                                            {isTmdbTesting ? 'Testing...' : t('ai_config.test_connection_btn')}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* OMDB Key */}
                        <div>
                            <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.omdb_key_label')}</label>
                            <div className="relative">
                                <input 
                                    type={showOmdbKey ? "text" : "password"} 
                                    value={localOmdbKey}
                                    onChange={(e) => setLocalOmdbKey(e.target.value)}
                                    className="w-full px-4 py-2 pr-10 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                                    placeholder="OMDB API Key"
                                />
                                <button 
                                    type="button"
                                    onClick={() => setShowOmdbKey(!showOmdbKey)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-subtext hover:text-theme-text"
                                >
                                    {showOmdbKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                            <div className="flex justify-between items-start mt-1">
                                <div className="flex flex-col gap-1">
                                    <p className="text-xs text-theme-subtext flex items-center gap-1">
                                        <Info className="w-3 h-3" />
                                        {t('ai_config.omdb_key_optional_note')}
                                    </p>
                                    <a href="http://www.omdbapi.com/apikey.aspx" target="_blank" rel="noreferrer" className="text-xs text-theme-accent hover:underline">
                                        {t('ai_config.get_omdb_key', { defaultValue: "Get OMDB API Key" })}
                                    </a>
                                </div>
                                <button onClick={handleTestOmdb} disabled={isOmdbTesting} className="text-xs px-3 py-1.5 rounded border border-theme-accent text-theme-accent hover:bg-theme-accent hover:text-white transition-colors disabled:opacity-50 flex-shrink-0 ml-2">
                                    {isOmdbTesting ? 'Testing...' : t('ai_config.test_connection_btn')}
                                </button>
                            </div>
                        </div>
                  </div>
              </div>

        {/* Proxy Settings */}
        <div className="xl:col-span-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-theme-text">{t('ai_config.use_system_proxy')}</label>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={localUseSystemProxy} 
                    onChange={(e) => setLocalUseSystemProxy(e.target.checked)} 
                    className="sr-only peer" 
                  />
                  <div className="w-11 h-6 bg-theme-border border-2 border-theme-subtext/20 rounded-full peer peer-focus:ring-2 peer-focus:ring-theme-accent peer-checked:bg-gradient-to-r peer-checked:from-theme-accent-warm peer-checked:to-theme-accent-warm-2 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
                </label>
              </div>
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={handleTestProxy}
                  disabled={isTesting}
                  className="px-3 py-2 rounded-lg text-sm font-medium border-2 border-theme-accent bg-theme-surface hover:bg-theme-bg text-theme-text disabled:opacity-50"
                >
                  {isTesting ? t('ai_config.testing_proxy') : t('ai_config.test_proxy')}
                </button>
              </div>
              {!localUseSystemProxy && (
                <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.proxy_protocol')}</label>
                    <select 
                      value={localProxyProtocol}
                      onChange={(e) => setLocalProxyProtocol(e.target.value as 'http' | 'socks5')}
                      className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                    >
                      <option value="http">HTTP</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.proxy_host')}</label>
                    <input 
                      type="text" 
                      value={localProxyHost}
                      onChange={(e) => setLocalProxyHost(e.target.value)}
                      className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                      placeholder="127.0.0.1"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.proxy_port')}</label>
                    <input 
                      type="text" 
                      value={localProxyPort}
                      onChange={(e) => setLocalProxyPort(e.target.value)}
                      className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                      placeholder="7890"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.proxy_username')}</label>
                    <input 
                      type="text" 
                      value={localProxyUsername}
                      onChange={(e) => setLocalProxyUsername(e.target.value)}
                      className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                      placeholder=""
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-text mb-1">{t('ai_config.proxy_password')}</label>
                    <input 
                      type="password" 
                      value={localProxyPassword}
                      onChange={(e) => setLocalProxyPassword(e.target.value)}
                      className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none"
                      placeholder=""
                    />
                  </div>
                  <div className="md:col-span-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setIsProxyHelpOpen(true)}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border-2 border-theme-accent bg-theme-surface hover:bg-theme-bg text-theme-text"
                    >
                      <Info className="w-4 h-4" />
                      {t('ai_config.proxy_help_btn')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Advanced: System Prompt (collapsed by default) */}
      <div className="mt-4 border-t border-theme-border pt-4">
        <button
          type="button"
          onClick={() => setShowSystemPrompt(!showSystemPrompt)}
          className="w-full flex items-center gap-2 text-left text-sm font-semibold text-theme-text hover:text-theme-accent transition-colors"
        >
          {showSystemPrompt ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          {t('ai_config.system_prompt_label')}
        </button>
        {showSystemPrompt && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-theme-subtext/70">{t('ai_config.system_prompt_hint')}</p>
            <textarea
              value={systemPrompt}
              onChange={(e) => setConfig({ systemPrompt: e.target.value })}
              rows={10}
              spellCheck={false}
              className="w-full px-4 py-3 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none font-mono text-xs leading-relaxed resize-y"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setConfig({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
                className="text-xs px-3 py-1.5 rounded border border-theme-border bg-theme-surface text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors"
              >
                {t('ai_config.system_prompt_reset')}
              </button>
            </div>
          </div>
        )}
      </div>

      {isProxyHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-theme-surface border border-theme-border rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-4 border-b border-theme-border">
              <div className="flex items-center gap-2">
                <Info className="w-5 h-5 text-theme-accent" />
                <h3 className="text-lg font-bold text-theme-text">{t('ai_config.proxy_help_title')}</h3>
              </div>
              <button onClick={() => setIsProxyHelpOpen(false)} className="p-1 hover:bg-theme-bg rounded-full transition-colors">
                <EyeOff className="w-5 h-5 text-theme-subtext" />
              </button>
            </div>
            <div className="p-4 space-y-3 bg-theme-bg rounded-lg border border-theme-border">
              <p className="text-sm text-theme-subtext">{t('ai_config.proxy_help_intro')}</p>
              <ul className="list-disc list-inside space-y-2 text-sm text-theme-text marker:text-theme-subtext">
                <li>{t('ai_config.proxy_help_item_sys_proxy')}</li>
                <li>{t('ai_config.proxy_help_item_custom_proxy')}</li>
                <li>{t('ai_config.proxy_help_item_protocol')}</li>
                <li>{t('ai_config.proxy_help_item_auth')}</li>
                <li>{t('ai_config.proxy_help_item_examples')}</li>
                <li>{t('ai_config.proxy_help_item_test')}</li>
              </ul>
            </div>
            <div className="p-4 border-t border-theme-border flex justify-end">
              <button onClick={() => setIsProxyHelpOpen(false)} className="px-4 py-2 rounded-lg text-sm font-medium bg-theme-surface text-theme-text hover:bg-theme-bg border border-theme-border shadow-sm">
                {t('ai_config.proxy_help_close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isPluginManagerOpen && (
        <PluginManagerModal 
            onClose={() => setIsPluginManagerOpen(false)} 
        />
      )}
    </div>
  );
};
