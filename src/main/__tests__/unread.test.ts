import { describe, expect, it, vi } from 'vitest';
import { createUnreadTracker, parseUnreadTitle } from '../unread';

describe('parseUnreadTitle', () => {
  it('reads the count x.com puts in front of the page title', () => {
    expect(parseUnreadTitle('(3) Home / X')).toEqual({ count: 3, overflow: false });
    expect(parseUnreadTitle('(12) Notifications / X')).toEqual({ count: 12, overflow: false });
  });

  it('flags an overflowing count such as "(20+)"', () => {
    expect(parseUnreadTitle('(20+) Home / X')).toEqual({ count: 20, overflow: true });
  });

  it('is 0 for a title without a count prefix', () => {
    expect(parseUnreadTitle('Home / X')).toEqual({ count: 0, overflow: false });
    expect(parseUnreadTitle('')).toEqual({ count: 0, overflow: false });
  });

  it('ignores a count that is not at the very start (page text must not forge a badge)', () => {
    expect(parseUnreadTitle('Home (5) / X')).toEqual({ count: 0, overflow: false });
    expect(parseUnreadTitle(' (5) Home / X')).toEqual({ count: 0, overflow: false });
  });

  it('refuses absurd or malformed counts instead of showing them', () => {
    for (const title of ['(0) X', '(99999) X', '(-3) X', '(3.5) X', '(abc) X', '(3)X']) {
      expect(parseUnreadTitle(title)).toEqual({ count: 0, overflow: false });
    }
  });
});

describe('createUnreadTracker', () => {
  function setup(attention = false) {
    const sink = { setBadge: vi.fn(), notify: vi.fn() };
    const tracker = createUnreadTracker(sink, () => attention);
    return { sink, tracker };
  }

  it('shows the count as the badge and clears it at zero', () => {
    const { sink, tracker } = setup(true);

    tracker.onTitle('(3) Home / X');
    tracker.onTitle('Home / X');

    expect(sink.setBadge.mock.calls).toEqual([['3'], ['']]);
  });

  it('keeps the + of an overflowing count in the badge', () => {
    const { sink, tracker } = setup(true);

    tracker.onTitle('(20+) Home / X');

    expect(sink.setBadge).toHaveBeenCalledWith('20+');
  });

  it('does not touch the badge again when the count did not change', () => {
    const { sink, tracker } = setup(true);

    tracker.onTitle('(3) Home / X');
    tracker.onTitle('(3) Notifications / X');

    expect(sink.setBadge).toHaveBeenCalledTimes(1);
  });

  it('notifies when the count rises and the user is not looking at X', () => {
    const { sink, tracker } = setup(false);

    tracker.onTitle('(2) Home / X');

    expect(sink.notify).toHaveBeenCalledWith({ count: 2, overflow: false });
  });

  it('stays quiet while the user is looking at X', () => {
    const { sink, tracker } = setup(true);

    tracker.onTitle('(2) Home / X');

    expect(sink.notify).not.toHaveBeenCalled();
  });

  it('does not notify when the count drops or stays the same', () => {
    const { sink, tracker } = setup(false);

    tracker.onTitle('(5) Home / X');
    sink.notify.mockClear();
    tracker.onTitle('(5) Home / X');
    tracker.onTitle('(2) Home / X');
    tracker.onTitle('Home / X');

    expect(sink.notify).not.toHaveBeenCalled();
  });

  it('does not notify twice for the same unread when the title blinks through a page without count', () => {
    const { sink, tracker } = setup(false);

    tracker.onTitle('(3) Home / X');
    tracker.onTitle('X');
    tracker.onTitle('(3) Home / X');

    expect(sink.notify).toHaveBeenCalledTimes(1);
  });

  it('notifies again for more unread than the last notification covered', () => {
    const { sink, tracker } = setup(false);

    tracker.onTitle('(3) Home / X');
    tracker.onTitle('X');
    tracker.onTitle('(4) Home / X');

    expect(sink.notify).toHaveBeenCalledTimes(2);
  });

  it('forgets what was notified once the user looks at X', () => {
    let watching = false;
    const sink = { setBadge: vi.fn(), notify: vi.fn() };
    const tracker = createUnreadTracker(sink, () => watching);

    tracker.onTitle('(3) Home / X');
    watching = true;
    tracker.onTitle('X');
    watching = false;
    tracker.onTitle('(2) Home / X');

    expect(sink.notify).toHaveBeenCalledTimes(2);
  });

  it('reset clears the badge and forgets the count (sign-out)', () => {
    const { sink, tracker } = setup(false);
    tracker.onTitle('(4) Home / X');
    sink.setBadge.mockClear();
    sink.notify.mockClear();

    tracker.reset();
    tracker.onTitle('(4) Home / X');

    expect(sink.setBadge.mock.calls).toEqual([[''], ['4']]);
    expect(sink.notify).toHaveBeenCalledTimes(1);
  });
});
