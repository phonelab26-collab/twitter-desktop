import type { CursorPage, Tweet } from '@shared/types';
import type { Remote } from '../api';
import { ErrorBox } from './ErrorBox';
import { Loading } from './Loading';
import { TweetCard, type TweetActions } from './TweetCard';

/** A list of posts with its loading, error and empty states. */
export function Feed({
  remote,
  actions,
  empty,
  end,
}: {
  remote: Remote<CursorPage<Tweet>> & { reload(): void };
  actions: TweetActions;
  /** Shown when X answered with no post. */
  empty: string;
  /** Shown under the list: guests never get a next page. */
  end: string;
}) {
  if (remote.status === 'idle') return null;
  if (remote.status === 'loading') return <Loading />;
  if (remote.status === 'error') return <ErrorBox error={remote.error} onRetry={remote.reload} />;
  if (remote.data.items.length === 0) return <p className="notice">{empty}</p>;
  return (
    <>
      {remote.data.items.map((tweet) => (
        <TweetCard key={tweet.id} tweet={tweet} actions={actions} />
      ))}
      <p className="feed-end">{end}</p>
    </>
  );
}
