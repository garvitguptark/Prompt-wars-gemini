// One JSON object per line: Cloud Logging reads `severity`, `message` and `httpRequest` from it with no agent or library.
/** @import { Severity } from './types.js' */

/**
 * Writes one structured log line: warnings and errors to stderr, everything else to stdout.
 * @param {Severity} severity
 * @param {string} message
 * @param {object} [fields]  extra structured fields, such as `httpRequest`
 */
export function log(severity, message, fields = {}) {
  const line = JSON.stringify({ severity, message, ...fields });
  if (severity === 'ERROR' || severity === 'WARNING') console.error(line);
  else console.log(line);
}
