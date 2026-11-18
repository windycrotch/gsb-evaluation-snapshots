<script lang="ts">
	import type { AsyncStatus } from '@fuzdev/fuz_util/async.ts';
	import { fade } from 'svelte/transition';

	import { reset_midi_access, request_access as default_request_access } from './midi_access.ts';

	interface Props {
		midi_state: {
			midi_access: MIDIAccess | null;
			readonly midi_inputs: ReadonlyArray<MIDIInput> | null;
		};
		request_access?: (state: { midi_access: MIDIAccess | null }) => Promise<MIDIAccess | null>;
	}

	const { midi_state, request_access = default_request_access }: Props = $props();

	// TODO move MIDI initialization to some other action, like the button to start a level

	let request_status: AsyncStatus = $state('initial');

	const midi_inputs = $derived(midi_state.midi_inputs);
	const midi_input_count = $derived(midi_inputs?.length ?? 0);

	// only an in-flight request disables the button, so a granted access with no devices
	// can be requested again after plugging one in, and a failure stays retryable
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
	const disabled = $derived((request_status as AsyncStatus) === 'pending'); // TODO the cast is due to a typechecking bug (likely `svelte-check`)

	let request_error: string | undefined = $state();
</script>

<button
	type="button"
	class="big"
	onclick={async () => {
		request_status = 'pending';
		request_error = undefined;
		try {
			// TODO @many source from `audio` in context, makes this convoluted
			reset_midi_access(midi_state);
			await request_access(midi_state);
			request_status = 'success';
		} catch (err) {
			request_status = 'failure';
			request_error = err instanceof Error ? err.message : String(err);
		}
	}}
	{disabled}
	title={midi_state.midi_access ? 'MIDI is ready!' : 'connect your MIDI device [c]'}
>
	{#if midi_state.midi_access}
		{#if midi_input_count}
			<div>
				<div>MIDI devices</div>
				<ul>
					{#each midi_inputs ?? [] as midi_input (midi_input)}
						<li><small>{midi_input.name}</small></li>
					{/each}
				</ul>
			</div>
		{:else}
			<span in:fade>MIDI ready, but no devices are connected — plug one in</span>
		{/if}
	{:else if request_status === 'pending'}
		<span in:fade>requesting MIDI access</span>
	{:else if request_status === 'failure'}
		<span in:fade>
			failed to request MIDI access{#if request_error}: {request_error}{/if} — try again
		</span>
	{:else}
		connect MIDI &nbsp;<code>c</code>
	{/if}
</button>

<style>
	button {
		width: 100%;
	}
	li {
		list-style: none;
		text-align: left;
	}
</style>
