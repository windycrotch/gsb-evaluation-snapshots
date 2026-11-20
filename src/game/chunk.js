/**
 * A column of blocks LENGTH by WIDTH wide and HEIGHT tall. Blocks are stored
 * as one byte ids, and the mesh only lives on the GPU.
 */

const MAX_MESH_RETRY_FRAMES = 64; // longest wait between retries of a mesh that failed

class Chunk {
  /**
   * Create a chunk from generated blocks
   * @param {number} x Chunk x coordinate
   * @param {number} z Chunk z coordinate
   * @param {Uint8Array} blocks Block ids, empty if not given
   * @param {Map<string, Uint32Array>} features Chunk key -> packed blocks this chunk's trees place in that chunk
   */
  constructor(x, z, blocks = new Uint8Array(LENGTH * WIDTH * HEIGHT), features = new Map()) {
    this.x = x;
    this.z = z;
    this.X = this.x * LENGTH; // world x of the chunk's corner
    this.Z = this.z * WIDTH; // world z of the chunk's corner
    this.blocks = blocks;
    this.features = features;
    this.decorated = false;
    this.solidMesh = null; // {buffer, faces} of opaque and cutout blocks, on the GPU
    this.translucentMesh = null; // {buffer, faces} of translucent blocks, drawn after every solid mesh
    this.complete = false;
    this.calculating = false;
    this.unloaded = false; // set when the chunk was dropped, so late results are ignored
    this.meshFailures = 0; // mesh builds that errored, so they are spaced out when retried
    this.meshRetryFrame = 0; // loader frame before which no new mesh is requested
    this._meshVersion = 0; // bumped so meshes started earlier are ignored when they finish
  }

