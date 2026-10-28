import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { db } from "./db.js";
import { verifyPassword } from "./password.js";

const TENANT_ID = "city-of-orlando";
const MAX_FAILED_ATTEMPTS = 3;

export type AuthRole = "ADMIN" | "STAFF" | "USER";

/** Default permissions used to populate the access templates on first setup. */
const USER_PERMISSIONS = [
  "centers:read",
  "loan-reasons:read",
  "my-loans:read",
  "my-requests:read",
  "my-requests:write",
];

const STAFF_PERMISSIONS = [
  "inventory:read",
  "inventory:write",
  "centers:read",
  "loans:read",
  "loans:write",
  "loan-reasons:read",
  "maintenance:read",
  "requests:read",
  "requests:write",
  "users:read",
];

const ADMIN_PERMISSIONS = [
  "inventory:read",
  "inventory:write",
  "centers:read",
  "centers:write",
  "loans:read",
  "loans:write",
  "loans:assign",
  "loan-reasons:read",
  "loan-reasons:write",
  "maintenance:read",
  "maintenance:write",
  "requests:read",
  "requests:write",
  "users:read",
  "users:write",
];

export const ROLE_PERMISSIONS: Record<AuthRole, readonly string[]> = {
  USER: USER_PERMISSIONS,
  STAFF: STAFF_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
};

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  email: string;
  role: AuthRole;
  permissions: string[];
}

interface ProfileRow extends RowDataPacket {
  id: string | number;
  tenant_id: string;
  email: string;
  role: AuthRole;
  access_template_id: number | null;
}

interface AuthRow extends RowDataPacket {
  user_id: string | number;
  tenant_id: string;
  email: string;
  password_hash: string;
  is_active: number | boolean;
  failed_login_attempts: number;
  locked_at: Date | string | null;
}

export { TENANT_ID, MAX_FAILED_ATTEMPTS };

async function permissionsForTemplate(
  connection: import("mysql2/promise").PoolConnection,
  tenantId: string,
  templateId: number,
): Promise<string[]> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT permission_key
       FROM access_template_permissions
      WHERE tenant_id = ? AND template_id = ?
      ORDER BY permission_key`,
    [tenantId, templateId],
  );
  return rows.map((row) => String(row.permission_key));
}

async function templateForRole(
  connection: import("mysql2/promise").PoolConnection,
  tenantId: string,
  role: AuthRole,
): Promise<number> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT template_id
       FROM access_templates
      WHERE tenant_id = ? AND UPPER(template_name) = ?
      ORDER BY template_id
      LIMIT 1`,
    [tenantId, role],
  );
  const templateId = rows[0]?.template_id;
  if (templateId == null) {
    throw new Error(`The ${role} access template is not configured for ${tenantId}`);
  }
  return Number(templateId);
}

export type CreateAccountResult =
  | { success: true; user: AuthenticatedUser }
  | { success: false; reason: "EMAIL_TAKEN" };

