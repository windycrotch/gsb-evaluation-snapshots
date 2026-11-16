export function linkSelections(selA, selB) {
  // Guard against an echo: applying a selection notifies the target's own
  // subscribers, and that includes the callback that would apply it straight
  // back to the source. Without this, two plots whose tile sizes differ would
  // repeatedly overwrite each other with differently-sized arrays.
  let applying = false
  const apply = (target, source) => {
    if (applying) return
    applying = true
    try { target.applyFrom(source) } finally { applying = false }
  }
  const handleA = selA.subscribe(sel => apply(selB, sel))
  const handleB = selB.subscribe(sel => apply(selA, sel))
  return { unlink: () => { handleA.remove(); handleB.remove() } }
}
