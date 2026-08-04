export interface PostAuthor {
  id: string;
  handle: string;
  displayName: string;
}

export interface PostMedia {
  type: 'photo' | 'video' | 'animated_gif';
  url: string;
  altText?: string;
  posterUrl?: string;
  width?: number;
  height?: number;
}

export interface PostReply {
  id: string;
  text: string;
  authorHandle: string;
}

/** Slim payload sent from MAIN world to content script — avoids multi-MB stalls. */
export interface PostBrief {
  id: string;
  text: string;
  author: PostAuthor;
  media: PostMedia[];
  topReplies: PostReply[];
  url: string;
  capturedAt: number;
}

export interface ComprehendResult {
  claim: string;
  tone: string;
  domain: string;
  entities: string[];
  imageDescription: string;
  repliesAlreadySaid: string[];
  summary: string;
}

export type IntentTag = 'Add' | 'Ask' | 'Push back';

export interface Suggestion {
  id: string;
  text: string;
  intent: IntentTag;
  probability?: number;
  styleScore?: number;
}

export type RefinementModifier =
  | 'shorter'
  | 'sharper'
  | 'funnier'
  | 'less_agreeable'
  | 'add_question';
