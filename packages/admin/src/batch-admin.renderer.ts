import type { JobDefinition, JobExecution } from '@nest-batch/core';

export interface BatchAdminDashboardModel {
  readonly jobs: readonly JobDefinition[];
  readonly executions: readonly JobExecution[];
}

export function renderBatchAdminHtml(model: BatchAdminDashboardModel): string {
  const jobRows = model.jobs
    .map(
      (job) =>
        `<tr><td>${escapeHtml(job.id)}</td><td>${escapeHtml(job.startStepId)}</td><td>${Object.keys(job.steps).length}</td></tr>`,
    )
    .join('');
  const executionRows = model.executions
    .map(
      (execution) =>
        `<tr><td>${escapeHtml(execution.id)}</td><td>${escapeHtml(execution.jobInstanceId)}</td><td>${escapeHtml(execution.status)}</td><td>${formatDate(execution.startTime)}</td><td>${formatDate(execution.endTime)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>nest-batch admin</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f7f8fa;color:#1f2937}
    header{background:#111827;color:#fff;padding:16px 24px}
    main{padding:24px;display:grid;gap:24px}
    section{background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
    h1{font-size:20px;margin:0}
    h2{font-size:16px;margin:0;padding:16px;border-bottom:1px solid #e5e7eb}
    table{width:100%;border-collapse:collapse;font-size:14px}
    th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eef0f3}
    th{background:#f9fafb;font-weight:600}
  </style>
</head>
<body>
  <header><h1>nest-batch admin</h1></header>
  <main>
    <section>
      <h2>Jobs</h2>
      <table><thead><tr><th>ID</th><th>Start Step</th><th>Steps</th></tr></thead><tbody>${jobRows}</tbody></table>
    </section>
    <section>
      <h2>Recent Executions</h2>
      <table><thead><tr><th>ID</th><th>Instance</th><th>Status</th><th>Started</th><th>Ended</th></tr></thead><tbody>${executionRows}</tbody></table>
    </section>
  </main>
</body>
</html>`;
}

function formatDate(value: Date | null): string {
  return value === null ? '' : escapeHtml(value.toISOString());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
