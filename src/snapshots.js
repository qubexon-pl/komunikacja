"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const zlib = require("node:zlib");

const gzip = promisify(zlib.gzip);
const JSON_TYPE = "application/json; charset=utf-8";

// A snapshot is one prepared dataset in the database. Background jobs write them, and visitors only ever read them.
async function packSnapshot(content, type = JSON_TYPE) {
  const body = await gzip(Buffer.isBuffer(content) ? content : JSON.stringify(content));
  return { body, type, etag: `"${crypto.createHash("sha256").update(body).digest("hex").slice(0, 32)}"` };
}

const ageOf = (info, now) => now - new Date(info.fetchedAt).getTime();

module.exports = { ageOf, packSnapshot };
