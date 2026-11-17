<script setup lang="ts">
import type { Chapter, ThumbnailCue, ThumbnailState } from '@vue-player/core'
import { findThumbnailCue, formatTime } from '@vue-player/core'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import IcoAlert from '../icons/IcoAlert.vue'

const props = defineProps<{
  currentTime: number
  duration: number
  buffered: number
  chapters?: Chapter[]
  thumbnailState?: ThumbnailState
}>()

const emit = defineEmits<{
  seek: [time: number]
  seekstart: []
  seekend: []
}>()

const trackRef = ref<HTMLElement | null>(null)
const isSeeking = ref(false)
const seekRatio = ref(0)
const hoverRatio = ref<number | null>(null)

const pendingSeekTime = ref<number | null>(null)

// Absent prop behaves like "no thumbnails configured".
const thumbState = computed<ThumbnailState>(
  () => props.thumbnailState ?? { status: 'none', cues: [] },
)

watch(
  () => props.currentTime,
  (t) => {
    if (pendingSeekTime.value !== null && Math.abs(t - pendingSeekTime.value) < 1) {
      pendingSeekTime.value = null
    }
  },
)

const displayTime = computed(() => {
  if (isSeeking.value) return seekRatio.value * props.duration
  if (pendingSeekTime.value !== null) return pendingSeekTime.value
  return props.currentTime
})

const progressRatio = computed(() => (props.duration > 0 ? displayTime.value / props.duration : 0))
const bufferedRatio = computed(() => (props.duration > 0 ? props.buffered / props.duration : 0))

interface Segment {
  start: number
  end: number
  label?: string
}

const segments = computed<Segment[]>(() => {
  const dur = props.duration
  if (!dur || !props.chapters?.length) return [{ start: 0, end: 1 }]
  const sorted = [...props.chapters].sort((a, b) => a.time - b.time)
  return sorted.map((ch, i) => ({
    start: ch.time / dur,
    end: (sorted[i + 1]?.time ?? dur) / dur,
    label: ch.label,
  }))
})

function ratioFromEvent(e: { clientX: number }): number {
  const el = trackRef.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
}

function stopSeeking(emitEvent = false) {
  if (!isSeeking.value) return
  isSeeking.value = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  if (emitEvent) emit('seekend')
}

function onPointerCancel() {
  stopSeeking(true)
}

function onPointerDown(e: PointerEvent) {
  if (!props.duration) return
  isSeeking.value = true
  seekRatio.value = ratioFromEvent(e)
  emit('seekstart')
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
}

function onPointerMove(e: PointerEvent) {
  seekRatio.value = ratioFromEvent(e)
}

function onPointerUp(e: PointerEvent) {
  const ratio = ratioFromEvent(e)
  const time = ratio * props.duration
  pendingSeekTime.value = time
  emit('seek', time)
  stopSeeking()
  emit('seekend')
}

function onMouseMove(e: MouseEvent) {
  if (!isSeeking.value) hoverRatio.value = ratioFromEvent(e)
}

function onMouseLeave() {
  hoverRatio.value = null
}

let unmounted = false
onBeforeUnmount(() => {
  unmounted = true
  stopSeeking()
})

function segmentFill(seg: Segment): number {
  const p = progressRatio.value
  if (p <= seg.start) return 0
  if (p >= seg.end) return 100
  return ((p - seg.start) / (seg.end - seg.start)) * 100
}

function segmentBuffered(seg: Segment): number {
  const b = bufferedRatio.value
  if (b <= seg.start) return 0
  if (b >= seg.end) return 100
  return ((b - seg.start) / (seg.end - seg.start)) * 100
}

// ─── Hovered segment ───
const hoverSegmentIndex = computed(() => {
  const r = hoverRatio.value
  if (r === null) return -1
  return segments.value.findIndex((s) => r >= s.start && r < s.end)
})

// ─── Tooltip ───
const tooltipRatio = computed(() => {
  if (isSeeking.value) return seekRatio.value
  return hoverRatio.value
})

const tooltipTime = computed(() =>
  tooltipRatio.value !== null ? tooltipRatio.value * props.duration : 0,
)

const tooltipChapter = computed(() => {
  const r = tooltipRatio.value
  if (!props.chapters?.length || r === null) return null
  return segments.value.find((s) => r >= s.start && r < s.end)?.label ?? null
})

const showTooltip = computed(() => tooltipRatio.value !== null && props.duration > 0)

// ─── Thumbnails ───

type ImageLoadState = 'loading' | 'loaded' | 'error'

// Per-URL load state so cross-origin blocked / unreachable sprite images
// surface an explicit failure instead of a blank box.
const imageStatus = reactive(new Map<string, ImageLoadState>())

function trackImage(url: string) {
  if (!url || imageStatus.has(url)) return
  imageStatus.set(url, 'loading')
  const img = new Image()
  img.onload = () => {
    if (unmounted) return
    imageStatus.set(url, 'loaded')
  }
  img.onerror = () => {
    if (unmounted) return
    imageStatus.set(url, 'error')
  }
  img.src = url
}

