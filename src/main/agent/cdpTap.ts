/**
 * Reads x.com's own network traffic in the "Mon X" view through the
 * DevTools protocol (webContents.debugger), only while the agent link is on.
 *
 * The debugger can do far more than read (run scripts in x.com, click, read
 * cookies), so every command goes through an allow-list of three network
 * read commands, enforced twice: by restrictDebugger() around Electron's
 * debugger, and again here. Only response bodies that captureTarget()
 * selects are read; the raw request/response headers (cookies) are never
 * asked for and the events carrying them are ignored. Nothing it sees is
 * logged. It adds no request to X.
 */
import { captureTarget, readCapture, type CaptureReading, type ReadableTarget } from './capture';

/** The part of Electron's webContents.debugger the tap uses (a fake in tests). */
export interface DebuggerPort {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: 'message', listener: (event: unknown, method: string, params: any) => void): unknown;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown;
  removeListener(event: 'message' | 'detach', listener: (...args: any[]) => void): unknown;
}

export interface TapStats {
  attached: boolean;
  startedAt?: number;
  stoppedAt?: number;
  stopReason?: string;
  responsesRead: number;
  /** Bodies the browser no longer had (evicted, served by a service worker...). */
  bodiesUnavailable: number;
  errors: number;
  lastError?: string;
  lastReadAt?: number;
  /** Personal timelines seen and deliberately not read, by operation. */
  personal: Readonly<Record<string, number>>;
  /** Feeds the app does not know (a renamed one?), seen and not read, by operation. */
  unrecognised: Readonly<Record<string, number>>;
  /** Known feeds in a format not read yet (multipart...), by operation. */
  unsupported: Readonly<Record<string, number>>;
  /** Responses not read because too many were waiting or being read. */
  dropped: number;
}

const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(['Network.enable', 'Network.disable', 'Network.getResponseBody']);
/** What x.com's renderer may keep of response bodies for us; real timelines are well under 1 MB. */
const NETWORK_BUFFERS = { maxTotalBufferSize: 16 * 1024 * 1024, maxResourceBufferSize: 4 * 1024 * 1024 };
const MAX_BODY_CHARS = 8 * 1024 * 1024;
export const MAX_PENDING = 256;
/** Bodies read and parsed at once; x.com loads two or three timelines at a time. */
export const MAX_READS = 8;
/** Distinct operation names kept per counter; x.com could otherwise invent names without end. */
export const MAX_NAMES = 50;
export const OTHER_NAMES = '(other)';

export function isAllowedCommand(method: string): boolean {
  return ALLOWED_COMMANDS.has(method);
}

