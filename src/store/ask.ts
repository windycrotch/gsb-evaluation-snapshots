/** A small question the editor asks the person: a name for something being saved. One at a time; the answer is a promise. */
import { createStore, useStore } from './store';

export interface Ask {
  title: string;
  /** What is asked, one line under the title. */
  label: string;
  initial: string;
  ok: string;
  resolve: (value: string | null) => void;
}

const askStore = createStore<{ ask: Ask | null }>({ ask: null });
export const useAsk = (): Ask | null => useStore(askStore, (s) => s.ask);

/** Asks for a text (a name). Resolves with the trimmed text, or null when the person cancels or leaves it empty. A new question cancels the open one. */
export function askName(title: string, label: string, initial = '', ok = 'Save'): Promise<string | null> {
  askStore.get().ask?.resolve(null);
  return new Promise((resolve) => {
    askStore.set({
      ask: {
        title,
        label,
        initial,
        ok,
        resolve: (value) => {
          askStore.set({ ask: null });
          const text = value?.trim() ?? '';
          resolve(text ? text : null);
        },
      },
    });
  });
}
