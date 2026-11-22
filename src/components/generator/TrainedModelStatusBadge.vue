<template>
  <div
    class="flex shrink-0 items-center gap-1.5"
    role="status"
    :aria-live="isFallback ? 'assertive' : 'polite'"
    :title="tooltip"
  >
    <!-- Healthy trained model -->
    <span v-if="status === 'available'" class="flex items-center gap-1.5" :class="compact ? 'text-micro' : 'text-2xs'">
      <span class="bg-daw-pulse h-1.5 w-1.5 shrink-0 rounded-full" aria-hidden="true" />
      <span class="text-daw-text-muted hidden font-medium xl:inline">{{ label }} model</span>
    </span>

    <!-- First load still in flight -->
    <span
      v-else-if="status === 'loading'"
      class="flex items-center gap-1.5"
      :class="compact ? 'text-micro' : 'text-2xs'"
    >
      <Loader2 class="text-daw-text-muted h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
      <span class="text-daw-text-muted hidden font-medium xl:inline">Loading {{ label.toLowerCase() }} model…</span>
    </span>

    <!-- Trained model unavailable: synthetic scale table is driving generation -->
    <span
      v-else-if="isFallback"
      class="border-daw-warning/40 bg-daw-warning/10 text-daw-warning rounded-chip flex items-center gap-1.5 border px-1.5 py-0.5"
      :class="compact ? 'text-micro' : 'text-2xs'"
      data-test="trained-model-fallback"
    >
      <CircleAlert class="h-3 w-3 shrink-0" aria-hidden="true" />
      <span class="font-medium">{{ label }}: scale table</span>
      <button
        type="button"
        class="hover:bg-daw-warning/20 rounded-chip -my-0.5 -mr-0.5 flex items-center gap-0.5 py-0.5 pr-1 pl-1 font-medium transition-colors"
        :aria-label="`Retry loading the ${label.toLowerCase()} trained model`"
        :title="`Retry loading the ${label.toLowerCase()} trained model`"
        @click.stop="onRetry"
      >
        <RotateCw class="h-3 w-3" aria-hidden="true" />
        <span class="hidden lg:inline">Retry</span>
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { CircleAlert, Loader2, RotateCw } from '@lucide/vue'
  import type { TrainedRole } from '@/core/schemas/trained-markov.schema'
  import { TRAINED_ROLE_LABELS } from '@/services/trained-model-service'

  /** Union of the service statuses and the ARP view-model's local 'error' state. */
  type BadgeModelStatus = 'idle' | 'loading' | 'available' | 'fallback' | 'error'

  const props = defineProps<{
    role: TrainedRole
    status: BadgeModelStatus
    /** Shown as the tooltip; carries the service's failure reason wording. */
    message?: string
    compact?: boolean
  }>()

  const emit = defineEmits<{ retry: [] }>()

  const label = computed(() => TRAINED_ROLE_LABELS[props.role])
  const isFallback = computed(() => props.status === 'fallback' || props.status === 'error')

  const tooltip = computed(() => {
    switch (props.status) {
      case 'available':
        return `Using the offline-trained ${label.value.toLowerCase()} Markov model`
      case 'loading':
        return `Loading the offline-trained ${label.value.toLowerCase()} Markov model`
      default:
        return props.message || `Trained ${label.value.toLowerCase()} model unavailable; using the built-in scale table`
    }
  })

  function onRetry(): void {
    emit('retry')
  }
</script>
