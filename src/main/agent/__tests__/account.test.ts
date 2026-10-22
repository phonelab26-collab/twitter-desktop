import { describe, expect, it, vi } from 'vitest';
import { createAccountWatcher } from '../account';

describe('createAccountWatcher', () => {
  it('stays quiet while the same account refreshes its cookie', () => {
    const onChange = vi.fn();
    const watcher = createAccountWatcher(onChange);
    watcher.seed('u%3D1');

    watcher.observe({ value: 'u%3D1', removed: true, cause: 'overwrite' });
    watcher.observe({ value: 'u%3D1', removed: false, cause: 'explicit' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires when another account signs in, and when the account signs out', () => {
    const onChange = vi.fn();
    const watcher = createAccountWatcher(onChange);
    watcher.seed('u%3D1');

    watcher.observe({ value: 'u%3D1', removed: true, cause: 'overwrite' });
    watcher.observe({ value: 'u%3D2', removed: false, cause: 'explicit' });
    expect(onChange).toHaveBeenCalledTimes(1);

    watcher.observe({ value: 'u%3D2', removed: true, cause: 'explicit' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('fires when someone signs in after a signed-out start', () => {
    const onChange = vi.fn();
    const watcher = createAccountWatcher(onChange);
    watcher.seed(null);

    watcher.observe({ value: 'u%3D1', removed: false, cause: 'explicit' });

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('takes the first value it sees as the start when it could not be seeded', () => {
    const onChange = vi.fn();
    const watcher = createAccountWatcher(onChange);

    watcher.observe({ value: 'u%3D1', removed: false, cause: 'explicit' });
    watcher.seed('u%3D9');

    expect(onChange).not.toHaveBeenCalled();
  });
});
