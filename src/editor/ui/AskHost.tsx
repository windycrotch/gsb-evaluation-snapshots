/** Where the question of store/ask is shown: a small dialog with one text field. Renders nothing while nothing is asked. */
import { useEffect, useRef, useState } from 'react';
import { useAsk } from '@/store/ask';
import type { Ask } from '@/store/ask';
import { Button, Dialog } from './controls';

export function AskHost() {
  const ask = useAsk();
  return ask ? <AskDialog ask={ask} /> : null;
}

function AskDialog({ ask }: { ask: Ask }) {
  const [text, setText] = useState(ask.initial);
  const field = useRef<HTMLInputElement>(null);
  // the dialog takes the focus when it opens, so the field takes it after that
  useEffect(() => {
    const timer = setTimeout(() => field.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Dialog
      title={ask.title}
      width={340}
      onClose={() => ask.resolve(null)}
      footer={
        <>
          <Button ghost onClick={() => ask.resolve(null)}>
            Cancel
          </Button>
          <Button primary disabled={!text.trim()} onClick={() => ask.resolve(text)}>
            {ask.ok}
          </Button>
        </>
      }
    >
      <p className="hint-text flush">{ask.label}</p>
      <div className="field wide">
        <input
          ref={field}
          type="text"
          spellCheck={false}
          value={text}
          aria-label={ask.label}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) ask.resolve(text);
            e.stopPropagation();
          }}
        />
      </div>
    </Dialog>
  );
}
