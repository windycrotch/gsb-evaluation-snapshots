import { formatRepairReport } from '../geometry/ManifoldRepair.js';

/**
 * Surfaces the manifold-repair fallback in the UI:
 *  - a transient toast summarizing the repair report each time RepairMeshCommand runs,
 *  - a persistent, dismissible panel listing the full report (counts, warnings, the exact
 *    ids of repair-added faces) so the user can verify what changed.
 *
 * The same report is also queryable through the `mesh.repairReport` agent command and is
 * embedded in the undoable history command, so this component is purely presentational.
 */
export class RepairReportToast {
  constructor(editor) {
    this.editor = editor;
    this.container = null;
    this.details = null;
    this.hideTimer = null;

    this._onRepair = this._onRepair.bind(this);
    editor.signals.repairApplied.add(this._onRepair);
  }

  _ensureDom() {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.className = 'repair-report-toast';
    this.container.innerHTML = `
      <div class="repair-report-toast__head">
        <span class="repair-report-toast__title"></span>
        <button type="button" class="repair-report-toast__toggle" title="Show / hide details">Details</button>
        <button type="button" class="repair-report-toast__close" title="Dismiss">×</button>
      </div>
      <div class="repair-report-toast__summary"></div>
      <div class="repair-report-toast__details" hidden></div>
    `;
    document.body.appendChild(this.container);

    this.titleEl = this.container.querySelector('.repair-report-toast__title');
    this.summaryEl = this.container.querySelector('.repair-report-toast__summary');
    this.detailsEl = this.container.querySelector('.repair-report-toast__details');

    this.container.querySelector('.repair-report-toast__close')
      .addEventListener('click', () => this._dismiss());
    this.container.querySelector('.repair-report-toast__toggle')
      .addEventListener('click', () => {
        this.detailsEl.hidden = !this.detailsEl.hidden;
      });
  }

  _onRepair({ objectUuid, undone = false, report } = {}) {
    if (!report) return;
    this._ensureDom();

    const object = this.editor.objectByUuid(objectUuid);
    const name = object?.name || objectUuid || 'mesh';

    this.titleEl.textContent = undone ? `Repair undone — ${name}` : `Mesh auto-repaired — ${name}`;
    this.summaryEl.textContent = formatRepairReport(report);
    this.detailsEl.innerHTML = this._renderDetails(report);
    this.detailsEl.hidden = true;
    this.container.classList.add('active');

    clearTimeout(this.hideTimer);
    // The summary auto-hides; the user can reopen details from history/agent regardless.
    this.hideTimer = setTimeout(() => this.container.classList.remove('active'), 8000);
  }

  _renderDetails(report) {
    const rows = [
      ['Welded vertices', report.weldedVerts],
      ['Removed faces', report.removedFaces],
      ['Split vertices', report.splitVerts],
      ['Flipped faces', report.flippedFaces],
      ['Filled holes', report.filledHoles],
      ['Skipped holes', report.skippedHoles],
    ];
    const rowsHtml = rows
      .map(([label, value]) => `<div class="repair-report-row"><span>${label}</span><b>${value}</b></div>`)
      .join('');

    const repairIds = report.repairFaceIds?.length
      ? report.repairFaceIds.join(', ')
      : '(none)';
    const warnings = report.warnings?.length
      ? `<ul class="repair-report-warnings">${report.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
      : '<div class="repair-report-note">No warnings.</div>';

    return `
      <div class="repair-report-grid">${rowsHtml}</div>
      <div class="repair-report-section">
        <div class="repair-report-label">Repair-added face ids (isRepairFace)</div>
        <div class="repair-report-ids">${escapeHtml(repairIds)}</div>
      </div>
      <div class="repair-report-section">
        <div class="repair-report-label">Warnings</div>
        ${warnings}
      </div>
    `;
  }

  _dismiss() {
    clearTimeout(this.hideTimer);
    this.container?.classList.remove('active');
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
