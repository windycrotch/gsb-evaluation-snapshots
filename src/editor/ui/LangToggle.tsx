import { setLang, useLang } from '@/i18n';
import { Segmented } from './Segmented';

/** The EN / RU switch: in the top bar and in the welcome window, so the first screen can already be read in the right language. */
export function LangToggle() {
  const lang = useLang();
  return (
    <Segmented
      className="lang"
      label="Language"
      value={lang}
      onChange={setLang}
      options={(['en', 'ru'] as const).map((l) => ({ value: l, label: l.toUpperCase() }))}
    />
  );
}
