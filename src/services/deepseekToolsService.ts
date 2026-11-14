/**
 * DeepSeek tool endpoints (Files API / ASR / TTS), released 2026-11-13.
 *
 * These are DeepSeek-specific paths, so every entry point is gated on the
 * active provider actually being DeepSeek. Both runtimes are covered:
 * Tauri goes through dedicated Rust commands (multipart upload, binary audio),
 * web mode calls the API directly with FormData/fetch.
 */
import { invoke } from '@tauri-apps/api/core';
import { useAIStore } from '../store/useAIStore';
import type { ChatAttachment } from '../types/character';

const DEEPSEEK_BASE_RE = /api\.deepseek\.com/i;

const isTauriEnv = typeof window !== 'undefined' && (
  ('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window) ||
  (typeof window.location !== 'undefined' && (
    window.location.protocol === 'tauri:' ||
    (typeof window.location.origin === 'string' && window.location.origin.startsWith('http://tauri.localhost'))
  ))
);

export const isDeepseekProvider = (): boolean => {
  const s = useAIStore.getState();
  if (s.provider === 'deepseek') return true;
  return DEEPSEEK_BASE_RE.test(String(s.baseUrl || ''));
};

/** Tool endpoints live under the bare host root, not under /v1. */
const deepseekRoot = (): string => {
  let base = String(useAIStore.getState().baseUrl || '')
    .trim()
    .replace(/[()\s]+/g, '')
    .replace(/^["']+|["']+$/g, '');
  if (!base) base = 'https://api.deepseek.com';
  base = base.replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) base = base.slice(0, -3);
  return base;
};

const authHeader = (): string => {
  const key = useAIStore.getState().getDecryptedApiKey() || '';
  return `Bearer ${key}`;
};

const bytesToBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
};

const rustToolConfig = () => {
  const { baseUrl, getDecryptedApiKey, getProxyUrl, useSystemProxy } = useAIStore.getState();
  return {
    model: '',
    baseURL: String(baseUrl || 'https://api.deepseek.com'),
    apiKey: getDecryptedApiKey() || '',
    proxy_url: getProxyUrl(),
    use_system_proxy: useSystemProxy,
  };
};

// Files the API parses without OCR (text, sheets, ebooks) go through
// `user_data`; PDF/Office/images need server-side parsing. Anything unknown
// defaults to text_recognition — DeepSeek detects the real format from bytes.
const USER_DATA_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'srt', 'vtt', 'lrc',
  'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1',
  'yml', 'yaml', 'xml', 'html', 'htm', 'css', 'sql', 'ini', 'toml',
  'xlsx', 'xls', 'epub', 'mobi',
]);

const filePurpose = (name: string): string => {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return USER_DATA_EXTS.has(ext) ? 'user_data' : 'text_recognition';
};

export const MAX_CHAT_ATTACHMENTS = 4;
// DeepSeek limits: 100 MiB per file overall, but parsed documents cap at
// 1,000 pages — keep a comfortable client-side ceiling instead.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Upload a chat attachment; resolves once the API returns a usable file id. */
export const uploadChatFile = async (file: File): Promise<ChatAttachment> => {
  const purpose = filePurpose(file.name);
  let fileId: string;
  if (isTauriEnv) {
    const buf = await file.arrayBuffer();
    const res = await invoke<any>('ai_upload_file', {
      fileB64: bytesToBase64(buf),
      fileName: file.name,
      purpose,
      config: rustToolConfig(),
    });
    fileId = String(res?.id || '');
  } else {
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', file, file.name);
    const resp = await fetch(`${deepseekRoot()}/files`, {
      method: 'POST',
      headers: { Authorization: authHeader() },
      body: form,
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(body?.error?.message || `HTTP ${resp.status}`);
    fileId = String(body?.id || '');
  }
  if (!fileId) throw new Error('upload-no-file-id');
  return { fileId, name: file.name, size: file.size, mime: file.type || undefined };
};

// ASR accepts 16-bit PCM WAV or Ogg Opus, max 8 MiB / 120 seconds.
export const ASR_MAX_BYTES = 8 * 1024 * 1024;
export const ASR_MAX_SECONDS = 120;

/** Transcribe a recording via DeepSeek ASR; returns the recognized text. */
export const transcribeAudio = async (blob: Blob, seconds: number): Promise<string> => {
  if (blob.size > ASR_MAX_BYTES) throw new Error('asr-too-large');
  if (seconds > ASR_MAX_SECONDS + 2) throw new Error('asr-too-long');
  const ext = blob.type.includes('ogg') ? 'ogg' : 'wav';
  const name = `speech.${ext}`;
  if (isTauriEnv) {
    const buf = await blob.arrayBuffer();
    const res = await invoke<any>('ai_asr', {
      audioB64: bytesToBase64(buf),
      fileName: name,
      config: rustToolConfig(),
    });
    return String(res?.text || '').trim();
  }
  const form = new FormData();
  form.append('file', blob, name);
  const resp = await fetch(`${deepseekRoot()}/v1/tools/asr`, {
    method: 'POST',
    headers: { Authorization: authHeader() },
    body: form,
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(body?.error?.message || `HTTP ${resp.status}`);
  return String(body?.text || '').trim();
};

// TTS bills per 10k characters; the API hard-caps at 10,000 billable chars.
const TTS_MAX_CHARS = 10000;

/**
 * Synthesize speech for an assistant reply. Resolves with a playable URL:
 * a blob URL in web mode, a data URL under Tauri. Markdown is stripped
 * server-side (filter_markdown).
 */
export const synthesizeSpeech = async (text: string): Promise<string> => {
  const clipped = text.slice(0, TTS_MAX_CHARS);
  if (isTauriEnv) {
    const b64 = await invoke<string>('ai_tts', {
      text: clipped,
      voiceId: 'stella',
      config: rustToolConfig(),
    });
    return `data:audio/wav;base64,${b64}`;
  }
  const resp = await fetch(`${deepseekRoot()}/v1/tools/tts`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clipped, voice_id: 'stella', format: 'wav', filter_markdown: true }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(detail.slice(0, 300) || `HTTP ${resp.status}`);
  }
  const buf = await resp.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
};
