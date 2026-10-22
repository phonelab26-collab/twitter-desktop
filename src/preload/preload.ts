/**
 * Exposes `window.xapi` to the renderer and nothing else: no ipcRenderer, no
 * Node. The window runs sandboxed, so this file may only require 'electron';
 * the channel names are repeated here and type-checked against IPC_CHANNELS.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { APP_NAVIGATE_EVENT, AppView, IPC_CHANNELS, X_LOAD_FAILED_EVENT, XApi } from '../shared/ipc';

const CHANNELS = {
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
} as const satisfies typeof IPC_CHANNELS;
const LOAD_FAILED: typeof X_LOAD_FAILED_EVENT = 'xview:loadFailed';
const NAVIGATE: typeof APP_NAVIGATE_EVENT = 'app:navigate';
const VIEWS: ReadonlySet<string> = new Set<AppView>(['x', 'trends', 'profile', 'topic']);

const xapi: XApi = {
  getProfile: (screenName) => ipcRenderer.invoke(CHANNELS.getProfile, screenName),
  getUserTweets: (screenName) => ipcRenderer.invoke(CHANNELS.getUserTweets, screenName),
  getTweet: (tweetId) => ipcRenderer.invoke(CHANNELS.getTweet, tweetId),
  getTrendingPosts: () => ipcRenderer.invoke(CHANNELS.getTrendingPosts),
  searchTopic: (topic) => ipcRenderer.invoke(CHANNELS.searchTopic, topic),
  getTrends: (woeid) => ipcRenderer.invoke(CHANNELS.getTrends, woeid),
  getTrendLocations: () => ipcRenderer.invoke(CHANNELS.getTrendLocations),
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
  onNavigate: (listener) => {
    // Only a known view name crosses the bridge.
    const relay = (_event: unknown, view: unknown) => {
      if (typeof view === 'string' && VIEWS.has(view)) listener(view as AppView);
    };
    ipcRenderer.on(NAVIGATE, relay);
    return () => {
      ipcRenderer.removeListener(NAVIGATE, relay);
    };
  },
  xview: {
    show: (insets) => ipcRenderer.invoke(CHANNELS.xviewShow, insets),
    setInsets: (insets) => ipcRenderer.invoke(CHANNELS.xviewSetInsets, insets),
    hide: () => ipcRenderer.invoke(CHANNELS.xviewHide),
    open: (url) => ipcRenderer.invoke(CHANNELS.xviewOpen, url),
    navigate: (action) => ipcRenderer.invoke(CHANNELS.xviewNavigate, action),
    signOut: () => ipcRenderer.invoke(CHANNELS.xviewSignOut),
    onLoadFailed: (listener) => {
      // Only the message string crosses the bridge, never the IPC event object.
      const relay = (_event: unknown, message: unknown) => {
        if (typeof message === 'string') listener(message);
      };
      ipcRenderer.on(LOAD_FAILED, relay);
      return () => {
        ipcRenderer.removeListener(LOAD_FAILED, relay);
      };
    },
  },
};

contextBridge.exposeInMainWorld('xapi', xapi);
