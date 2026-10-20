/**
 * Local limits that keep a buggy or compromised renderer from burning X's
 * quotas (which would lock the guest out, or get the IP blocked).
 */

/** At most `max` uses per sliding `windowMs`. */
export class WindowBudget {
  private stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes a slot, or says how long until one frees up. */
  tryTake(): { ok: true } | { ok: false; retryInMs: number } {
    const time = this.now();
    this.stamps = this.stamps.filter((stamp) => time - stamp < this.windowMs);
    if (this.stamps.length >= this.max) return { ok: false, retryInMs: this.windowMs - (time - this.stamps[0]) };
    this.stamps = [...this.stamps, time];
    return { ok: true };
  }
}

/** At most `max` calls running at once; the others wait their turn. */
export class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.free = max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}
