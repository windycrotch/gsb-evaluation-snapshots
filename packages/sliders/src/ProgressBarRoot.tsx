import { SliderRoot } from './SliderRoot';
import { useHover } from '@react-aria/interactions';
import { mergeProps } from '@react-aria/utils';
import React, { ComponentProps, ComponentPropsWithoutRef, createContext, forwardRef, MouseEvent, RefAttributes, RefObject, useContext, useEffect, useRef, useState } from 'react';
import { useMediaCurrentTimeFine, useMediaDuration, useMediaElement, useMediaSeekable } from '@react-av/core';

export interface ProgressBarTooltipContextState {
    percentage: number;
    root: RefObject<HTMLSpanElement | null>;
    show: boolean;
};

export const ProgressBarTooltipContext = createContext<ProgressBarTooltipContextState | undefined>(undefined);

export function useMediaProgressBarTooltip() {
    const context = useContext(ProgressBarTooltipContext);
    if (!context) throw new Error('useMediaProgressBarTooltip must be used within a ProgressBarTooltipContext');
    return context;
}

export type ProgressBarRootProps = Omit<ComponentProps<typeof SliderRoot>, "onValueChange" | "value" | "max" | "min"> & ComponentPropsWithoutRef<'span'>;

/**
 * How close the media's reported time needs to be to a committed seek before the
 * slider starts following the media clock again. Seeks can settle a frame or two
 * either side of the requested time.
 */
const SEEK_SETTLE_TOLERANCE = 0.15;

type ProgressBarInteraction<E> = {
    /** The media element this interaction belongs to. */
    element: E;
    /** The value the user is currently dragging to. */
    dragValue: number | null;
    /** The value the user committed, held until the media reports it. */
    pendingSeek: number | null;
};

function emptyInteraction<E>(element: E): ProgressBarInteraction<E> {
    return { element, dragValue: null, pendingSeek: null };
}

