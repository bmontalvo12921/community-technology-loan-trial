import { readFile } from "node:fs/promises";
import { db } from "./db.js";

try {
  const sql = await readFile(
    new URL("../inventory-schema.sql", import.meta.url),
    "utf8",
  );

  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await db.query(statement);
  }

  const [tables] = await db.query("SHOW TABLES");
  console.log("Schema applied successfully.");
  console.log(tables);
} catch (error) {
  console.error(
    "Schema setup failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}