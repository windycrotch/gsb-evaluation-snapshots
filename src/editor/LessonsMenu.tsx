import { Check, GraduationCap } from 'lucide-react';
import { LESSONS } from '@/core/lessons';
import { useLang } from '@/i18n';
import { openLesson, useLearn } from '@/store/learn';
import { Menu, MenuItem } from './ui/controls';

/**
 * The lessons in the top bar, where a newcomer looks first: a menu with one line for every lesson (a tick on the ones that were taken
 * to the end). Until the first lesson is finished a dot on the button says "start here". The words go in a narrow window: the icon stays.
 */
export function LessonsMenu() {
  const lang = useLang();
  const finished = useLearn((s) => s.finished);
  return (
    <span className="badge-wrap">
      <Menu icon={GraduationCap} title="Learn: lessons" label={<span className="tb-label">Learn</span>}>
        {(close) => (
          <>
            {LESSONS.map((lesson, i) => (
              <MenuItem
                key={lesson.id}
                icon={finished.includes(lesson.id) ? Check : GraduationCap}
                close={close}
                onClick={() => void openLesson(lesson.id)}
              >
                {`${i + 1}. ${lesson.title[lang]}`}
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
      {finished.length === 0 && <span className="notify-dot lessons-dot" role="status" aria-label="Start here" />}
    </span>
  );
}