  /**
   * Add the trees that this chunk and its neighbors grow into it, then the
   * player's edits. Every neighbor must be generated first.
   */
  decorate() {
    const key = getChunkKey(this.x, this.z);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const features = getLoadedChunk(this.x + dx, this.z + dz).features.get(key);
        if (features) applyFeatureBlocks(this.blocks, features);
      }
    }

    data.edits.applyTo(this);
    this.decorated = true;
  }

  /**
   * Draw the chunk's opaque and cutout blocks
   */
  render() {
    this._drawMesh(this.solidMesh);
    data.renderedChunks++;
  }

  /**
   * Draw the chunk's translucent blocks, after every chunk's solid blocks
   */
  renderTranslucent() {
    this._drawMesh(this.translucentMesh);
  }

  /**
   * Check whether the chunk has translucent blocks to draw
   * @returns {boolean} Whether renderTranslucent draws anything
   */
  hasTranslucent() {
    return this.translucentMesh != null;
  }

  /**
   * Mark the chunk as having a mesh on the way. The chunk and its neighbors
   * must be decorated first.
   * @returns {number} Version to pass to setMesh when the mesh is built
   */
  startMesh() {
    this.calculating = true;
    return ++this._meshVersion;
  }

  /**
   * Upload built meshes to the GPU, unless the chunk changed, was freed or
   * was unloaded since the meshes were started
   * @param {number} version Version from startMesh
   * @param {{solid: Object, translucent: Object}} mesh Meshes from buildChunkMesh
   * @param {number} frame Loader frame the upload happens on, for spacing out retries
   */
  setMesh(version, mesh, frame = 0) {
    if (this.unloaded || version !== this._meshVersion) return;

    try {
      this.solidMesh = this._uploadMesh(this.solidMesh, mesh.solid);
      this.translucentMesh = this._uploadMesh(this.translucentMesh, mesh.translucent);
    } catch (error) {
      // The GPU couldn't take the mesh, so let the chunk be meshed again
      // instead of leaving it marked as calculating
      console.error(`Uploading the mesh of chunk ${this.x},${this.z} failed, will retry`, error);
      this.meshFailed(version, frame);
      return;
    }

    this.calculating = false;
    this.complete = true;
    this.meshFailures = 0;
    this.meshRetryFrame = 0;
  }

  /**
   * Give up on a mesh that failed to build, so the chunk can be requested
   * again instead of staying marked as calculating forever. Retries are
   * spaced further apart each time, so a chunk that always fails doesn't
   * take a worker every frame.
   * @param {number} version Version from startMesh
   * @param {number} frame Loader frame the failure was seen on
   */
  meshFailed(version, frame) {
    if (this.unloaded || version !== this._meshVersion) return;

    this.calculating = false;
    this.complete = false;
    this.meshFailures++;
    const wait = Math.min(2 ** (this.meshFailures - 1), MAX_MESH_RETRY_FRAMES);
    this.meshRetryFrame = frame + wait;
  }

  /**
   * Check whether the chunk's mesh may be requested again now
   * @param {number} frame Current loader frame
   * @returns {boolean} Whether a failed mesh has waited long enough to retry
   */
  canRetryMesh(frame) {
    return this.meshRetryFrame <= frame;
  }

  /**
   * Rebuild the mesh on the main thread right away, for changes the player
   * should see immediately. A failure is logged and leaves the chunk ready to
   * be meshed again on the next loader frame instead of stuck in progress.
   */
  buildMeshNow() {
    const version = this.startMesh();

    try {
      this.setMesh(version, buildChunkMesh(createMeshArea(this), this.X, this.Z));
    } catch (error) {
      console.error(`Meshing chunk ${this.x},${this.z} failed`, error);

      // A player edit shouldn't wait out a backoff: leave the chunk retryable now
      this.meshFailed(version, 0);
      this.meshRetryFrame = 0;
    }
  }

  /**
   * Free the chunk's mesh, keeping its blocks. Any mesh still being built is
   * ignored when it arrives, and a later request starts over without waiting
   * out an old retry delay.
   */
  freeMesh() {
    this._meshVersion++;
    this.solidMesh = this._uploadMesh(this.solidMesh, null);
    this.translucentMesh = this._uploadMesh(this.translucentMesh, null);
    this.complete = false;
    this.calculating = false;
    this.meshFailures = 0;
    this.meshRetryFrame = 0;
  }

  /**
   * Check whether the chunk holds a mesh on the GPU
   * @returns {boolean} Whether there is anything to free or draw
   */
  hasMesh() {
    return this.solidMesh != null || this.translucentMesh != null;
  }

  /**
   * Free everything the chunk holds on the GPU before it is dropped, and
   * make sure results still on the way are not uploaded to it
   */
  unload() {
    this.unloaded = true;
    this.freeMesh();
  }

  /**
   * Replace a mesh on the GPU, reusing its buffer, or freeing it when there is nothing to draw
   * @param {{buffer: Buffer, faces: number}|null} current Mesh on the GPU now
   * @param {{vertices: Float32Array, indices: Uint32Array}|null} data New mesh data
   * @returns {{buffer: Buffer, faces: number}|null} Mesh on the GPU
   */
  _uploadMesh(current, data) {
    if (data == null || data.indices.length === 0) {
      current?.buffer.destroy(gl);
      return null;
    }

    const buffer = current?.buffer ?? new Buffer();

    try {
      buffer.upload(gl, data.vertices, data.indices);
    } catch (error) {
      // A newly created buffer that never received data would otherwise leak
      if (current == null) buffer.destroy(gl);
      throw error;
    }

    return { buffer: buffer, faces: data.indices.length / 6 };
  }

  /**
   * Draw a mesh
   * @param {{buffer: Buffer, faces: number}|null} mesh Mesh on the GPU
   */
  _drawMesh(mesh) {
    if (mesh == null) return;

    mesh.buffer.setUsing(gl);
    setupVertexAttribs();
    gl.drawElements(gl.TRIANGLES, 6 * mesh.faces, gl.UNSIGNED_INT, 0);
  }
}
