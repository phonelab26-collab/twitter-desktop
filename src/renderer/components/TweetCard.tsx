import type { MediaRef, Tweet } from '@shared/types';
import { openOnX } from '../api';
import { formatCount, formatFullDate, formatRelative } from '../format';
import { Avatar } from './Avatar';

export interface TweetActions {
  openProfile(screenName: string): void;
}

function Media({ item }: { item: MediaRef }) {
  if (item.type === 'photo') {
    return <img className="media" src={item.url ?? item.thumbnailUrl} alt={item.altText ?? ''} loading="lazy" decoding="async" />;
  }
  if (!item.url) {
    // X offered no playable mp4 for this video: show its image, say so.
    return (
      <figure className="media-unplayable">
        <img className="media" src={item.thumbnailUrl} alt={item.altText ?? ''} loading="lazy" decoding="async" />
        <figcaption>Vidéo non lisible ici</figcaption>
      </figure>
    );
  }
  const gif = item.type === 'gif';
  return (
    <video
      className="media"
      src={item.url}
      poster={item.thumbnailUrl}
      controls={!gif}
      autoPlay={gif}
      loop={gif}
      muted={gif}
      playsInline
      preload="none"
    />
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  const shown = formatCount(value);
  return shown === undefined ? null : (
    <span className="stat" title={`${value} ${label}`}>
      {shown} <span className="stat-label">{label}</span>
    </span>
  );
}

export function TweetCard({ tweet, actions, nested = false }: { tweet: Tweet; actions: TweetActions; nested?: boolean }) {
  const { author } = tweet;
  const link = `https://x.com/${author.screenName}/status/${tweet.id}`;
  const open = () => openOnX(link);

  return (
    <article className={nested ? 'tweet tweet-nested' : 'tweet'}>
      {tweet.pinned && <p className="tweet-context">📌 Épinglé</p>}
      {tweet.isRetweet && <p className="tweet-context">🔁 Repost</p>}
      {tweet.isReply && (
        <p className="tweet-context">
          En réponse à {tweet.inReplyToScreenName ? `@${tweet.inReplyToScreenName}` : 'un autre post'}
        </p>
      )}
      <header className="tweet-header">
        <button type="button" className="author" onClick={() => actions.openProfile(author.screenName)}>
          {!nested && <Avatar url={author.avatarUrl} handle={author.screenName} />}
          <span className="author-name">{author.name ?? `@${author.screenName}`}</span>
          {author.verified && <span className="badge" title="Compte certifié">✓</span>}
          <span className="author-handle">@{author.screenName}</span>
        </button>
        <button type="button" className="tweet-time" title={formatFullDate(tweet.createdAt)} onClick={open}>
          {formatRelative(tweet.createdAt) ?? 'date inconnue'}
          {tweet.isEdited && ' · modifié'}
        </button>
      </header>

      {tweet.text === undefined ? <p className="tweet-text muted">Texte indisponible</p> : <p className="tweet-text">{tweet.text}</p>}

      {tweet.media.length > 0 && (
        <div className={`media-grid media-${Math.min(tweet.media.length, 4)}`}>
          {tweet.media.map((item) => (
            <Media key={item.thumbnailUrl} item={item} />
          ))}
        </div>
      )}

      {tweet.unparsedMediaCount !== undefined && (
        <p className="muted media-missing">
          {tweet.unparsedMediaCount === 1 ? '1 média non affiché' : `${tweet.unparsedMediaCount} médias non affichés`} :
          format inconnu ou hébergé hors de X. Ouvre le post dans Mon X pour le voir.
        </p>
      )}

      {tweet.isQuote &&
        (tweet.quotedTweet ? (
          <TweetCard tweet={tweet.quotedTweet} actions={actions} nested />
        ) : (
          <p className="tweet-nested muted">Le post cité n'est plus disponible.</p>
        ))}

      {!nested && (
        <footer className="tweet-stats">
          <Stat label="réponses" value={tweet.replyCount} />
          <Stat label="reposts" value={tweet.retweetCount} />
          <Stat label="j'aime" value={tweet.likeCount} />
          <Stat label="vues" value={tweet.viewCount} />
          <button type="button" className="link" onClick={open}>
            Ouvrir dans Mon X
          </button>
        </footer>
      )}
    </article>
  );
}
