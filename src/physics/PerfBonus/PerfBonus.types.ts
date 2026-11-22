/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Perfect-bhop velocity carry: a REAL, skill-timed instant rejump (the tick
 * right after landing, manual input only) restores the exact horizontal
 * velocity you landed with, bypassing whatever bhopSpeedClamp or ground
 * friction already reduced it to. Nothing else qualifies:
 *
 *  - `autobhop` never gets the carry, ever. Held-jump autobhop always
 *    re-fires the instant it's able to, regardless of skill — treating that
 *    as a guaranteed "perfect" every hop permanently defeats
 *    bhopSpeedClamp, since the carry would restore whatever you landed
 *    with every single time and the clamp would never get a tick to
 *    actually hold speed down.
 *  - A landing that came off a surf ramp (or the flight immediately after
 *    leaving one, before your next real landing) never counts either —
 *    surf speed isn't something you "cash in" as a perfect bhop.
 *  - Anything later than the very next tick after landing gets nothing —
 *    no partial credit for a near-miss.
 *
 * A miss (any of the above) just leaves the takeoff at whatever
 * `bhopSpeedClamp` already computed.
 *
 * The carry alone compounds without limit across a chain, which isn't how
 * real chasemod servers feel — players report air speed never exceeding
 * `maxAirSpeed` (unless surfing, a different physics path via ramp
 * geometry). So whenever `enabled`, AirMove.ts squeezes air speed itself
 * through a diminishing-returns curve every airborne tick — not just at the
 * carry — approaching `maxAirSpeed` but never quite reaching it.
 *
 * Surfing is exempt from this squeeze for the whole flight segment that
 * touched the ramp. Two distinct marks keep that lifecycle honest (see
 * MovementContext): `surfedSinceGrounded` is the flight-scoped exemption,
 * armed by the first ramp touch and closed by a real ground landing or any
 * takeoff (a jump, including a ladder jump-off); `landingFromSurf` is the
 * landing-scoped record that keeps a surf landing out of the perfect-bhop
 * carry above. Both return to their initial state on respawn / input reset.
 */
export interface PerfSettings {
  enabled: boolean;
  maxAirSpeed: number; // asymptotic ceiling perfect-bhop air speed approaches; observed ~390 on nopre chasemod servers
}
