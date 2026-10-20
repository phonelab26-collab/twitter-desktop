/**
 * IPC handlers: the only door from the renderer to the network. Arguments
 * come from an untrusted renderer, so each one is type-checked here before it
 * reaches XService (which validates the values themselves: handle, id, woeid).
 */
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { ApiError, ERROR_CODES, toResult } from './api/client';
import type { XService } from './api/service';
import { Semaphore, WindowBudget } from './budget';
import { TtlCache } from './cache';
import { isXUrl, sanitizeBounds, type ViewBounds } from './xpolicy';
import type { XNavigation, XViewController } from './xview';
import { IPC_CHANNELS } from '../shared/ipc';
import type { ApiResult, TrendList, TrendLocation } from '../shared/types';

/** 15 calls per 15 minutes are allowed on 1.1/trends/*: refresh at most every 5. */
const TRENDS_TTL_MS = 5 * 60_000;
const LOCATIONS_TTL_MS = 60 * 60_000;
/** Below X's own 15 per 15 min, so the app never reaches X's limit by itself. */
const TRENDS_BUDGET = { max: 10, windowMs: 15 * 60_000 };
/** Network calls one renderer may have running at once on a channel. */
const MAX_IN_FLIGHT_PER_CHANNEL = 4;
const EXTERNAL_HOSTS = new Set(['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com']);

function invalidArgument(name: string): ApiError {
  return new ApiError(0, `Invalid argument: ${name}.`, ERROR_CODES.INVALID_INPUT, { retriable: false });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw invalidArgument(name);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') throw invalidArgument(name);
  return value;
}

/** Only https links to X itself leave the app, and only to the system browser. */
export function externalUrl(value: unknown): string {
  const raw = requireString(value, 'url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidArgument('url');
  }
  if (url.protocol === 'http:' && EXTERNAL_HOSTS.has(url.hostname)) url.protocol = 'https:';
  if (url.protocol !== 'https:' || !EXTERNAL_HOSTS.has(url.hostname)) throw invalidArgument('url');
  return url.toString();
}

function requireBounds(value: unknown): ViewBounds {
  const bounds = sanitizeBounds(value);
  if (!bounds) throw invalidArgument('bounds');
  return bounds;
}

const NAVIGATIONS: ReadonlySet<string> = new Set(['back', 'forward', 'reload', 'home']);

function requireNavigation(value: unknown): XNavigation {
  if (typeof value !== 'string' || !NAVIGATIONS.has(value)) throw invalidArgument('navigation');
  return value as XNavigation;
}

type Handler = (...args: unknown[]) => unknown;

/** What the handlers need from the window that owns them. */
export interface IpcContext {
  /** Only the main frame of the app's own page may call; x.com (the "Mon X" view) never can. */
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
  xview(): XViewController;
}

/** Logs a failed call in the main process (code, status, a bounded body), never its arguments. */
function logFailure(channel: string, error: unknown): void {
  if (error instanceof ApiError) {
    console.error(`[ipc] ${channel} failed: ${error.code ?? 'no code'} (HTTP ${error.status}) ${error.message}`, error.body?.slice(0, 500) ?? '');
  } else {
    console.error(`[ipc] ${channel} failed unexpectedly:`, error);
  }
}

/**
 * Registers every handler. Each call is checked against the trusted sender
 * and answers an ApiResult, never a thrown error.
 */
export function registerIpcHandlers(service: XService, context: IpcContext): void {
  const handle = (channel: string, handler: Handler): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ApiResult<unknown>> => {
      if (!context.isTrustedSender(event)) {
        console.error(`[ipc] ${channel} refused: call from an untrusted page or frame.`);
        return toResult(Promise.reject(new ApiError(403, 'IPC call from an untrusted page.', ERROR_CODES.INVALID_INPUT, { retriable: false })));
      }
      const call = Promise.resolve().then(() => handler(...args));
      call.catch((error: unknown) => logFailure(channel, error));
      return toResult(call);
    });
  };
  /** A network channel: at most MAX_IN_FLIGHT_PER_CHANNEL calls at once. */
  const handleNetwork = (channel: string, handler: Handler): void => {
    const slots = new Semaphore(MAX_IN_FLIGHT_PER_CHANNEL);
    handle(channel, (...args) => slots.run(async () => handler(...args)));
  };

  const trends = new TtlCache<number, TrendList>(TRENDS_TTL_MS);
  const locations = new TtlCache<'all', TrendLocation[]>(LOCATIONS_TTL_MS);
  const trendsBudget = new WindowBudget(TRENDS_BUDGET.max, TRENDS_BUDGET.windowMs);
  const knownLocations = () => locations.get('all', () => service.getTrendLocations());

  handleNetwork(IPC_CHANNELS.getProfile, (name) => service.getProfile(requireString(name, 'screenName')));
  handleNetwork(IPC_CHANNELS.getUserTweets, (name) => service.getUserTweets(requireString(name, 'screenName')));
  handleNetwork(IPC_CHANNELS.getTweet, (id) => service.getTweet(requireString(id, 'tweetId')));
  handleNetwork(IPC_CHANNELS.getTrendingPosts, () => service.getTrendingPosts());
  handleNetwork(IPC_CHANNELS.searchTopic, (topic) => service.searchTopic(requireString(topic, 'topic')));
  handleNetwork(IPC_CHANNELS.getTrends, async (woeid) => {
    const id = requireNumber(woeid, 'woeid');
    // Only places X lists: arbitrary numbers would each cost a real call against a 15/15 min quota.
    if (!(await knownLocations()).some((place) => place.woeid === id)) throw invalidArgument('woeid');
    return trends.get(id, () => {
      const slot = trendsBudget.tryTake();
      if (!slot.ok) {
        const minutes = Math.ceil(slot.retryInMs / 60_000);
        return Promise.reject(
          new ApiError(429, `Too many trend requests; try again in ${minutes} min.`, ERROR_CODES.RATE_LIMITED, { retriable: true }),
        );
      }
      return service.getTrends(id);
    });
  });
  handleNetwork(IPC_CHANNELS.getTrendLocations, knownLocations);
  handle(IPC_CHANNELS.openExternal, async (url) => {
    await shell.openExternal(externalUrl(url));
  });

  handle(IPC_CHANNELS.xviewShow, (bounds) => context.xview().show(requireBounds(bounds)));
  handle(IPC_CHANNELS.xviewSetBounds, (bounds) => context.xview().setBounds(requireBounds(bounds)));
  handle(IPC_CHANNELS.xviewHide, () => context.xview().hide());
  handle(IPC_CHANNELS.xviewOpen, (url) => {
    const target = requireString(url, 'url');
    if (!isXUrl(target)) throw invalidArgument('url');
    context.xview().open(target);
  });
  handle(IPC_CHANNELS.xviewNavigate, (action) => context.xview().navigate(requireNavigation(action)));
  handle(IPC_CHANNELS.xviewSignOut, () => context.xview().signOut());
}
