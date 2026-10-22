import { db } from "./src/db.js";

try {
  const tables = [
    "users",
    "devices",
    "outreach_centers",
    "loan_reasons",
    "loans",
    "maintenance_records",
  ];

  for (const table of tables) {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS total FROM \`${table}\``
    );

    console.log(`${table}:`, rows);
  }

  const [users] = await db.query(
    "SELECT id, tenant_id, email, role FROM users"
  );

  console.log("Users:", users);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await db.end();
}