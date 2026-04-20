export function nowIso() {
  return new Date().toISOString();
}

export function elapsedSeconds(start: number) {
  return Number(((Date.now() - start) / 1000).toFixed(3));
}

export function createRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${suffix}`;
}
