import { MediaItem } from './types';

/** How a character speaks; distilled from the work and enforced in chat prompts. */
export interface ExpressionDNA {
  tone?: string;
  /** Formality from 1 (very formal) to 5 (very colloquial); 0 = unknown. */
  formality: number;
  catchphrases: string[];
  vocabulary: string[];
  sentenceStyle?: string;
  exampleLines: string[];
}

export interface CharacterRelation {
  name: string;
  relation: string;
}

export interface TimelineEvent {
  period: string;
  event: string;
}

/**
 * User-issued correction (distilly-style correction layer). Corrections are
 * injected into the chat system prompt and take precedence over the persona.
 */
export interface CharacterCorrection {
  scene: string;
  wrong: string;
  correct: string;
  createdAt: number;
}

export interface DistilledCharacter {
  id: string;
  name: string;
  aliases: string[];
  sourceTitle: string;
  sourceMediaId?: string;
  sourceType?: string;
  tagline?: string;
  appearance?: string;
  personality: string[];
  mentalModels: string[];
  decisionHeuristics: string[];
  interpersonal?: string;
  boundaries: string[];
  background?: string;
  expression: ExpressionDNA | null;
  relationships: CharacterRelation[];
  quotes: string[];
  externalViews: string[];
  timeline: TimelineEvent[];
  corrections: CharacterCorrection[];
  /** Bumped on every incremental re-distillation / correction. */
  version: number;
  avatarUrl?: string;
  /** In-character first message inserted into new chat sessions. */
  greeting?: string;
  createdAt: number;
  updatedAt: number;
}

/** A file uploaded to the DeepSeek Files API and referenced by id in chat turns. */
export interface ChatAttachment {
  fileId: string;
  name: string;
  size: number;
  mime?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  createdAt: number;
}

export interface ChatSession {
  id: string;
  characterId: string;
  title: string;
  /** Rolling summary of the archived message prefix (see summarizedUpTo). */
  summary?: string;
  /** Messages up to (exclusive of) this index are covered by `summary`
   *  and are no longer replayed verbatim (nanobot-style archive offset). */
  summarizedUpTo: number;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface DistillOptions {
  /** Extra source material pasted by the user (synopses, reviews, transcripts...). */
  extraMaterial?: string;
  /** e.g. "主角" or specific character names. */
  focus?: string;
  /** Distill only this named character (forces a single-character result). */
  characterName?: string;
  maxCharacters?: number;
  /** Output language for the generated profile, derived from the UI locale. */
  language?: 'zh' | 'en';
}
