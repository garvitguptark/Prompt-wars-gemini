// Every error the server answers with carries its HTTP status, so the HTTP layer never has to guess. Only the
// messages of 4xx errors, which we write ourselves, ever reach the browser; `detail` is for the logs.

/** An error with the HTTP status to answer with, plus optional response headers and a log-only detail. */
export class HttpError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} message  safe to show people when the status is 4xx
   * @param {{ headers?: Record<string, string>, detail?: string }} [options]
   */
  constructor(status, message, { headers = {}, detail } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.headers = headers;
    this.detail = detail;
  }
}

/** Input from the browser failed validation (400). */
export class InputError extends HttpError {
  /** @param {string} message */
  constructor(message) {
    super(400, message);
  }
}

/** A searched-for place does not exist (404). */
export class PlaceNotFound extends HttpError {
  /** @param {string} message */
  constructor(message) {
    super(404, message);
  }
}

/** An air-quality provider failed or answered badly (502). */
export class UpstreamError extends HttpError {
  /** @param {string} detail  what went wrong, for the logs */
  constructor(detail) {
    super(502, 'Air-quality data is unavailable right now. Please try again in a minute.', { detail });
  }
}

/** A service the request needs, such as Gemini, is switched off or not answering (503). */
export class ServiceUnavailable extends HttpError {
  /** @param {string} message */
  constructor(message) {
    super(503, message);
  }
}
