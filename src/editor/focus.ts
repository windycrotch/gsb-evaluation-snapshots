/** Which area the user interacted with last — decides what the Delete key removes. */
let area: 'viewport' | 'timeline' | 'tree' = 'viewport';

export function setFocusArea(a: typeof area) {
  area = a;
}

export function focusArea() {
  return area;
}
