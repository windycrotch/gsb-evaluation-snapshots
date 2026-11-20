<template>
  <DawModule v-model="isOpen" data-module-key="model" title="Melody Model" role-dot="signal" badge-color="signal">
    <template #badge>
      <span class="text-micro font-mono" :class="hasError ? 'text-red-400' : 'text-daw-signal'">
        {{ activeModelLabel }}
      </span>
    </template>

    <div class="flex flex-col gap-2">
      <DawSegmented
        :model-value="melodyStore.generatorParams.melodyModel"
        :options="modelOptions"
        size="sm"
        variant="signal"
        grow
        wrap
        class="w-full"
        aria-label="Offline-trained Markov model"
        @update:model-value="setModel"
      />

      <p class="text-daw-text-muted text-micro leading-relaxed">
        {{ activeModelDescription }}
      </p>

      <div
        v-if="isLoading"
        class="border-daw-border bg-daw-surface text-daw-text-muted rounded-panel flex items-center gap-1.5 border px-2 py-1.5"
        role="status"
        aria-live="polite"
      >
        <Loader2 class="h-3.5 w-3.5 animate-spin" />
        <span class="text-micro">Loading trained model…</span>
      </div>

      <div
        v-else-if="hasError"
        class="rounded-panel flex items-start gap-1.5 border border-red-500/50 bg-red-500/10 px-2 py-1.5 text-red-300"
        role="alert"
        aria-live="assertive"
        data-testid="melody-model-error"
      >
        <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div class="flex flex-col gap-1">
          <span class="text-micro font-semibold">{{
            melodyStore.melodyModelStatusMessage || 'Model failed to load'
          }}</span>
          <span class="text-micro text-red-300/80"
            >No notes were changed. Fix the model or pick another source, then generate again.</span
          >
        </div>
      </div>
    </div>
  </DawModule>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { Loader2, TriangleAlert } from '@lucide/vue'
  import DawModule from '@/components/common/DawModule.vue'
  import DawSegmented, { type SegmentOption } from '@/components/common/DawSegmented.vue'
  import { useModuleOpenState } from '@/composables/useModuleOpenState'
  import type { MelodyModelChoice } from '@/core/schemas/generator.schema'
  import { useMelodyStore } from '@/stores/melody.store'

  const melodyStore = useMelodyStore()
  const isOpen = useModuleOpenState('model')

  const modelOptions: SegmentOption<MelodyModelChoice>[] = [
    {
      label: 'Auto',
      value: 'auto',
      title: 'Auto: bass rhythm presets use the bass table, every other rhythm uses the melody table'
    },
    { label: 'Melody', value: 'melody', title: 'Melody: always generate with the offline-trained melody table' },
    { label: 'Bass', value: 'bass', title: 'Bass: always generate with the offline-trained bass table' },
    {
      label: 'Scale',
      value: 'synthetic',
      title: 'Scale: use the built-in synthetic scale model without any offline table'
    }
  ]

  const hasError = computed(() => melodyStore.hasMelodyModelError)
  const isLoading = computed(() => melodyStore.isMelodyModelLoading)

  const activeModelLabel = computed(() => {
    if (isLoading.value) return 'LOADING'
    if (hasError.value) return 'ERROR'
    const choice = melodyStore.generatorParams.melodyModel
    if (choice === 'synthetic') return 'SCALE'
    const activeId = melodyStore.activeMelodyModelId
    if (activeId) return activeId.toUpperCase()
    return choice.toUpperCase()
  })

  const activeModelDescription = computed(() => {
    switch (melodyStore.generatorParams.melodyModel) {
      case 'melody':
        return 'Every generation uses the offline-trained melody transition table for this range.'
      case 'bass':
        return 'Every generation uses the offline-trained bass transition table for this range.'
      case 'synthetic':
        return 'Generations use the built-in scale-derived model; no offline table is loaded.'
      case 'auto':
      default:
        return 'The active rhythm preset picks the table: bass presets use the bass model, all others use the melody model.'
    }
  })

  function setModel(choice: MelodyModelChoice): void {
    melodyStore.setMelodyModel(choice)
  }
</script>
