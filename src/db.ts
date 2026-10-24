
import mysql from "mysql2/promise";

const port = Number(process.env.DB_PORT ?? 3306);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("DB_PORT must be a valid TCP port");
}

export const db = mysql.createPool({
  host: process.env.DB_HOST ?? "localhost",
  port,
  database: process.env.DB_NAME ?? "community_technology_loan",
  user: process.env.DB_USER ?? "root",
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 10,
  enableKeepAlive: true,
  charset: "utf8mb4",
  timezone: "Z",
});

export async function verifyDatabaseConnection(): Promise<void> {
  const connection = await db.getConnection();

  try {
    await connection.ping();
  } finally {
    connection.release();
  }
}
