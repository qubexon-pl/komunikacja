"use strict";

const sql = require("mssql");
const { createSqlConfig, readFlightFares, replaceFlightFares } = require("./database");
const { createFlightStore, readFareFile } = require("./flights");

async function importFile(file) {
  const pool = await new sql.ConnectionPool(createSqlConfig()).connect();
  try {
    const store = createFlightStore({
      database: { readFares: (day) => readFlightFares(pool, day), replaceFares: (rows) => replaceFlightFares(pool, rows) },
    });
    const rows = await readFareFile(file, new Date().toISOString().slice(0, 10));
    const { received, stored } = await store.importRows(rows);
    console.log(`Stored ${stored} of ${received} fares for the next two weeks.`);
  } finally {
    await pool.close();
  }
}

if (require.main === module) {
  const file = process.argv[2] || process.env.FLIGHT_FARES_FILE;
  if (!file) {
    console.error("Usage: npm run flights:import -- <flights.db or fares.json>");
    process.exitCode = 1;
  } else {
    importFile(file).catch((error) => {
      console.error("Flight import failed:", error.message);
      process.exitCode = 1;
    });
  }
}
