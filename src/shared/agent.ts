/**
 * The agent link as the app UI and the agent see it: shared by the main
 * process (src/main/agent) and the renderer (Agent tab).
 */

/** How fresh the captured feed can be: without it, "nobody posted" and "nothing captured" look the same. */
export interface CaptureStatus {
  /** The app reads x.com's traffic right now. */
  capturing: boolean;
  xView: 'open' | 'closed';
  /** x.com slows its own refreshes while hidden (another tab, minimised window). */
  xViewVisible: boolean;
  /** The "Mon X" tab shows the home timeline, the page that keeps loading new posts. */
  onHomeTimeline: boolean;
  lastCaptureAt?: string;
  stoppedAt?: string;
  stopReason?: string;
  /** Post entries X sent that could not be read (format change). */
  unreadablePosts: number;
  errors: number;
  lastError?: string;
}

/** What the "Copier" buttons of the Agent tab can put on the clipboard. */
export const AGENT_COPY_KINDS = ['token', 'mcpUrl', 'claudeCommand', 'curlCommand'] as const;
export type AgentCopyKind = (typeof AGENT_COPY_KINDS)[number];

export interface AgentStatus {
  enabled: boolean;
  server: { state: 'off' | 'listening' | 'error'; url: string; message?: string };
  /** False: the keychain could not encrypt the token, so it is forgotten when the app quits. */
  tokenPersisted: boolean;
  settingsIssue?: string;
  /** The commands to paste, the token masked: the token itself never reaches the UI. */
  commands: { mcpUrl: string; claudeCommand: string; curlCommand: string };
  capture: CaptureStatus & {
    posts: number;
    epoch: string;
    bodiesUnavailable: number;
    /** Personal timelines seen and deliberately not read (bookmarks, likes...). */
    personal: string[];
    /** Feeds seen that the app does not know, so not read: X may have renamed one. */
    unrecognised: string[];
    /** Known feeds in a format the app does not read yet. */
    unsupported: string[];
  };
  requests: { count: number; lastAt?: string };
  /** When the copied token will be wiped from the clipboard. */
  clipboardClearsAt?: string;
}
