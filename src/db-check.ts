
import { db, verifyDatabaseConnection } from "./db.js";

try {
  await verifyDatabaseConnection();

 const [rows] = await db.query("SHOW TABLES");

  console.log("MySQL connection successful.");
  console.log(rows);
} catch (error) {
  console.error(
    "MySQL connection failed:",
    error instanceof Error ? error.message : "Unknown error"
  );

  process.exitCode = 1;
} finally {
  await db.end();
}
