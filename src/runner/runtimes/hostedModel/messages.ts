/**
 * The fixed sentences the hosted-model runtime reports a failure with (a `run.failed` message). A provider's own error text, body or
 * header is never kept, shown or logged: every failure is one of these, so a person (and main's mapping to its own fixed copy) can
 * rely on them. Codes: `auth` for a rejected or missing key, `limit` for quota or rate exhaustion, `runtime_error` otherwise.
 */
export const MSG = Object.freeze({
  keyMissing: 'no API key was given for this turn',
  keyRejected: 'the model provider rejected the API key',
  rateLimited: 'the model provider is rate limiting requests and the turn ran out of time to wait',
  quotaExhausted: 'the free quota of the model provider is used up for now',
  modelUnavailable: 'the chosen model is not available from the model provider',
  notChosen: 'this runtime needs a model provider and a model to be chosen',
  notGranted: 'the model provider is not one that was granted',
  contextTooLong: 'the conversation is too long for the model even after trimming it',
  noProxy: 'no egress proxy is running for this turn',
  proxyRefused: 'the egress proxy refused the connection to the model provider',
  unreachable: 'the model provider could not be reached',
  tlsFailed: 'the connection to the model provider could not be secured',
  timeout: 'the model provider did not answer in time',
  tooLarge: 'the model provider answered with more than the allowed size',
  redirect: 'the model provider answered with a redirect, which is refused',
  badJson: 'the model provider sent an answer that could not be read',
  refused: 'the model provider refused the request (the model may not support tool calls)',
  cancelled: 'the model provider request was cancelled',
  server: (status: number): string => `the model provider reported an error (HTTP ${Number.isInteger(status) ? status : 0})`
});
