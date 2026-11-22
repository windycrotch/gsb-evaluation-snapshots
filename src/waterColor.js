/**
 * Binds the debug panel's water color controls to the water shader uniforms.
 *
 * The panel is built before the water material exists (and the material may be
 * rebuilt later), so every change is recorded here first and only written to
 * the uniforms once a material with those uniforms is attached. That way a
 * drag can never touch an undefined material, and whichever color is selected
 * while the material is unavailable is applied as soon as it becomes ready.
 */
export function createWaterColorBinding(initialColors) {
  const selection = {
    uColor1: initialColors.uColor1,
    uColor2: initialColors.uColor2,
  }

  let material = null

  const uniformNames = Object.keys(selection)

  function apply(name) {
    if (!material) return

    const uniform = material.uniforms && material.uniforms[name]
    if (!uniform || !uniform.value || typeof uniform.value.set !== "function") {
      return
    }

    uniform.value.set(selection[name])
  }

  return {
    selection,

    /** Record a new selection and push it to the material when possible. */
    setColor(name, value) {
      if (!Object.prototype.hasOwnProperty.call(selection, name)) return
      selection[name] = value
      apply(name)
    },

    /** Attach (or replace) the material and flush the current selection. */
    attachMaterial(nextMaterial) {
      material = nextMaterial || null
      uniformNames.forEach(apply)
    },

    /** Detach the material, e.g. while it is being rebuilt. */
    detachMaterial() {
      material = null
    },

    get material() {
      return material
    },

    get ready() {
      return material !== null
    },
  }
}
