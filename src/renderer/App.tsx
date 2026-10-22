import { useEffect, useMemo, useState } from 'react';
import type { AppView } from '@shared/ipc';
import { OPEN_X_EVENT, xapi } from './api';
import type { TweetActions } from './components/TweetCard';
import { AgentView } from './views/AgentView';
import { ProfileView } from './views/ProfileView';
import { TopicView } from './views/TopicView';
import { TrendsView } from './views/TrendsView';
import { XAccountView } from './views/XAccountView';

type View =
  | { name: 'x'; url: string | null }
  | { name: 'trends' }
  | { name: 'profile'; screenName: string | null }
  | { name: 'topic'; topic: string | null }
  | { name: 'agent' };

const NAV: Array<{ name: View['name']; label: string; icon: string }> = [
  { name: 'x', label: 'Mon X', icon: '𝕏' },
  { name: 'trends', label: 'Tendances', icon: '🔥' },
  { name: 'profile', label: 'Profil', icon: '👤' },
  { name: 'topic', label: 'Sujet', icon: '#' },
  { name: 'agent', label: 'Agent', icon: '🤖' },
];

/** A tab opened from the sidebar or the menu, with nothing preselected. */
function blankView(name: AppView): View {
  if (name === 'x') return { name, url: null };
  if (name === 'profile') return { name, screenName: null };
  if (name === 'topic') return { name, topic: null };
  return { name };
}

export function App() {
  const [view, setView] = useState<View>({ name: 'x', url: null });
  const actions: TweetActions = useMemo(
    () => ({ openProfile: (screenName) => setView({ name: 'profile', screenName }) }),
    [],
  );
  const openTopic = (topic: string) => setView({ name: 'topic', topic });

  useEffect(() => xapi().onNavigate((name) => setView(blankView(name))), []);

  useEffect(() => {
    const onOpenX = (event: Event) => setView({ name: 'x', url: (event as CustomEvent<string>).detail });
    window.addEventListener(OPEN_X_EVENT, onOpenX);
    return () => window.removeEventListener(OPEN_X_EVENT, onOpenX);
  }, []);

  const select = (name: View['name']) => {
    if (name !== view.name) setView(blankView(name));
  };

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Navigation">
        <p className="logo">𝕏 Desktop</p>
        {NAV.map((item) => (
          <button
            key={item.name}
            type="button"
            className="nav-item"
            aria-current={view.name === item.name ? 'page' : undefined}
            onClick={() => select(item.name)}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
        <p className="sidebar-note">Tendances, Profil et Sujet fonctionnent sans compte.</p>
      </nav>
      <main className={view.name === 'x' ? 'content content-wide' : 'content'}>
        {view.name === 'x' && <XAccountView url={view.url} />}
        {view.name === 'trends' && <TrendsView actions={actions} openTopic={openTopic} />}
        {view.name === 'profile' && <ProfileView key={view.screenName ?? ''} screenName={view.screenName} actions={actions} />}
        {view.name === 'topic' && <TopicView key={view.topic ?? ''} topic={view.topic} actions={actions} openTopic={openTopic} />}
        {view.name === 'agent' && <AgentView />}
      </main>
    </div>
  );
}
