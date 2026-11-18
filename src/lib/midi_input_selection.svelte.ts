import { MidiInputs } from './midi_inputs.svelte.ts';

/**
 * Tracks which connected `MIDIInput` the user has chosen.
 *
 * The chosen id is remembered even while its device is unplugged,
 * so reconnecting it restores the selection. While it's unavailable the effective
 * selection falls back to the first connected input, and to `null` when none are connected.
 * All reads are pure: reactivity comes from `MidiInputs.current`, which observes `statechange`.
 */
export class MidiInputSelection {
	readonly #inputs: MidiInputs;
	#selected_id: string | null = $state(null);

	constructor(inputs: MidiInputs) {
		this.#inputs = inputs;
	}

	/**
	 * The currently connected inputs, a new array after each `statechange`.
	 */
	get current(): Array<MIDIInput> {
		return this.#inputs.current;
	}

	/**
	 * The chosen input, or the first connected one when the chosen input is unavailable,
	 * or `null` when no inputs are connected.
	 */
	get selected(): MIDIInput | null {
		const inputs = this.#inputs.current;
		if (!inputs.length) return null;
		return inputs.find((input) => input.id === this.#selected_id) ?? inputs[0]!;
	}

	/**
	 * Chooses an input, or clears the explicit choice with `null` so the first input is used.
	 */
	select(input: MIDIInput | null): void {
		this.#selected_id = input?.id ?? null;
	}
}
