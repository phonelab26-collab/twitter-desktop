import { useMemo, useState } from 'react';
import type { TrendLocation } from '@shared/types';
import { useRemote, xapi } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { Feed } from '../components/Feed';
import { Loading } from '../components/Loading';
import type { TweetActions } from '../components/TweetCard';
import { formatFullDate } from '../format';

const WORLDWIDE = 1;

/** Worldwide first, then countries, then towns, each alphabetically. */
function sortPlaces(places: TrendLocation[]): TrendLocation[] {
  const rank = (place: TrendLocation) => (place.kind === 'Supername' ? 0 : place.kind === 'Country' ? 1 : 2);
  return [...places].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'fr'));
}

function placeLabel(place: TrendLocation): string {
  return place.kind === 'Town' && place.country ? `${place.name} (${place.country})` : place.name;
}

export function TrendsView({ actions, openTopic }: { actions: TweetActions; openTopic(name: string): void }) {
  const [woeid, setWoeid] = useState(WORLDWIDE);
  const [tab, setTab] = useState<'names' | 'posts'>('names');
  const places = useRemote('places', () => xapi().getTrendLocations());
  const trends = useRemote(`trends:${woeid}`, () => xapi().getTrends(woeid));
  const posts = useRemote(tab === 'posts' ? 'posts' : null, () => xapi().getTrendingPosts());
  const placeList = places.status === 'ok' ? places.data : undefined;
  const sorted = useMemo(() => (placeList ? sortPlaces(placeList) : []), [placeList]);

  return (
    <section>
      <header className="view-header">
        <h1>Tendances</h1>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'names'} onClick={() => setTab('names')}>
            Sujets
          </button>
          <button type="button" role="tab" aria-selected={tab === 'posts'} onClick={() => setTab('posts')}>
            Posts populaires du jour
          </button>
        </div>
      </header>

      {tab === 'names' && (
        <>
          <div className="toolbar">
            <label>
              Lieu{' '}
              <select value={woeid} onChange={(event) => setWoeid(Number(event.target.value))} disabled={places.status !== 'ok'}>
                {places.status !== 'ok' && <option value={WORLDWIDE}>Monde</option>}
                {sorted.map((place) => (
                  <option key={place.woeid} value={place.woeid}>
                    {placeLabel(place)}
                  </option>
                ))}
              </select>
            </label>
            {trends.status === 'ok' && <span className="muted">Mis à jour par X : {formatFullDate(trends.data.asOf) ?? trends.data.asOf}</span>}
          </div>
          {places.status === 'error' && <ErrorBox error={places.error} onRetry={places.reload} />}
          {trends.status === 'loading' && <Loading />}
          {trends.status === 'error' && <ErrorBox error={trends.error} onRetry={trends.reload} />}
          {trends.status === 'ok' &&
            (trends.data.trends.length === 0 ? (
              <p className="notice">X ne signale aucune tendance pour ce lieu.</p>
            ) : (
              <ol className="trend-list">
                {trends.data.trends.map((trend, index) => (
                  <li key={`${index}:${trend.name}`}>
                    <button type="button" className="trend" onClick={() => openTopic(trend.name)}>
                      <span className="trend-rank">{index + 1}</span>
                      <span className="trend-name">{trend.name}</span>
                      {trend.promoted && <span className="muted"> · sponsorisé</span>}
                      {trend.postCount !== undefined && <span className="muted"> · {trend.postCount} posts</span>}
                    </button>
                  </li>
                ))}
              </ol>
            ))}
        </>
      )}

      {tab === 'posts' && (
        <Feed
          remote={posts}
          actions={actions}
          empty="X ne renvoie aucun post populaire en ce moment."
          end="Sans compte, X n'affiche pas plus de posts populaires."
        />
      )}
    </section>
  );
}
