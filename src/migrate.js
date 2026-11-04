"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const sql = require("mssql");
const { createSqlConfig } = require("./database");

async function migrate() {
  const schema = await fs.readFile(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
  const batches = schema.split(/^\s*GO\s*$/gim).map((batch) => batch.trim()).filter(Boolean);
  const pool = await new sql.ConnectionPool(createSqlConfig()).connect();
  try {
    for (const batch of batches) await pool.request().batch(batch);
    console.log(`Applied ${batches.length} idempotent schema batches.`);
  } finally {
    await pool.close();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error("Database migration failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