/** Creates the profile and its separate authentication row in one transaction. */
export async function createAccount(
  tenantId: string,
  email: string,
  passwordHash: string,
  role: AuthRole,
): Promise<CreateAccountResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const templateId = await templateForRole(connection, tenantId, role);
    const [legacyColumns] = await connection.execute<RowDataPacket[]>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'users'
          AND column_name IN
            ('password_hash', 'is_active', 'failed_login_attempts', 'locked_at', 'last_login_at', 'created_at')`,
    );
    const available = new Set(legacyColumns.map((row) => String(row.column_name)));
    const profileColumns = ["tenant_id", "email", "role", "access_template_id"];
    const profileExpressions = ["?", "?", "?", "?"];
    const profileValues: (string | number | null)[] = [tenantId, normalizedEmail, role, templateId];
    const addLegacyField = (name: string, expression: string, value?: string | number | null) => {
      if (!available.has(name)) return;
      profileColumns.push(name);
      profileExpressions.push(expression);
      if (expression === "?") profileValues.push(value ?? null);
    };
    // Older installs keep these columns on users. Leave harmless placeholders there;
    // password hashes and login state are stored and read only from user_auth.
    addLegacyField("password_hash", "?", "");
    addLegacyField("is_active", "?", 1);
    addLegacyField("failed_login_attempts", "?", 0);
    addLegacyField("locked_at", "?", null);
    addLegacyField("last_login_at", "?", null);
    addLegacyField("created_at", "CURRENT_TIMESTAMP");
    const [insert] = await connection.execute<ResultSetHeader>(
      `INSERT INTO users (${profileColumns.join(", ")})
       VALUES (${profileExpressions.join(", ")})`,
      profileValues,
    );
    const userId = String(insert.insertId);

    await connection.execute(
      `INSERT INTO user_auth
         (user_id, tenant_id, email, password_hash, is_active,
          failed_login_attempts, locked_at, last_login_at, created_at)
       VALUES (?, ?, ?, ?, 1, 0, NULL, NULL, CURRENT_TIMESTAMP)`,
      [userId, tenantId, normalizedEmail, passwordHash],
    );

    const permissions = await permissionsForTemplate(connection, tenantId, templateId);
    await connection.commit();
    transactionStarted = false;

    return {
      success: true,
      user: { id: userId, tenantId, email: normalizedEmail, role, permissions },
    };
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      return { success: false, reason: "EMAIL_TAKEN" };
    }
    throw error;
  } finally {
    connection.release();
  }
}

export type LoginFailureReason =
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_INACTIVE";

export type LoginResult =
  | { success: true; user: AuthenticatedUser }
  | { success: false; reason: LoginFailureReason };

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
    const [authRows] = await connection.execute<AuthRow[]>(
      `SELECT user_id, tenant_id, email, password_hash, is_active,
              failed_login_attempts, locked_at
         FROM user_auth
        WHERE tenant_id = ? AND email = ?
        LIMIT 1 FOR UPDATE`,
      [TENANT_ID, normalizedEmail],
    );
    const auth = authRows[0];

    if (!auth) {
      await writeAuthAudit(connection, null, "LOGIN_FAILURE", "INVALID_CREDENTIALS", requestId);
      await connection.commit();
      transactionStarted = false;
      return { success: false, reason: "INVALID_CREDENTIALS" };
    }

    const userId = String(auth.user_id);
    const [profileRows] = await connection.execute<ProfileRow[]>(
      `SELECT id, tenant_id, email, role, access_template_id
         FROM users
        WHERE tenant_id = ? AND id = ?
        LIMIT 1 FOR UPDATE`,
      [TENANT_ID, userId],
    );
    const profile = profileRows[0];

    if (!profile) {
      await writeAuthAudit(connection, userId, "LOGIN_FAILURE", "INVALID_CREDENTIALS", requestId);
      await connection.commit();
      transactionStarted = false;
      return { success: false, reason: "INVALID_CREDENTIALS" };
    }

    if (auth.locked_at !== null) {
      await writeAuthAudit(connection, userId, "LOGIN_FAILURE", "ACCOUNT_LOCKED", requestId);
      await connection.commit();
      transactionStarted = false;
      return { success: false, reason: "ACCOUNT_LOCKED" };
    }

    if (!auth.is_active) {
      await writeAuthAudit(connection, userId, "LOGIN_FAILURE", "ACCOUNT_INACTIVE", requestId);
      await connection.commit();
      transactionStarted = false;
      return { success: false, reason: "ACCOUNT_INACTIVE" };
    }

    const passwordMatches = await verifyPassword(password, auth.password_hash);
    if (!passwordMatches) {
      const nextAttempts = Number(auth.failed_login_attempts) + 1;
      const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;
      await connection.execute(
        `UPDATE user_auth
            SET failed_login_attempts = ?,
                locked_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE locked_at END
          WHERE tenant_id = ? AND user_id = ?`,
        [nextAttempts, shouldLock, TENANT_ID, userId],
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
      return { success: false, reason: shouldLock ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS" };
    }

    let templateId = profile.access_template_id;
    if (templateId == null) {
      templateId = await templateForRole(connection, TENANT_ID, profile.role);
      await connection.execute(
        "UPDATE users SET access_template_id = ? WHERE tenant_id = ? AND id = ?",
        [templateId, TENANT_ID, userId],
      );
    }
    const permissions = await permissionsForTemplate(connection, TENANT_ID, Number(templateId));

    await connection.execute(
      `UPDATE user_auth
          SET failed_login_attempts = 0, last_login_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND user_id = ?`,
      [TENANT_ID, userId],
    );
    await writeAuthAudit(connection, userId, "LOGIN_SUCCESS", "SUCCESS", requestId);
    await connection.commit();
    transactionStarted = false;

    return {
      success: true,
      user: {
        id: userId,
        tenantId: profile.tenant_id,
        email: auth.email,
        role: profile.role,
        permissions,
      },
    };
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export type RegisterResult =
  | { success: true; user: AuthenticatedUser }
  | { success: false; reason: "EMAIL_TAKEN" };

/** Self-service sign-up always creates a regular USER account. */
export async function registerUser(
  email: string,
  passwordHash: string,
  requestId: string | null,
): Promise<RegisterResult> {
  const result = await createAccount(TENANT_ID, email, passwordHash, "USER");
  if (!result.success) return result;

  await db.execute(
    `INSERT INTO security_audit_log
       (tenant_id, user_id, event_type, event_status, details, request_id)
     VALUES (?, ?, 'ACCOUNT_REGISTERED', 'SUCCESS', ?, ?)`,
    [TENANT_ID, result.user.id, JSON.stringify({ source: "api-register" }), requestId],
  );
  return result;
}