/** Electron's debugger, able to send the three network reads and nothing else. */
export function restrictDebugger(port: DebuggerPort): DebuggerPort {
  return {
    attach: (protocolVersion) => port.attach(protocolVersion),
    detach: () => port.detach(),
    isAttached: () => port.isAttached(),
    sendCommand: (method, params) =>
      isAllowedCommand(method) ? port.sendCommand(method, params) : Promise.reject(new Error(`${method} is not allowed for the capture.`)),
    on: (event: 'message' | 'detach', listener: (...args: any[]) => void) => port.on(event as 'message', listener),
    removeListener: (event, listener) => port.removeListener(event, listener),
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** Counts by name, at most MAX_NAMES names (the rest under OTHER_NAMES). */
class NameCounts {
  private readonly counts = new Map<string, number>();

  add(name: string): void {
    const key = this.counts.has(name) || this.counts.size < MAX_NAMES ? name : OTHER_NAMES;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.counts);
  }
}

type Counters = Omit<TapStats, 'personal' | 'unrecognised' | 'unsupported'>;

export class CaptureTap {
  private counters: Counters = { attached: false, responsesRead: 0, bodiesUnavailable: 0, errors: 0, dropped: 0 };
  private readonly personal = new NameCounts();
  private readonly unrecognised = new NameCounts();
  private readonly unsupported = new NameCounts();
  private readonly pending = new Map<string, { target: ReadableTarget; snapshotAt: number }>();
  private reading = 0;
  private active = false;

  constructor(
    private readonly port: DebuggerPort,
    private readonly onReading: (reading: CaptureReading, snapshotAt: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get stats(): TapStats {
    return { ...this.counters, personal: this.personal.snapshot(), unrecognised: this.unrecognised.snapshot(), unsupported: this.unsupported.snapshot() };
  }

  /** Throws when the debugger cannot be attached (DevTools open) or the network cannot be read. */
  async start(): Promise<void> {
    this.port.attach('1.3');
    this.port.on('message', this.onMessage);
    this.port.on('detach', this.onDetach);
    this.active = true;
    try {
      await this.send('Network.enable', NETWORK_BUFFERS);
    } catch (error) {
      await this.stop(`network unavailable: ${message(error)}`);
      throw error;
    }
    this.counters = { ...this.counters, attached: true, startedAt: this.now(), stoppedAt: undefined, stopReason: undefined };
  }

  async stop(reason: string): Promise<void> {
    const wasActive = this.active;
    this.active = false;
    this.pending.clear();
    this.port.removeListener('message', this.onMessage);
    this.port.removeListener('detach', this.onDetach);
    if (wasActive && this.port.isAttached()) {
      try {
        await this.send('Network.disable');
      } catch (error) {
        console.warn(`[agent] Network.disable failed while stopping the capture: ${message(error)}`);
      }
      this.port.detach();
    }
    this.counters = { ...this.counters, attached: false, stoppedAt: this.now(), stopReason: reason };
  }

  private send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!isAllowedCommand(method)) return Promise.reject(new Error(`The capture may not send ${method}.`));
    return this.port.sendCommand(method, params);
  }

  private fail(error: string, counter: 'errors' | 'bodiesUnavailable' = 'errors'): void {
    this.counters = { ...this.counters, [counter]: this.counters[counter] + 1, lastError: error };
  }

  private readonly onDetach = (_event: unknown, reason: string): void => {
    this.active = false;
    this.pending.clear();
    this.counters = { ...this.counters, attached: false, stoppedAt: this.now(), stopReason: String(reason) };
  };

  private readonly onMessage = (_event: unknown, method: string, params: any): void => {
    if (!this.active || !params || typeof params.requestId !== 'string') return;
    if (method === 'Network.responseReceived') this.onResponse(params.requestId, params);
    else if (method === 'Network.loadingFinished') this.onFinished(params.requestId);
    else if (method === 'Network.loadingFailed') this.pending.delete(params.requestId);
  };

  private onResponse(requestId: string, params: any): void {
    const response = params.response ?? {};
    const target = captureTarget({ url: String(response.url), type: params.type, status: Number(response.status), mimeType: String(response.mimeType) });
    if (!target) return;
    if (target.kind === 'personal') return this.personal.add(target.operation);
    if (target.kind === 'unrecognised') return this.unrecognised.add(target.operation);
    if (target.kind === 'unsupported') return this.unsupported.add(target.operation);
    this.pending.set(requestId, { target, snapshotAt: this.now() });
    if (this.pending.size > MAX_PENDING) {
      this.pending.delete(this.pending.keys().next().value as string);
      this.counters = { ...this.counters, dropped: this.counters.dropped + 1 };
    }
  }

  private onFinished(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    if (this.reading >= MAX_READS) {
      this.counters = { ...this.counters, dropped: this.counters.dropped + 1 };
      return;
    }
    this.reading += 1;
    void this.read(requestId, entry).finally(() => (this.reading -= 1));
  }

  private async read(requestId: string, entry: { target: ReadableTarget; snapshotAt: number }): Promise<void> {
    let result: { body?: unknown; base64Encoded?: unknown };
    try {
      result = await this.send('Network.getResponseBody', { requestId });
    } catch (error) {
      if (this.active) this.fail(message(error), 'bodiesUnavailable');
      return;
    }
    if (!this.active) return;
    const body = typeof result.body !== 'string' ? undefined : result.base64Encoded === true ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
    if (body === undefined || body.length > MAX_BODY_CHARS) {
      this.fail(body === undefined ? 'response body missing' : 'response body too large');
      return;
    }
    try {
      const reading = readCapture(entry.target, body);
      reading.personal.forEach((name) => this.personal.add(name));
      reading.unrecognised.forEach((name) => this.unrecognised.add(name));
      this.counters = { ...this.counters, responsesRead: this.counters.responsesRead + 1, lastReadAt: this.now() };
      if (reading.error) this.fail(reading.error);
      this.onReading(reading, entry.snapshotAt);
    } catch (error) {
      this.fail(`reading a response failed: ${message(error)}`);
    }
  }
}