export const ProgressBarRoot: React.ForwardRefExoticComponent<ProgressBarRootProps & RefAttributes<HTMLSpanElement>> = forwardRef<HTMLSpanElement, ProgressBarRootProps>(function ProgressBarRoot({children, disabled, step = 0.001, keyboardStep = 1, ...props}, ref) {
    const [currentTime, setCurrentTime] = useMediaCurrentTimeFine();
    const element = useMediaElement();
    const duration = useMediaDuration();
    const seekable = useMediaSeekable();
    const internalRef = useRef<HTMLSpanElement>(null);
    const [state, setState] = useState<ProgressBarTooltipContextState>({
        percentage: 0,
        root: internalRef,
        show: false,
    });

    // Interaction state is tagged with the element it belongs to, so swapping the
    // media element (or its source) can never leave a stale drag or seek behind.
    const [tracked, setTracked] = useState<ProgressBarInteraction<HTMLMediaElement | null>>(() => emptyInteraction(element));
    const interaction = tracked.element === element ? tracked : emptyInteraction(element);
    if (tracked.element !== element) {
        // Reset during render so the very first paint with the new element never
        // shows the previous source's value or hovered percentage.
        setTracked(interaction);
        setState(current => current.percentage === 0 ? current : {
            ...current,
            percentage: 0,
        });
    }

    // Prefer the media duration, but fall back to the seekable window for live
    // media (where the duration is infinite) so the bar is still usable.
    const hasDuration = Number.isFinite(duration) && duration > 0;
    let min = 0;
    let max = 1;
    let hasRange = false;
    if (hasDuration) {
        min = 0;
        max = duration;
        hasRange = true;
    } else if (seekable && seekable.length > 0) {
        const start = seekable.start(0);
        const end = seekable.end(seekable.length - 1);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
            min = start;
            max = end;
            hasRange = true;
        }
    }

    function percentageOf(time: number) {
        if (!hasRange || max <= min) return 0;
        return Math.min(1, Math.max(0, (time - min) / (max - min)));
    }

    const {isHovered, hoverProps} = useHover({ isDisabled: disabled || !hasRange });

    useEffect(() => {
        setState(state => state.show === isHovered ? state : {
            ...state,
            show: isHovered,
        });
    }, [isHovered]);

    // A new source on the same element (or an unloaded element) discards the drag,
    // the pending seek and the hovered percentage.
    useEffect(() => {
        if (!element) return;
        function handleSourceChange() {
            setTracked(current => current.dragValue === null && current.pendingSeek === null ? current : {
                ...current,
                dragValue: null,
                pendingSeek: null,
            });
            setState(current => current.percentage === 0 ? current : {
                ...current,
                percentage: 0,
            });
        }
        element.addEventListener('emptied', handleSourceChange);
        element.addEventListener('loadstart', handleSourceChange);
        return () => {
            element.removeEventListener('emptied', handleSourceChange);
            element.removeEventListener('loadstart', handleSourceChange);
        };
    }, [element]);

    const pendingSeek = interaction.pendingSeek;
    const dragging = interaction.dragValue !== null;

    // If a pointer gesture ends without Radix committing (for example when the
    // thumb is released at the position it started from), fall back to the media
    // time instead of freezing the slider on the drag value.
    useEffect(() => {
        if (!dragging) return;
        function endDrag() {
            setTracked(current => current.dragValue === null ? current : {
                ...current,
                dragValue: null,
            });
        }
        window.addEventListener('pointerup', endDrag);
        window.addEventListener('pointercancel', endDrag);
        return () => {
            window.removeEventListener('pointerup', endDrag);
            window.removeEventListener('pointercancel', endDrag);
        };
    }, [dragging]);

    // Hand control back to the media clock once it has caught up with the
    // committed seek. Releasing is keyed on the sampled time (not just the
    // element) so the hand-off is seamless: the value on screen is already the
    // media's time when the pending value is dropped.
    const seekSettled = pendingSeek !== null && Math.abs(currentTime - pendingSeek) <= SEEK_SETTLE_TOLERANCE;

    useEffect(() => {
        if (pendingSeek === null) return;

        const media = element;

        function release() {
            setTracked(current => current.pendingSeek !== pendingSeek ? current : {
                ...current,
                pendingSeek: null,
            });
        }

        if (!media || seekSettled) {
            release();
            return;
        }
        const target = media;

        // A seek that the media refuses never completes: fall back to the media's
        // own time after a grace period instead of freezing the thumb.
        const watchdog = setTimeout(() => {
            if (!target.seeking && Math.abs(target.currentTime - pendingSeek) > SEEK_SETTLE_TOLERANCE)
                release();
        }, 1000);

        // A completed seek that landed somewhere else (the browser clamped it to
        // the seekable window) makes the media time authoritative. A seek that
        // landed on the target releases through `seekSettled` instead, so the
        // hand-off happens on the same frame the sampled time updates.
        function handleSeeked() {
            if (Math.abs(target.currentTime - pendingSeek!) > SEEK_SETTLE_TOLERANCE)
                release();
        }

        target.addEventListener('seeked', handleSeeked);
        target.addEventListener('emptied', release);
        target.addEventListener('error', release);
        return () => {
            clearTimeout(watchdog);
            target.removeEventListener('seeked', handleSeeked);
            target.removeEventListener('emptied', release);
            target.removeEventListener('error', release);
        };
    }, [pendingSeek, seekSettled, element]);

    // TODO: vertical
    function handleMouseMove(e: MouseEvent<HTMLDivElement>) {
        const cursor = e.clientX;
        const rect = internalRef.current?.getBoundingClientRect();
        if (!rect) return;
        if (cursor < rect.left || cursor > rect.right) return;
        const percentage = (cursor - rect.left) / rect.width;
        setState(state => state.percentage === percentage ? state : {
            ...state,
            percentage
        });
    }

    const mediaValue = interaction.dragValue ?? pendingSeek ?? currentTime;
    const value = hasRange ? Math.min(max, Math.max(min, mediaValue)) : 0;

    return <ProgressBarTooltipContext.Provider value={state}>
        <SliderRoot
            ref={current => {
                if (typeof ref === "function") ref(current);
                // @ts-ignore
                else if (ref) ref.current = current;
                // @ts-ignore
                internalRef.current = current;
            }}
            keyboardStep={keyboardStep} {...mergeProps(props, hoverProps)}
            onMouseMove={handleMouseMove}
            onValueChange={value => {
                const time = value[0];
                if (time === undefined || !hasRange) return;
                // While the pointer is down the drag value wins over media events;
                // seeking on every move would make the media chase the thumb and
                // fight the gesture.
                setTracked(current => current.dragValue === time ? current : {
                    ...current,
                    element,
                    dragValue: time,
                });
                setState(state => state.percentage === percentageOf(time) ? state : {
                    ...state,
                    percentage: percentageOf(time),
                });
            }}
            onValueCommit={value => {
                const time = value[0];
                setTracked(current => current.dragValue === null && current.pendingSeek === time ? current : {
                    ...current,
                    element,
                    dragValue: null,
                    pendingSeek: time ?? null,
                });
                if (time === undefined || !hasRange) return;
                // Seek once on release, then let the media report the real time.
                setCurrentTime(time);
                setState(state => state.percentage === percentageOf(time) ? state : {
                    ...state,
                    percentage: percentageOf(time),
                });
            }}
            disabled={disabled || !hasRange}
            value={[value]}
            min={min} max={max} step={step}
        >
            {children}
        </SliderRoot>
    </ProgressBarTooltipContext.Provider>;
});
