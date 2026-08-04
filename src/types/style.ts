export interface StyleCard {
  medianWordCount: number;
  p75WordCount: number;
  emojiRate: number;
  lowercaseOpenerRate: number;
  contractionRate: number;
  openers: string[];
  signaturePhrases: string[];
  bannedPatterns: string[];
  capitalizationStyle: 'mixed' | 'lowercase' | 'sentence';
  sampleCount: number;
  updatedAt: number;
}

export interface ReplyCorpusEntry {
  id: string;
  text: string;
  wordCount: number;
  createdAt: number;
  isOwnReply: boolean;
}

export interface PostedDiff {
  id: string;
  tweetId: string;
  suggestionId?: string;
  suggestionText?: string;
  postedText: string;
  diffRatio: number;
  timestamp: number;
}

export interface UserConditioning {
  knownFor: string;
  neverMention: string;
  defaultIntent: 'Add' | 'Ask' | 'Push back';
}

export const DEFAULT_STYLE_CARD: StyleCard = {
  medianWordCount: 14,
  p75WordCount: 22,
  emojiRate: 0.05,
  lowercaseOpenerRate: 0.3,
  contractionRate: 0.4,
  openers: ['tbh', 'imo', 'yeah'],
  signaturePhrases: [],
  bannedPatterns: [
    'not .* but',
    'delve',
    'underscore',
    'meticulous',
    'commendable',
    'tapestry',
    'intricate',
  ],
  capitalizationStyle: 'mixed',
  sampleCount: 0,
  updatedAt: Date.now(),
};
