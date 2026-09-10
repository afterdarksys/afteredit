export function focusRegion(id: string) {
  const region = document.getElementById(id);
  if (!region) return;
  if (id === 'workspace') {
    window.dispatchEvent(new Event('afteredit:focus-editor'));
    if(region.querySelector('.monaco-editor')?.contains(document.activeElement))return;
    const editor = region.querySelector<HTMLElement>('.monaco-editor textarea, .fallback-editor, iframe');
    if (editor) { editor.focus(); return; }
  }
  region.focus();
}
export function cycleRegion(backward: boolean) {
  const regions = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-region]'))
    .filter(node => node.getClientRects().length > 0);
  if (!regions.length) return;
  const current = regions.findIndex(node => node.contains(document.activeElement));
  const next = current < 0 ? (backward ? regions.length - 1 : 0)
    : (current + (backward ? -1 : 1) + regions.length) % regions.length;
  focusRegion(regions[next].id);
}
