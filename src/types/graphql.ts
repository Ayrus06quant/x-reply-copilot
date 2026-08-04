/** X GraphQL payload types — all paths read defensively with ?? at call sites. */

export interface GraphQLTweetResult {
  __typename?: string;
  rest_id?: string;
  legacy?: {
    full_text?: string;
    created_at?: string;
    user_id_str?: string;
    in_reply_to_status_id_str?: string;
    extended_entities?: {
      media?: GraphQLMedia[];
    };
    entities?: {
      media?: GraphQLMedia[];
    };
  };
  note_tweet?: {
    note_tweet_results?: {
      result?: {
        text?: string;
      };
    };
  };
  core?: {
    user_results?: {
      result?: GraphQLUserResult;
    };
  };
  views?: { count?: string };
  extended_entities?: {
    media?: GraphQLMedia[];
  };
}

export interface GraphQLMedia {
  type?: string;
  media_url_https?: string;
  ext_alt_text?: { alt_text?: string };
  video_info?: {
    variants?: Array<{
      url?: string;
      content_type?: string;
      bitrate?: number;
    }>;
  };
  sizes?: {
    large?: { w?: number; h?: number };
    medium?: { w?: number; h?: number };
  };
}

export interface GraphQLUserResult {
  rest_id?: string;
  legacy?: {
    screen_name?: string;
    name?: string;
  };
  core?: {
    screen_name?: string;
    name?: string;
  };
}

export interface GraphQLInstruction {
  type?: string;
  entries?: Array<{
    content?: {
      itemContent?: {
        tweet_results?: {
          result?: GraphQLTweetResult | { tweet?: GraphQLTweetResult };
        };
      };
      entryType?: string;
    };
  }>;
}

export interface GraphQLTimelineData {
  data?: {
    tweetResult?: { result?: GraphQLTweetResult };
    user?: {
      result?: {
        timeline_v2?: {
          timeline?: { instructions?: GraphQLInstruction[] };
        };
        timeline?: { timeline?: { instructions?: GraphQLInstruction[] } };
      };
    };
    home?: {
      home_timeline_urt?: { instructions?: GraphQLInstruction[] };
    };
    create_tweet?: {
      tweet_results?: { result?: GraphQLTweetResult };
    };
  };
}

export const ALLOWED_OPERATIONS = [
  'TweetDetail',
  'HomeTimeline',
  'UserTweetsAndReplies',
  'CreateTweet',
] as const;

export type AllowedOperation = (typeof ALLOWED_OPERATIONS)[number];
