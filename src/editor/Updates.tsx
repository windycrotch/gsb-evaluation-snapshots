import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useLang } from '@/i18n';
import { uiStore } from '@/store/ui';
import { Button, Dialog } from './ui/controls';
import { Segmented } from './ui/Segmented';
import { CHANGELOG, LATEST, REPO } from './changelog';

const SEEN_KEY = 'bone2d.seenUpdate';

/** Whether the newest entry of the list has not been opened yet (the dot on the top bar button). */
export function hasUnseenUpdate(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== LATEST;
  } catch {
    return false;
  }
}

function markUpdatesSeen() {
  try {
    localStorage.setItem(SEEN_KEY, LATEST);
  } catch {
    /* not persisted */
  }
}

interface Commit {
  sha: string;
  message: string;
  date: string;
  url: string;
}

type Activity = { state: 'loading' } | { state: 'error' } | { state: 'ok'; commits: Commit[] };

/** The latest commits of the repository, read from the public GitHub API (nothing about the user or the project is sent). */
function useActivity(enabled: boolean): Activity {
  const [activity, setActivity] = useState<Activity>({ state: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    setActivity({ state: 'loading' });
    fetch(`https://api.github.com/repos/${REPO}/commits?per_page=25`, {
      signal: ctl.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((rows: { sha: string; html_url: string; commit: { message: string; author?: { date?: string } } }[]) => {
        setActivity({
          state: 'ok',
          commits: rows.map((r) => ({
            sha: r.sha.slice(0, 7),
            url: r.html_url,
            message: r.commit.message.split('\n')[0],
            date: (r.commit.author?.date ?? '').slice(0, 10),
          })),
        });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setActivity({ state: 'error' });
      });
    return () => ctl.abort();
  }, [enabled]);
  return activity;
}

export function UpdatesDialog() {
  const lang = useLang();
  const [tab, setTab] = useState<'news' | 'activity'>('news');
  const activity = useActivity(tab === 'activity');
  useEffect(markUpdatesSeen, []);

  return (
    <Dialog
      title="Updates"
      width={640}
      onClose={() => uiStore.patch({ updatesOpen: false })}
      footer={
        <>
          <a className="btn ghost" href={`https://github.com/${REPO}/commits/main`} target="_blank" rel="noreferrer">
            <ExternalLink size={15} strokeWidth={1.9} />
            All commits on GitHub
          </a>
          <Button primary onClick={() => uiStore.patch({ updatesOpen: false })}>
            Close
          </Button>
        </>
      }
    >
      <Segmented
        label="Updates"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'news', label: "What's new", tone: 'plain' },
          { value: 'activity', label: 'Activity', tone: 'plain', title: 'The latest commits of the project, live from GitHub' },
        ]}
      />
      {tab === 'news' ? (
        <div className="updates">
          {CHANGELOG.map((r) => (
            <section key={r.version} className="release">
              <h3>
                <span className="chip plain">v{r.version}</span>
                <span className="muted">{r.date}</span>
              </h3>
              <ul>
                {r[lang].map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="updates">
          {activity.state === 'loading' && <p className="hint-text">Loading…</p>}
          {activity.state === 'error' && (
            <p className="hint-text">
              The activity feed could not be loaded (offline, or the GitHub limit for anonymous requests). Open the commits on GitHub with
              the button below.
            </p>
          )}
          {activity.state === 'ok' && (
            <ul className="commits">
              {activity.commits.map((c) => (
                <li key={c.sha}>
                  <span className="muted">{c.date}</span>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.message}
                  </a>
                  <code>{c.sha}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
