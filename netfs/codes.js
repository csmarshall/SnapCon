// netfs/codes.js — errors that mean "the storage did not answer", not "the
// file is wrong". Shared by NetFs.js (the availability breaker) and
// netfs-worker.js (which must not mistake an unreachable share for a missing
// file). UNKNOWN is what Windows returns for an unreachable or missing SMB share.
"use strict";
const NETWORK_CODES = new Set(["UNKNOWN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ENETDOWN",
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTCONN", "EPIPE", "EIO", "EBADNETPATH", "ENONET"]);

module.exports = { NETWORK_CODES };
