const mysql = require("mysql2/promise");

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    for (const table of ["devices", "outreach_centers", "loan_reasons"]) {
      const [rows] = await db.query(
        `SELECT * FROM \`${table}\``
      );

      console.log(`\nTABLE: ${table}`);
      console.table(rows);
    }
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error("Database check failed:", error.message);
  process.exitCode = 1;
});