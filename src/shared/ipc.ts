/**
 * The contract between the renderer and the main process. The renderer never
 * talks to X directly: it calls `window.xapi`, exposed by the preload through
 * contextBridge, and every call is validated again in the main process.
 */
import type { AgentCopyKind, AgentStatus } from './agent';
import type {
  ApiResult,
  CursorPage,
  TrendList,
  TrendLocation,
  Tweet,
  UserProfile,
} from './types';

export const IPC_CHANNELS = {
  getProfile: 'xapi:getProfile',
  getUserTweets: 'xapi:getUserTweets',
  getTweet: 'xapi:getTweet',
  getTrendingPosts: 'xapi:getTrendingPosts',
  searchTopic: 'xapi:searchTopic',
  getTrends: 'xapi:getTrends',
  getTrendLocations: 'xapi:getTrendLocations',
  openExternal: 'app:openExternal',
  xviewShow: 'xview:show',
  xviewSetInsets: 'xview:setInsets',
  xviewHide: 'xview:hide',
  xviewOpen: 'xview:open',
  xviewNavigate: 'xview:navigate',
  xviewSignOut: 'xview:signOut',
  agentStatus: 'agent:status',
  agentSetEnabled: 'agent:setEnabled',
  agentRegenerateToken: 'agent:regenerateToken',
  agentCopy: 'agent:copy',
} as const;

/** Main → renderer: x.com failed to load in the "Mon X" view (payload: a message). */
export const X_LOAD_FAILED_EVENT = 'xview:loadFailed';

export type XSignOutResult = 'cleared' | 'logout-page' | 'cancelled';

/** Main → renderer: switch tab (menu shortcuts ⌘1-⌘5). Payload: one of APP_VIEWS. */
export const APP_NAVIGATE_EVENT = 'app:navigate';
export const APP_VIEWS = ['x', 'trends', 'profile', 'topic', 'agent'] as const;
export type AppView = (typeof APP_VIEWS)[number];

/**
 * Space the app UI keeps around x.com in the "Mon X" tab, in CSS pixels from
 * each edge of the window: the main process derives the bounds on every resize.
 */
export interface XViewInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type XViewNavigation = 'back' | 'forward' | 'reload' | 'home';

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface XApi {
  /** `undefined` data: the handle does not exist or the account is unavailable. */
  getProfile(screenName: string): Promise<ApiResult<UserProfile | undefined>>;
  /** The ~5 latest posts a logged-out visitor sees; `cursor` is always null. */
  getUserTweets(screenName: string): Promise<ApiResult<CursorPage<Tweet>>>;
  getTweet(tweetId: string): Promise<ApiResult<Tweet | undefined>>;
  getTrendingPosts(): Promise<ApiResult<CursorPage<Tweet>>>;
  searchTopic(topic: string): Promise<ApiResult<CursorPage<Tweet>>>;
  getTrends(woeid: number): Promise<ApiResult<TrendList>>;
  getTrendLocations(): Promise<ApiResult<TrendLocation[]>>;
  /** Opens an https://x.com or https://twitter.com link in the system browser. */
  openExternal(url: string): Promise<ApiResult<void>>;
  /** Calls `listener` when a menu shortcut asks for a tab; returns the unsubscribe function. */
  onNavigate(listener: (view: AppView) => void): () => void;
  /** The real x.com with the user's own session ("Mon X" tab). */
  xview: {
    show(insets: XViewInsets): Promise<ApiResult<void>>;
    setInsets(insets: XViewInsets): Promise<ApiResult<void>>;
    hide(): Promise<ApiResult<void>>;
    /** Loads an https x.com / twitter.com page in the tab. */
    open(url: string): Promise<ApiResult<void>>;
    navigate(action: XViewNavigation): Promise<ApiResult<void>>;
    /** Asks (in a main-process dialog) to open X's sign-out page or clear the local X data. */
    signOut(): Promise<ApiResult<XSignOutResult>>;
    /** Calls `listener` when x.com fails to load; returns the unsubscribe function. */
    onLoadFailed(listener: (message: string) => void): () => void;
  };
  /** The agent link (read-only access to the captured X feed for a local agent). */
  agent: {
    status(): Promise<ApiResult<AgentStatus>>;
    /** Turning it on asks for confirmation in a main-process dialog. */
    setEnabled(on: boolean): Promise<ApiResult<AgentStatus>>;
    regenerateToken(): Promise<ApiResult<AgentStatus>>;
    /** Copies on the main side: the token never reaches the page. */
    copy(kind: AgentCopyKind): Promise<ApiResult<AgentStatus>>;
  };
}
