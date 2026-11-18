import { geoDistance, geoInterpolate } from 'd3-geo';
import { interpolateNumber } from 'd3-interpolate';

export const DEFAULT_RESOLUTION = 5; // degrees

/**
 * Densify a GeoJSON line of coordinates ([lng, lat] or [lng, lat, alt]) by
 * inserting intermediate points along the great circle between consecutive
 * points whose angular distance exceeds maxDegDistance.
 *
 * Each resulting segment spans at most maxDegDistance degrees. Pairs closer
 * than (or equal to) the limit are left untouched. When either endpoint of a
 * pair carries an altitude, inserted points get a linearly interpolated
 * altitude; otherwise the output stays 2-dimensional.
 *
 * Note: maxDegDistance is assumed to be a finite positive number. Input
 * normalization is the constructor's responsibility (see GeoJsonGeometry).
 *
 * @param {number[][]} lineCoords GeoJSON position array
 * @param {number} maxDegDistance maximum angular segment length, in degrees
 * @returns {number[][]} densified position array
 */
const interpolateLine = (lineCoords = [], maxDegDistance = DEFAULT_RESOLUTION) => {
  const result = [];

  let prevPnt = null;
  lineCoords.forEach(pnt => {
    if (prevPnt) {
      const dist = geoDistance(prevPnt, pnt) * 180 / Math.PI;

      if (dist > maxDegDistance) {
        const geoInterpol = geoInterpolate(prevPnt, pnt);
        const hasAltitude = prevPnt.length > 2 || pnt.length > 2;
        const altInterpol = hasAltitude
          ? interpolateNumber(prevPnt[2] || 0, pnt[2] || 0)
          : null;

        const interpol = t => altInterpol
          ? [...geoInterpol(t), altInterpol(t)]
          : geoInterpol(t);

        // Split into an integer number of equal great-circle segments, each
        // guaranteed to be no longer than maxDegDistance. An integer loop
        // (instead of accumulating a float step) avoids dropped/duplicated
        // points from floating-point drift.
        const segments = Math.ceil(dist / maxDegDistance);
        for (let seg = 1; seg < segments; seg++) {
          result.push(interpol(seg / segments));
        }
      }
    }

    result.push(prevPnt = pnt);
  });

  return result;
};

export default interpolateLine;
