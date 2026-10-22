
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { db } from "./db.js";
import { verifyPassword } from "./password.js";

const TENANT_ID = "city-of-orlando";
const MAX_FAILED_ATTEMPTS = 3;

export type AuthRole = "ADMIN" | "STAFF";

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  email: string;
  role: AuthRole;
}

interface UserRow extends RowDataPacket {
  id: string | number;
  tenant_id: string;
  email: string;
  password_hash: string;
  role: AuthRole;
  is_active: number | boolean;
  failed_login_attempts: number;
  locked_at: Date | string | null;
}

export { TENANT_ID, MAX_FAILED_ATTEMPTS };

export async function findUserByEmail(
  email: string,
): Promise<UserRow | null> {
  const normalizedEmail = email.trim().toLowerCase();

  const [rows] = await db.execute<UserRow[]>(
    `SELECT
       id,
       tenant_id,
       email,
       password_hash,
       role,
       is_active,
       failed_login_attempts,
       locked_at
     FROM users
     WHERE tenant_id = ? AND email = ?
     LIMIT 1`,
    [TENANT_ID, normalizedEmail],
  );

  return rows[0] ?? null;
}
export type LoginFailureReason =
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_INACTIVE";

export type LoginResult =
  | {
      success: true;
      user: AuthenticatedUser;
    }
  | {
      success: false;
      reason: LoginFailureReason;
    };

async function writeAuthAudit(
  connection: import("mysql2/promise").PoolConnection,
  userId: string | null,
  eventType: string,
  eventStatus: string,
  requestId: string | null,
): Promise<void> {
  await connection.execute(
    `INSERT INTO security_audit_log
       (tenant_id, user_id, event_type, event_status, details, request_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      TENANT_ID,
      userId,
      eventType,
      eventStatus,
      JSON.stringify({ source: "api-login" }),
      requestId,
    ],
  );
}

export async function authenticateUser(
  email: string,
  password: string,
  requestId: string | null,
): Promise<LoginResult> {
  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const normalizedEmail = email.trim().toLowerCase();

    const [rows] = await connection.execute<UserRow[]>(
      `SELECT
         id,
         tenant_id,
         email,
         password_hash,
         role,
         is_active,
         failed_login_attempts,
         locked_at
       FROM users
       WHERE tenant_id = ? AND email = ?
       LIMIT 1
       FOR UPDATE`,
      [TENANT_ID, normalizedEmail],
    );

    const user = rows[0];

    if (!user) {
      await writeAuthAudit(
        connection,
        null,
        "LOGIN_FAILURE",
        "INVALID_CREDENTIALS",
        requestId,
      );

      await connection.commit();
      transactionStarted = false;

      return { success: false, reason: "INVALID_CREDENTIALS" };
    }

    const userId = String(user.id);

    if (user.locked_at !== null) {
      await writeAuthAudit(
        connection,
        userId,
        "LOGIN_FAILURE",
        "ACCOUNT_LOCKED",
        requestId,
      );

      await connection.commit();
      transactionStarted = false;

      return { success: false, reason: "ACCOUNT_LOCKED" };
    }

    if (!user.is_active) {
      await writeAuthAudit(
        connection,
        userId,
        "LOGIN_FAILURE",
        "ACCOUNT_INACTIVE",
        requestId,
      );

      await connection.commit();
      transactionStarted = false;

      return { success: false, reason: "ACCOUNT_INACTIVE" };
    }

    const passwordMatches = await verifyPassword(
      password,
      user.password_hash,
    );

    if (!passwordMatches) {
      const nextAttempts = user.failed_login_attempts + 1;
      const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;

      await connection.execute(
        `UPDATE users
         SET failed_login_attempts = ?,
             locked_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE locked_at END
         WHERE id = ? AND tenant_id = ?`,
        [nextAttempts, shouldLock, userId, TENANT_ID],
      );

      await writeAuthAudit(
        connection,
        userId,
        shouldLock ? "ACCOUNT_LOCKED" : "LOGIN_FAILURE",
        shouldLock ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS",
        requestId,
      );

      await connection.commit();
      transactionStarted = false;

      return {
        success: false,
        reason: shouldLock ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS",
      };
    }

    await connection.execute(
      `UPDATE users
       SET failed_login_attempts = 0,
           last_login_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`,
      [userId, TENANT_ID],
    );

    await writeAuthAudit(
      connection,
      userId,
      "LOGIN_SUCCESS",
      "SUCCESS",
      requestId,
    );

    await connection.commit();
    transactionStarted = false;

    return {
      success: true,
      user: {
        id: userId,
        tenantId: user.tenant_id,
        email: user.email,
        role: user.role,
      },
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }

    throw error;
  } finally {
    connection.release();
  }
}