// Active thumbnail for the hovered/seeking position. The lookup time is
// clamped to [0, duration] so a mismatched VTT span can never select an
// out-of-range cue; [start, end) semantics make an exact end-time hit land
// on the next cue, and times past the final cue return the final cue.
const activeThumbnail = computed<ThumbnailCue | null>(() => {
  const { cues, status } = thumbState.value
  if (status !== 'ready' || !cues.length) return null
  const ratio = tooltipRatio.value
  if (ratio === null || props.duration <= 0) return null
  const time = Math.max(0, Math.min(ratio * props.duration, props.duration))
  return findThumbnailCue(cues, time)
})

watch(
  () => activeThumbnail.value?.url,
  (url) => {
    if (url) trackImage(url)
  },
  { immediate: true },
)

function hasValidCoords(cue: ThumbnailCue): boolean {
  return (
    cue.x !== undefined &&
    cue.y !== undefined &&
    cue.w !== undefined &&
    cue.h !== undefined &&
    Number.isFinite(cue.x) &&
    Number.isFinite(cue.y) &&
    Number.isFinite(cue.w) &&
    Number.isFinite(cue.h) &&
    cue.w > 0 &&
    cue.h > 0
  )
}

const isSpriteCue = computed(() =>
  activeThumbnail.value ? hasValidCoords(activeThumbnail.value) : false,
)

// Style for sprite-sheet thumbnails (xywh fragment). Cues without a valid
// fragment render as a plain whole-image <img> instead.
const thumbnailSpriteStyle = computed(() => {
  const c = activeThumbnail.value
  if (!c || !hasValidCoords(c)) return null
  return {
    backgroundImage: `url(${c.url})`,
    backgroundPosition: `-${c.x}px -${c.y}px`,
    width: `${c.w}px`,
    height: `${c.h}px`,
  }
})

type ThumbnailView =
  | { kind: 'hidden' }
  | { kind: 'image-error'; cue: ThumbnailCue }
  | { kind: 'loading'; cue: ThumbnailCue }
  | { kind: 'image'; cue: ThumbnailCue }

const thumbnailView = computed<ThumbnailView>(() => {
  const { status } = thumbState.value

  // VTT fetch failed / empty body / every cue invalid / still loading:
  // hide the preview area entirely. The time + chapter tooltip stays
  // visible, and playback/seeking are unaffected.
  if (status !== 'ready') return { kind: 'hidden' }

  const cue = activeThumbnail.value
  if (!cue) return { kind: 'hidden' }

  switch (imageStatus.get(cue.url)) {
    case 'error':
      // The VTT parsed, but the sprite/image request itself was blocked
      // (e.g. cross-origin) or is unreachable — say so instead of blanking.
      return { kind: 'image-error', cue }
    case 'loaded':
      return { kind: 'image', cue }
    default:
      return { kind: 'loading', cue }
  }
})

const previewVisible = computed(() => thumbnailView.value.kind !== 'hidden')

// Clamp so the tooltip doesn't bleed off the track edges.
// With thumbnails visible the tooltip is ~160px wide (half ≈ 88px).
const tooltipStyle = computed(() => {
  const pct = (tooltipRatio.value ?? 0) * 100
  const half = previewVisible.value ? '88px' : '46px'
  return { left: `clamp(${half}, ${pct}%, calc(100% - ${half}))` }
})
</script>

<template>
  <div
    ref="trackRef"
    class="vp-timeline"
    :class="{ 'vp-timeline--seeking': isSeeking }"
    @pointerdown="onPointerDown"
  >
    <div class="vp-timeline-track" @mousemove="onMouseMove" @mouseleave="onMouseLeave">
      <div
        v-for="(seg, i) in segments"
        :key="i"
        class="vp-timeline-segment"
        :class="{ 'vp-timeline-segment--active': i === hoverSegmentIndex }"
        :style="{ flex: seg.end - seg.start }"
      >
        <div class="vp-timeline-buffered" :style="{ width: `${segmentBuffered(seg)}%` }" />
        <div class="vp-timeline-fill" :style="{ width: `${segmentFill(seg)}%` }" />
      </div>
    </div>

    <div v-if="duration > 0" class="vp-timeline-thumb" :style="{ '--progress': progressRatio }" />

    <div v-if="showTooltip" class="vp-timeline-tooltip" :style="tooltipStyle">
      <div
        v-if="previewVisible"
        class="vp-thumbnail-preview"
        :class="{ 'vp-thumbnail-preview--error': thumbnailView.kind === 'image-error' }"
      >
        <template v-if="activeThumbnail">
          <!-- Sprite/image request blocked (e.g. CORS) or unreachable -->
          <div v-if="thumbnailView.kind === 'image-error'" class="vp-thumbnail-failure">
            <IcoAlert class="vp-thumbnail-failure-icon" />
            <span class="vp-thumbnail-failure-text">缩略图不可用</span>
          </div>

          <div v-else-if="thumbnailView.kind === 'loading'" class="vp-thumbnail-loading" />

          <template v-else>
            <div v-if="isSpriteCue" class="vp-thumbnail-sprite" :style="thumbnailSpriteStyle" />
            <!-- Missing/invalid xywh fragment: fall back to the whole image -->
            <img
              v-else
              class="vp-thumbnail-img"
              :src="activeThumbnail.url"
              alt=""
              draggable="false"
            />
          </template>
        </template>
      </div>
      <span v-if="tooltipChapter" class="vp-tooltip-chapter">{{ tooltipChapter }}</span>
      {{ formatTime(tooltipTime) }}
    </div>
  </div>
</template>
