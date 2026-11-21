// One JSON object per line: Cloud Logging reads `severity`, `message` and `httpRequest` from it with no agent or library.
export function log(severity, message, fields = {}) {
  const line = JSON.stringify({ severity, message, ...fields });
  if (severity === 'ERROR' || severity === 'WARNING') console.error(line);
  else console.log(line);
}
