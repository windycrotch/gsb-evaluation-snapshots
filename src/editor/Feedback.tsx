import { useState } from 'react';
import { Copy, Send } from 'lucide-react';
import { getLang } from '@/i18n';
import { toast, uiStore } from '@/store/ui';
import { Button, Dialog, SelectField, Toggle } from './ui/controls';
import { LATEST, REPO, SITE } from './changelog';

type Kind = 'bug' | 'idea' | 'question';

const KIND_LABEL: Record<Kind, string> = { bug: 'Bug', idea: 'Idea / missing feature', question: 'Question' };

/**
 * Where the message goes. With `VITE_FEEDBACK_ENDPOINT` set at build time (a form service that accepts a JSON POST, e.g. a Formspree form) the message is sent
 * from the page straight to its owner. Without it the window opens a new GitHub issue with the text already filled in: nothing is sent until the user
 * presses the green button there.
 */
const ENDPOINT = (import.meta.env.VITE_FEEDBACK_ENDPOINT as string | undefined) || '';

function environment(): string {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return [
    `Bone 2D v${LATEST}`,
    SITE,
    `language: ${getLang()}`,
    nav ? `browser: ${nav.userAgent}` : '',
    typeof screen !== 'undefined' ? `screen: ${screen.width}×${screen.height}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function issueUrl(kind: Kind, message: string, info: string | null): string {
  const first = message.trim().split('\n')[0].slice(0, 80);
  const title = `[${kind}] ${first}`;
  let body = message.trim();
  if (info) body += `\n\n---\n${info}`;
  const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return url.length > 7500
    ? `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(`${body.slice(0, 3000)}\n…`)}`
    : url;
}

export function FeedbackDialog() {
  const [kind, setKind] = useState<Kind>('idea');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [withInfo, setWithInfo] = useState(true);
  const [busy, setBusy] = useState(false);
  const close = () => uiStore.patch({ feedbackOpen: false });
  const ready = message.trim().length >= 5;

  const send = async () => {
    if (!ready || busy) return;
    const info = withInfo ? environment() : null;
    if (!ENDPOINT) {
      window.open(issueUrl(kind, message, info), '_blank', 'noopener');
      toast('A new GitHub issue is open in another tab: press its green button to send it', 'ok');
      close();
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ kind, message: message.trim(), contact: contact.trim() || undefined, info: info ?? undefined }),
      });
      if (!r.ok) throw new Error(String(r.status));
      toast('Thank you! The message is sent', 'ok');
      close();
    } catch {
      toast('Could not send it from here: opening GitHub instead', 'error');
      window.open(issueUrl(kind, message, info), '_blank', 'noopener');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(withInfo ? `${message.trim()}\n\n---\n${environment()}` : message.trim());
      toast('Copied', 'ok');
    } catch {
      toast('Could not copy', 'error');
    }
  };

  return (
    <Dialog
      title="Feedback"
      width={560}
      onClose={close}
      footer={
        <>
          <Button ghost icon={Copy} disabled={!ready} onClick={copy}>
            Copy
          </Button>
          <Button primary icon={Send} disabled={!ready || busy} onClick={send}>
            Send
          </Button>
        </>
      }
    >
      <p className="hint-text flush mb">
        Something broken, missing or confusing? Write it here: every message is read. A feature of Spine that you miss is the most useful
        thing you can send.
      </p>
      <div className="feedback">
        <SelectField
          label="Kind"
          value={kind}
          wide
          options={(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          onChange={setKind}
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={7}
          maxLength={4000}
          autoFocus
          spellCheck
          placeholder="What happened, or what would you like to see? The more concrete, the better (steps, what you expected)."
          aria-label="Message"
        />
        {ENDPOINT && (
          <label className="fb-contact">
            <span>Reply to (optional)</span>
            <input type="text" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="e-mail or @telegram" />
          </label>
        )}
        <div className="fb-info">
          <Toggle on={withInfo} onChange={setWithInfo} title="Add the app version and browser" />
          <span>Add the app version and browser</span>
        </div>
        <p className="hint-text flush">
          {ENDPOINT
            ? 'The message goes straight to the author. Your project is never attached.'
            : 'The message opens as a new issue on GitHub (a free GitHub account is needed to post it). Your project is never attached.'}
        </p>
      </div>
    </Dialog>
  );
}
