import { useEffect } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { lessonById, LESSONS } from '@/core/lessons';
import type { LearnTarget } from '@/core/lessons';
import { useLang } from '@/i18n';
import { newProject } from '@/store/project';
import { openLesson, runLessonHelper, setLearnCollapsed, skipStep, stopLesson, useLearn } from '@/store/learn';
import { Button, IconButton } from './ui/controls';

/** Where each target is on the page. Names and classes of the layout, never text: the text changes with the language. */
const TARGETS: Record<LearnTarget, string> = {
  tree: '[data-learn="tree"]',
  viewport: '.viewport-wrap',
  inspector: 'aside.right',
  mode: '[data-learn="mode"]',
  play: '[data-learn="play"]',
  export: '[data-learn="export"]',
  images: '[data-learn="images"]',
  toolIk: '[data-learn="tool-ik"]',
  timeline: '[data-learn="timeline"]',
  graph: '[data-learn="graph"]',
};

/**
 * The card of the running lesson, in a corner of the viewport: the steps as dots, the step in front with its text, and a soft frame
 * around the part of the editor it points at. It takes no focus, blocks nothing, and can be skipped, folded or closed at any time.
 */
export function LearnCard() {
  const lang = useLang();
  const active = useLearn((s) => s.active);
  const progress = useLearn((s) => s.progress);
  const collapsed = useLearn((s) => s.collapsed);
  const lesson = active ? lessonById(active) : undefined;
  const current = progress?.current ?? -1;
  const target = lesson && current >= 0 ? lesson.steps[current].target : null;

  // the frame: put on the target of the step in front, taken off when the step, the card or the lesson goes
  useEffect(() => {
    if (!target || collapsed) return;
    const el = document.querySelector(TARGETS[target]);
    el?.setAttribute('data-learn-hl', '');
    return () => el?.removeAttribute('data-learn-hl');
  }, [target, collapsed]);

  if (!lesson || !progress) return null;
  const step = current >= 0 ? lesson.steps[current] : null;
  const next = lesson.next ? LESSONS.find((l) => l.id === lesson.next) : undefined;
  const total = lesson.steps.length;
  return (
    <section className="learn" aria-label="Lesson">
      <div className="learn-head">
        <span className="learn-title">{lesson.title[lang]}</span>
        <span className="learn-count">
          {progress.doneCount}/{total}
        </span>
        <IconButton
          icon={collapsed ? ChevronUp : ChevronDown}
          title={collapsed ? 'Unfold the lesson' : 'Fold the lesson'}
          small
          onClick={() => setLearnCollapsed(!collapsed)}
        />
        <IconButton icon={X} title="Close the lesson" small onClick={() => stopLesson()} />
      </div>
      {!collapsed && (
        <>
          <div className="learn-dots" aria-hidden="true">
            {progress.marks.map((m, i) => (
              <span key={lesson.steps[i].id} className={`learn-dot ${m}${i === current ? ' current' : ''}`} />
            ))}
          </div>
          <div aria-live="polite" className="learn-body">
            {step ? (
              <>
                <div className="learn-step-title">{step.title[lang]}</div>
                <p className="learn-text">{step.text[lang]}</p>
              </>
            ) : (
              <p className="learn-text">{lesson.outro[lang]}</p>
            )}
          </div>
          <div className="learn-actions">
            {step ? (
              <>
                {step.helper && (
                  <Button small onClick={() => void runLessonHelper(step.helper!.id)}>
                    {step.helper.label[lang]}
                  </Button>
                )}
                <Button ghost small onClick={() => skipStep()}>
                  Skip this step
                </Button>
              </>
            ) : (
              <>
                {next ? (
                  <Button small onClick={() => void openLesson(next.id)}>
                    {next.title[lang]}
                  </Button>
                ) : (
                  <Button
                    small
                    onClick={() => {
                      stopLesson();
                      newProject();
                    }}
                  >
                    New project
                  </Button>
                )}
                <Button primary small onClick={() => stopLesson()}>
                  Done
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
