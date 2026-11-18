import {
  BufferGeometry,
  Float32BufferAttribute
} from 'three';

const THREE = typeof window !== 'undefined' && window.THREE
  ? window.THREE // Prefer consumption from global THREE, if exists
  : {
  BufferGeometry,
  Float32BufferAttribute
};

import { merge as flatten } from 'd3-array';
import { flatten as earcutFlatten } from 'earcut';

import geoPolygonTriangulate from './geoPolygonTriangulate.js';

// support both modes for backwards threejs compatibility
const setAttributeFn = new THREE.BufferGeometry().setAttribute ? 'setAttribute' : 'addAttribute';

class ConicPolygonGeometry extends THREE.BufferGeometry {
  constructor(polygonGeoJson, bottomHeight, topHeight, closedBottom, closedTop, includeSides, curvatureResolution) {
    super();

    this.type = 'ConicPolygonGeometry';

    this.parameters = {
      polygonGeoJson,
      bottomHeight,
      topHeight,
      closedBottom,
      closedTop,
      includeSides,
      curvatureResolution
    };

    // defaults
    bottomHeight = bottomHeight || 0;
    topHeight = topHeight || 1;
    closedBottom = closedBottom !== undefined ? closedBottom : true;
    closedTop = closedTop !== undefined ? closedTop : true;
    includeSides = includeSides !== undefined ? includeSides : true;
    curvatureResolution = curvatureResolution || 5; // in angular degrees

    // pre-calculate contour, triangulation and UV maps
    const { contour, triangles } = geoPolygonTriangulate(polygonGeoJson, {resolution: curvatureResolution});
    const flatUvs = flatten(triangles.uvs);

    let vertices = [];
    let uvs = [];
    let indices = [];
    // fixed group slots: 0 = side, 1 = bottom cap, 2 = top cap. Passing the
    // material index explicitly keeps the documented numbering stable even
    // when one of the optional surfaces is disabled (a plain running counter
    // would renumber the top cap to 1 when the bottom cap is turned off).
    const addGroup = (groupData, materialIndex) => {
      const prevVertCnt = Math.round(vertices.length / 3);
      const prevIndCnt = indices.length;

      vertices = vertices.concat(groupData.vertices);
      uvs = uvs.concat(groupData.uvs);
      indices = indices.concat(!prevVertCnt ? groupData.indices : groupData.indices.map(ind => ind + prevVertCnt));

      this.addGroup(prevIndCnt, indices.length - prevIndCnt, materialIndex);
    };

    includeSides && addGroup(generateTorso(), 0);
    closedBottom && addGroup(generateCap(bottomHeight, false), 1);
    closedTop && addGroup(generateCap(topHeight, true), 2);

    // build geometry
    this.setIndex(indices);
    this[setAttributeFn]('position', new THREE.Float32BufferAttribute(vertices, 3));
    this[setAttributeFn]('uv', new THREE.Float32BufferAttribute(uvs, 2));

    // auto-calculate normals
    this.computeVertexNormals();

    //

    function generateVertices(polygon, altitude) {
      const altFn = typeof altitude === 'function' ? altitude : () => altitude;
      const coords3d = polygon.map(coords => coords.map(([lng, lat]) => polar2Cartesian(lat, lng, altFn(lng, lat))));
      // returns { vertices, holes, coordinates }. Each point generates 3 vertice items (x,y,z).
      return earcutFlatten(coords3d);
    }

    function generateTorso() {
      const {vertices: bottomVerts, holes} = generateVertices(contour, bottomHeight);
      const {vertices: topVerts} = generateVertices(contour, topHeight);

      const vertices = flatten([topVerts, bottomVerts]);
      const numPoints = Math.round(topVerts.length / 3);

      const holesIdx = new Set(holes);
      let lastHoleIdx = 0;

      const indices = [];
      for (let v0Idx = 0; v0Idx < numPoints; v0Idx++) {
        let v1Idx = v0Idx + 1; // next point
        if (v1Idx === numPoints) {
          v1Idx = lastHoleIdx; // close final loop
        } else if (holesIdx.has(v1Idx)) {
          const holeIdx = v1Idx;
          v1Idx = lastHoleIdx; // close hole loop
          lastHoleIdx = holeIdx;
        }

        // Each pair of coords generates two triangles (faces)
        indices.push(v0Idx, v0Idx + numPoints, v1Idx + numPoints);
        indices.push(v1Idx + numPoints, v1Idx, v0Idx);
      }

      const uvs = []; // wrap texture around perimeter (u), with v=1 on top
      for (let v=1; v>=0; v--)
        for (let i=0; i<numPoints; i+=1)
          uvs.push(i/(numPoints-1), v);

      return { indices, vertices, uvs };
    }

    function generateCap(radius, isTop = true) {
      return {
        // need to reverse-wind the bottom triangles to make them face outwards
        indices: isTop ? triangles.indices : triangles.indices.slice().reverse(),
        vertices: generateVertices([triangles.points], radius).vertices,
        uvs: flatUvs
      }
    }
  }

  clone() {
    return new ConicPolygonGeometry(
      this.parameters.polygonGeoJson,
      this.parameters.bottomHeight,
      this.parameters.topHeight,
      this.parameters.closedBottom,
      this.parameters.closedTop,
      this.parameters.includeSides,
      this.parameters.curvatureResolution
    ).copy(this);
  }
}

//

function polar2Cartesian(lat, lng, r = 0) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (90 - lng) * Math.PI / 180;
  return [
    r * Math.sin(phi) * Math.cos(theta), // x
    r * Math.cos(phi), // y
    r * Math.sin(phi) * Math.sin(theta) // z
  ];
}

export default ConicPolygonGeometry;
