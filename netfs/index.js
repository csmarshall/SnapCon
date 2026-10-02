// netfs/index.js — the one NetFs instance the process shares: server.js
// routes, the printer connectors' uploads and the Library all go through it,
// so its lanes and its availability state are the same everywhere.
"use strict";
const { createNetFs, NasUnreachableError } = require("./NetFs");

let instance = null;
function getNetFs() {
  if (!instance) instance = createNetFs();
  return instance;
}

module.exports = { getNetFs, NasUnreachableError };
