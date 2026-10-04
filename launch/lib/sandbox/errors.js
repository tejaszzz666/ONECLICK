'use strict';

class SandboxError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const SANDBOX_STATUS = {
  sandbox_disabled: 503,
  unauthorized: 401,
  forbidden_host: 403,
  forbidden_origin: 403,
  bad_request: 400,
  unsupported: 422,
  busy: 429,
  docker_unavailable: 503,
  image_missing: 503,
  not_found: 404,
};

module.exports = { SandboxError, SANDBOX_STATUS };
