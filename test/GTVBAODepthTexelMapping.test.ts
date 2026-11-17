import assert from "node:assert/strict";
import { test } from "vitest";
import { depthTexelOfAoTexelJS } from "../src/GTVBAODepthPrefilter.js";

// The shader-side depthTexelOfAoTexel() is a TSL node; this exercises the
// identical integer formula on the JS twin that every consumer must agree on:
// floor( ( ( 2t + 1 ) * D ) / ( 2A ) ), the depth texel under AO texel t's
// center. At integral downscales (D = kA) it must land on the center depth
// texel with no float-rounding row offset, and it must match the reference
// decimation used by the WebGPU regression's CPU-side MIP oracle.
const referenceSelection = ( aoTexel: number, depthSize: number, aoSize: number ) =>
	Math.floor( ( ( Math.min( aoTexel, aoSize - 1 ) * 2 + 1 ) * depthSize ) / ( 2 * aoSize ) );

test("level 0 texel maps to the center scene-depth texel under integral downscales", () => {
	// Half and quarter resolution: each AO texel spans exactly 2x2 or 4x4 depth
	// texels. The integer quotient selects the central depth texel (the lower one
	// for an even-sized block), identical on both axes with no float rounding.
	for ( const scale of [ 2, 4 ] ) {
		const aoSize = 64;
		const depthSize = aoSize * scale;
		for ( let texel = 0; texel < aoSize; texel += 1 ) {
			// Exact integer quotient ((2t + 1) * D) / (2A): the lower of the two
			// central depth texels for an even block. Both axes must agree.
			const expected = Math.floor( ( ( 2 * texel + 1 ) * depthSize ) / ( 2 * aoSize ) );
			const [ x, y ] = depthTexelOfAoTexelJS( texel, texel, depthSize, depthSize, aoSize, aoSize );
			assert.equal( Number.isInteger( x ), true, "selection must be an integer texel" );
			assert.equal( x, expected, `x mismatch at scale 1/${scale}, texel ${texel}` );
			assert.equal( y, expected, `y mismatch at scale 1/${scale}, texel ${texel}` );
			// For an odd block the quotient is the exact geometric center; for an
			// even block it is the lower central texel, never a row outside the block.
			const blockStart = scale * texel;
			assert.ok( x >= blockStart && x < blockStart + scale, "selection leaves the AO texel's depth block" );
		}
	}
});

test("integer selection agrees on both axes for non-square, odd-sized buffers", () => {
	// Odd depth sizes and unequal axes exercise the per-axis integer quotient;
	// the last AO texel repeats the final AO coordinate, matching the shader clamp.
	const cases = [
		{ aoWidth: 31, aoHeight: 19, depthWidth: 62, depthHeight: 57 },
		{ aoWidth: 10, aoHeight: 7, depthWidth: 23, depthHeight: 21 },
		{ aoWidth: 23, aoHeight: 31, depthWidth: 47, depthHeight: 93 },
		{ aoWidth: 33, aoHeight: 1, depthWidth: 67, depthHeight: 3 },
	];
	for ( const size of cases ) {
		for ( let y = 0; y < size.aoHeight; y += 1 ) {
			for ( let x = 0; x < size.aoWidth; x += 1 ) {
				const [ mappedX, mappedY ] = depthTexelOfAoTexelJS(
					x, y, size.depthWidth, size.depthHeight, size.aoWidth, size.aoHeight
				);
				assert.equal( mappedX, referenceSelection( x, size.depthWidth, size.aoWidth ) );
				assert.equal( mappedY, referenceSelection( y, size.depthHeight, size.aoHeight ) );
				assert.ok( mappedX >= 0 && mappedX < size.depthWidth, "x out of depth bounds" );
				assert.ok( mappedY >= 0 && mappedY < size.depthHeight, "y out of depth bounds" );
			}
		}
	}
});

test("integer quotient never lands a row off the center texel at D = 2A and D = 4A", () => {
	// The float form floor((t + 0.5) * D / A) can round either side of an exact
	// integer when the compute and fragment compilers disagree; the integer form
	// must always equal the exact center and never a neighboring row.
	for ( const [ depthSize, aoSize ] of [ [ 128, 64 ], [ 256, 64 ], [ 100, 25 ], [ 80, 20 ] ] ) {
		for ( let texel = 0; texel < aoSize; texel += 1 ) {
			const exactCenter = ( texel + 0.5 ) * depthSize / aoSize;
			const floatSelection = Math.floor( exactCenter );
			const [ integerSelection ] = depthTexelOfAoTexelJS( texel, 0, depthSize, 1, aoSize, 1 );
			assert.equal( integerSelection, floatSelection, `diverges from the center at texel ${texel}` );
			// floor() cannot overshoot the exact center, which is an integer here.
			assert.ok( integerSelection <= exactCenter, "integer selection rounded past the exact center" );
		}
	}
});
