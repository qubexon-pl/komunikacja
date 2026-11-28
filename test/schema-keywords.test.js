"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");

// T-SQL reserved words used as column names must be bracketed, or `npm run db:migrate` stops with
// "Incorrect syntax near the keyword ..." and every later batch is skipped.
test("dbo.TripAiPlan.plan is bracketed in the schema and in its queries", () => {
  assert.match(read("database/schema.sql"), /^\s+\[plan\] NVARCHAR\(MAX\) NOT NULL/m);
  const q = read("src/ai-planner.js");
  assert.match(q, /SELECT \[plan\], created_at FROM dbo\.TripAiPlan/);
  assert.match(q, /SET \[plan\] = @plan/);
  assert.match(q, /INSERT INTO dbo\.TripAiPlan \(user_id, trip_id, city, \[plan\], model\)/);
});
