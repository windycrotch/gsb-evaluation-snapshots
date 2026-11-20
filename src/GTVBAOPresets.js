// Quality presets, tuned at 4K with a device pixel ratio of 2. `temporal`,
// `denoise` and `accumulate` describe the pipeline each preset expects: temporal
// presets jitter the sampling per frame and rely on a TRAA resolve after the lit pass;
// the "No Temporal" presets keep the sampling fixed and expect the lit pass to
// read GTVBAODenoiseNode's output instead of the raw AO.
// Presets with `accumulate` expect a GTVBAOTemporalNode between the AO and its
// consumer (the lit pass or denoiser), using the pre-pass velocity buffer.
// They still work without it, but flicker at half resolution.
export const GTVBAO_PRESETS = {
	Low: {
		resolutionScale: 0.5,
		sliceCount: 1,
		stepCount: 8,
		radius: 3,
		thickness: 0.12,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 1,
		temporal: true,
		denoise: false,
		accumulate: true,
		denoiseRadius: 1,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	},
	Balanced: {
		resolutionScale: 0.5,
		sliceCount: 2,
		stepCount: 6,
		radius: 3,
		thickness: 0.12,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 1,
		temporal: true,
		denoise: false,
		accumulate: true,
		denoiseRadius: 2,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	},
	High: {
		resolutionScale: 1,
		sliceCount: 3,
		stepCount: 12,
		radius: 3,
		thickness: 0.08,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 0.35,
		temporal: true,
		denoise: false,
		accumulate: false,
		denoiseRadius: 2,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	},
	'No Temporal Low': {
		resolutionScale: 0.5,
		sliceCount: 2,
		stepCount: 6,
		radius: 3,
		thickness: 0.12,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 1,
		temporal: false,
		denoise: true,
		accumulate: false,
		denoiseRadius: 2,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	},
	'No Temporal High': {
		resolutionScale: 1,
		sliceCount: 3,
		stepCount: 12,
		radius: 3,
		thickness: 0.08,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 0.35,
		temporal: false,
		denoise: true,
		accumulate: false,
		denoiseRadius: 2,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	}
};

export const GTVBAO_PRESET_NAMES = Object.keys( GTVBAO_PRESETS );

export const DEFAULT_GTVBAO_PRESET = 'Balanced';

const PRESET_NUMBER_FIELDS = [ 'resolutionScale', 'sliceCount', 'stepCount', 'radius', 'thickness', 'aoIntensity', 'expFactor', 'linearThicknessScale', 'maxThickness', 'denoiseRadius' ];
const PRESET_BOOLEAN_FIELDS = [ 'useScreenSpaceSampling', 'useLinearThickness', 'usePerspectiveCorrectSlice', 'useDepthMips', 'temporal', 'denoise', 'accumulate' ];

// Every field a preset application touches is validated up front, so a
// malformed preset fails before any node state changes instead of leaving a
// half-initialized pipeline behind.
const validateGtvbaoPreset = ( preset, label ) => {
	for ( const field of PRESET_NUMBER_FIELDS ) {
		if ( typeof preset[ field ] !== 'number' || ! Number.isFinite( preset[ field ] ) ) {
			throw new Error( `Invalid GTVBAO preset "${ label }": "${ field }" must be a finite number.` );
		}
	}
	if ( preset.resolutionScale <= 0 ) {
		throw new Error( `Invalid GTVBAO preset "${ label }": "resolutionScale" must be greater than 0.` );
	}
	for ( const field of PRESET_BOOLEAN_FIELDS ) {
		if ( typeof preset[ field ] !== 'boolean' ) {
			throw new Error( `Invalid GTVBAO preset "${ label }": "${ field }" must be a boolean.` );
		}
	}
	if ( typeof preset.sectorMeasure !== 'string' ) {
		throw new Error( `Invalid GTVBAO preset "${ label }": "sectorMeasure" must be a string.` );
	}
};

/**
 * Applies a preset (by name or as an object) to a GTVBAONode, and to a
 * GTVBAODenoiseNode when one is given. The application is one convergent
 * session: the preset is validated before anything changes, then every field —
 * including the temporal-jitter toggle and the denoiser — is set inside a
 * single variant batch, so the shader variant is rebuilt at most once and
 * consumers are notified only after the full new configuration is in place.
 * The next frame then renders the new preset in full (AO resolution, depth
 * MIPs, depth-aware upsample and jitter all switch in the same update) instead
 * of converging from the previous one. An unknown name, a malformed preset or
 * a disposed AO node throws and leaves the previous, working state untouched.
 * The caller still decides which texture the lit pass reads according to
 * `preset.denoise` and `preset.accumulate`: raw AO, accumulated AO, or either
 * after denoising.
 */
export function applyGtvbaoPreset( gtvbaoNode, preset, denoiseNode = null ) {
	const resolved = typeof preset === 'string' ? GTVBAO_PRESETS[ preset ] : preset;
	if ( resolved === undefined || resolved === null ) throw new Error( `Unknown GTVBAO preset: ${ preset }` );
	validateGtvbaoPreset( resolved, typeof preset === 'string' ? preset : 'custom' );
	if ( gtvbaoNode.isDisposed === true ) throw new Error( 'Cannot apply a GTVBAO preset to a disposed GTVBAONode.' );
	gtvbaoNode.batchVariantChanges( () => {
		gtvbaoNode.resolutionScale = resolved.resolutionScale;
		gtvbaoNode.sliceCount.value = resolved.sliceCount;
		gtvbaoNode.stepCount.value = resolved.stepCount;
		gtvbaoNode.radius.value = resolved.radius;
		gtvbaoNode.thickness.value = resolved.thickness;
		gtvbaoNode.aoIntensity.value = resolved.aoIntensity;
		gtvbaoNode.expFactor.value = resolved.expFactor;
		gtvbaoNode.useScreenSpaceSampling.value = resolved.useScreenSpaceSampling;
		gtvbaoNode.useLinearThickness.value = resolved.useLinearThickness;
		gtvbaoNode.linearThicknessScale.value = resolved.linearThicknessScale;
		gtvbaoNode.maxThickness.value = resolved.maxThickness;
		gtvbaoNode.sectorMeasure.value = resolved.sectorMeasure;
		gtvbaoNode.usePerspectiveCorrectSlice.value = resolved.usePerspectiveCorrectSlice;
		gtvbaoNode.useDepthMips.value = resolved.useDepthMips;
		gtvbaoNode.useTemporalFiltering = resolved.temporal;
		if ( denoiseNode !== null ) {
			denoiseNode.radius.value = resolved.denoiseRadius;
			denoiseNode.useTemporalDenoiseRotation = resolved.temporal && resolved.denoise;
		}
	} );
	return resolved;
}
