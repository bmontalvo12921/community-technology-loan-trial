// Idempotent first-run setup: creates missing tables, migrates legacy login
// fields into user_auth, and seeds default access templates and accounts.
import { db } from "./db.js";
import { hashPassword } from "./password.js";
import { createAccount, ROLE_PERMISSIONS, type AuthRole } from "./auth-service.js";

const TENANT_ID = "city-of-orlando";

const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS access_templates (
    template_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    template_name VARCHAR(100) NOT NULL,
    description VARCHAR(255) NULL,
    PRIMARY KEY (template_id),
    KEY idx_access_templates_tenant (tenant_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS access_template_permissions (
    tenant_id VARCHAR(100) NOT NULL,
    template_id INT UNSIGNED NOT NULL,
    permission_key VARCHAR(100) NOT NULL,
    PRIMARY KEY (tenant_id, template_id, permission_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS outreach_centers (
    center_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    center_name VARCHAR(100) NOT NULL,
    address VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (center_id),
    UNIQUE KEY uq_centers_tenant_id (tenant_id, center_id),
    UNIQUE KEY uq_centers_tenant_name (tenant_id, center_name)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS devices (
    device_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    asset_tag VARCHAR(50) NOT NULL,
    serial_number VARCHAR(100) NOT NULL,
    device_type ENUM('LAPTOP','TABLET','HOTSPOT') NOT NULL,
    manufacturer VARCHAR(100) NOT NULL,
    model VARCHAR(100) NOT NULL,
    status ENUM('AVAILABLE','CHECKED_OUT','MAINTENANCE') NOT NULL,
    center_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (device_id),
    UNIQUE KEY uq_devices_tenant_asset (tenant_id, asset_tag),
    UNIQUE KEY uq_devices_tenant_serial (tenant_id, serial_number),
    UNIQUE KEY uq_devices_tenant_id (tenant_id, device_id),
    KEY idx_devices_tenant_center (tenant_id, center_id),
    CONSTRAINT fk_devices_center FOREIGN KEY (tenant_id, center_id)
      REFERENCES outreach_centers (tenant_id, center_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS loan_reasons (
    reason_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    reason_name VARCHAR(100) NOT NULL,
    PRIMARY KEY (reason_id),
    UNIQUE KEY uq_reasons_tenant_id (tenant_id, reason_id),
    UNIQUE KEY uq_reasons_tenant_name (tenant_id, reason_name)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS loans (
    loan_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    device_id INT UNSIGNED NOT NULL,
    center_id INT UNSIGNED NOT NULL,
    reason_id INT UNSIGNED NOT NULL,
    participant_code VARCHAR(100) NOT NULL,
    checkout_date DATETIME NOT NULL,
    due_date DATETIME NOT NULL,
    return_date DATETIME NULL,
    loan_status ENUM('ACTIVE','RETURNED','OVERDUE') NOT NULL DEFAULT 'ACTIVE',
    PRIMARY KEY (loan_id),
    UNIQUE KEY uq_loans_tenant_id (tenant_id, loan_id),
    KEY idx_loans_tenant_device_status (tenant_id, device_id, loan_status),
    KEY idx_loans_tenant_center (tenant_id, center_id),
    CONSTRAINT fk_loans_device FOREIGN KEY (tenant_id, device_id)
      REFERENCES devices (tenant_id, device_id),
    CONSTRAINT fk_loans_center FOREIGN KEY (tenant_id, center_id)
      REFERENCES outreach_centers (tenant_id, center_id),
    CONSTRAINT fk_loans_reason FOREIGN KEY (tenant_id, reason_id)
      REFERENCES loan_reasons (tenant_id, reason_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS maintenance_records (
    maintenance_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    device_id INT UNSIGNED NOT NULL,
    issue_description VARCHAR(1000) NOT NULL,
    service_date DATE NOT NULL,
    resolved_date DATE NULL,
    maintenance_status ENUM('OPEN','IN_PROGRESS','RESOLVED') NOT NULL DEFAULT 'OPEN',
    PRIMARY KEY (maintenance_id),
    UNIQUE KEY uq_maintenance_tenant_id (tenant_id, maintenance_id),
    KEY idx_maintenance_tenant_device_status (tenant_id, device_id, maintenance_status),
    CONSTRAINT fk_maintenance_device FOREIGN KEY (tenant_id, device_id)
      REFERENCES devices (tenant_id, device_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    role ENUM('ADMIN','STAFF','USER') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    access_template_id INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_tenant_email (tenant_id, email),
    UNIQUE KEY uq_users_tenant_id (tenant_id, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS user_auth (
    user_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    failed_login_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    last_login_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, user_id),
    UNIQUE KEY uq_user_auth_tenant_email (tenant_id, email),
    CONSTRAINT fk_user_auth_user FOREIGN KEY (tenant_id, user_id)
      REFERENCES users (tenant_id, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS security_audit_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    user_id BIGINT UNSIGNED NULL,
    event_type VARCHAR(100) NOT NULL,
    event_status VARCHAR(100) NOT NULL,
    details JSON NULL,
    request_id VARCHAR(100) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_audit_tenant_user (tenant_id, user_id)
  ) ENGINE=InnoDB`,
];

// Equipment requests made by regular users and reviewed by staff.
const REQUESTS_TABLE = `CREATE TABLE IF NOT EXISTS equipment_requests (
    request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    center_id INT UNSIGNED NOT NULL,
    device_type ENUM('LAPTOP','TABLET','HOTSPOT') NOT NULL,
    reason_id INT UNSIGNED NULL,
    details VARCHAR(1000) NOT NULL,
    status ENUM('PENDING','APPROVED','DENIED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (request_id),
    KEY idx_requests_tenant_center (tenant_id, center_id),
    KEY idx_requests_tenant_user (tenant_id, user_id),
    KEY idx_requests_tenant_status (tenant_id, status)
  ) ENGINE=InnoDB`;

// Upgrades for databases created before regular user accounts existed.
async function migrateForUserAccounts(): Promise<void> {
  await db.query(
    "ALTER TABLE users MODIFY role ENUM('ADMIN','STAFF','USER') NOT NULL",
  );

  const [templateColumn] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'users'
        AND column_name = 'access_template_id'`,
  );
  if (Number((templateColumn as { n: number }[])[0]?.n ?? 0) === 0) {
    await db.query("ALTER TABLE users ADD COLUMN access_template_id INT UNSIGNED NULL");
    console.log("Added users.access_template_id.");
  }

  // Move legacy credential data into user_auth. Existing auth rows stay authoritative.
  const [passwordColumn] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'users'
        AND column_name = 'password_hash'`,
  );
  if (Number((passwordColumn as { n: number }[])[0]?.n ?? 0) > 0) {
    await db.query(
      `INSERT IGNORE INTO user_auth
         (user_id, tenant_id, email, password_hash, is_active,
          failed_login_attempts, locked_at, last_login_at, created_at)
       SELECT id, tenant_id, email, password_hash, is_active,
              failed_login_attempts, locked_at, last_login_at, created_at
         FROM users
        WHERE password_hash IS NOT NULL AND password_hash <> ''`,
    );
  }

  const [missingAuth] = await db.execute(
    `SELECT COUNT(*) AS n
       FROM users u
       LEFT JOIN user_auth a ON a.tenant_id = u.tenant_id AND a.user_id = u.id
      WHERE a.user_id IS NULL`,
  );
  const usersWithoutAuth = Number((missingAuth as { n: number }[])[0]?.n ?? 0);
  if (usersWithoutAuth > 0) {
    throw new Error(
      `Cannot finish separating authentication: ${usersWithoutAuth} user profile(s) have no user_auth row.`,
    );
  }

  const authOnlyColumns = [
    "password_hash",
    "is_active",
    "failed_login_attempts",
    "locked_at",
    "last_login_at",
  ];
  const [legacyAuthColumns] = await db.execute(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'users'
        AND column_name IN
          ('password_hash', 'is_active', 'failed_login_attempts', 'locked_at', 'last_login_at')`,
  );
  const columnsToDrop = (legacyAuthColumns as { column_name: string }[])
    .map((row) => row.column_name)
    .filter((column) => authOnlyColumns.includes(column));
  if (columnsToDrop.length) {
    await db.query(
      `ALTER TABLE users ${columnsToDrop.map((column) => `DROP COLUMN ${column}`).join(", ")}`,
    );
    console.log("Moved authentication fields from users into user_auth.");
  }

  const [cols] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'loans'
        AND column_name = 'user_id'`,
  );
  if (Number((cols as { n: number }[])[0]?.n ?? 0) === 0) {
    await db.query(
      "ALTER TABLE loans ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER participant_code, ADD KEY idx_loans_tenant_user (tenant_id, user_id)",
    );
    console.log("Added loans.user_id.");
  }

  await db.query(REQUESTS_TABLE);

  // Report the live shape of the table so a mismatch with this code is visible in the deploy logs.
  const [shape] = await db.query(
    `SELECT column_name AS c, column_type AS t, is_nullable AS n
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'equipment_requests'
      ORDER BY ordinal_position`,
  );
  console.log(
    "equipment_requests columns: " +
      (shape as { c: string; t: string; n: string }[])
        .map((r) => `${r.c} ${r.t}${r.n === "NO" ? " NOT NULL" : ""}`)
        .join(", "),
  );
}

const ACCESS_ROLES: AuthRole[] = ["USER", "STAFF", "ADMIN"];

async function ensureAccessTemplates(): Promise<void> {
  const templatesCreatedNow: number[] = [];
  for (const role of ACCESS_ROLES) {
    const [insert] = await db.execute(
      `INSERT INTO access_templates (tenant_id, template_name, description)
       SELECT ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM access_templates
           WHERE tenant_id = ? AND UPPER(template_name) = ?
        )`,
      [TENANT_ID, role, `Default permissions for ${role.toLowerCase()} accounts.`, TENANT_ID, role],
    );
    const created = (insert as { affectedRows: number }).affectedRows > 0;

    const [rows] = await db.execute(
      `SELECT template_id FROM access_templates
        WHERE tenant_id = ? AND UPPER(template_name) = ?
        ORDER BY template_id LIMIT 1`,
      [TENANT_ID, role],
    );
    const templateId = Number((rows as { template_id: number }[])[0]?.template_id);
    if (!templateId) throw new Error(`Could not create the ${role} access template`);
    if (created) templatesCreatedNow.push(templateId);

    // Seed newly-created or empty default templates. Once a template has any
    // permission rows, preserve its contents so edits are not overwritten.
    const [permissionRows] = await db.execute(
      `SELECT COUNT(*) AS n FROM access_template_permissions
        WHERE tenant_id = ? AND template_id = ?`,
      [TENANT_ID, templateId],
    );
    const hasPermissions = Number((permissionRows as { n: number }[])[0]?.n ?? 0) > 0;
    if (created || !hasPermissions) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        await db.execute(
          `INSERT IGNORE INTO access_template_permissions
             (tenant_id, template_id, permission_key)
           VALUES (?, ?, ?)`,
          [TENANT_ID, templateId, permission],
        );
      }
    }
  }

  // Keep valid custom assignments. Repair missing ids and ids that collided with
  // newly-created default templates after an earlier table reset.
  const newlyCreatedCondition = templatesCreatedNow.length
    ? ` OR assigned_template.template_id IN (${templatesCreatedNow.map(() => "?").join(", ")})`
    : "";
  await db.execute(
    `UPDATE users u
       JOIN access_templates role_template
         ON role_template.tenant_id = u.tenant_id
        AND UPPER(role_template.template_name) = u.role
       LEFT JOIN access_templates assigned_template
         ON assigned_template.tenant_id = u.tenant_id
        AND assigned_template.template_id = u.access_template_id
        SET u.access_template_id = role_template.template_id
      WHERE assigned_template.template_id IS NULL${newlyCreatedCondition}`,
    templatesCreatedNow,
  );
  console.log("Default access templates and permissions are in place.");
}

const DEFAULT_REASONS = [
  "Job search",
  "School or education",
  "Telehealth or medical appointment",
  "Government services",
  "Other",
];

// Loans need a reason, so start new databases with a few. Only runs when
// the tenant has none, so reasons that were renamed are never re-added.
async function ensureLoanReasons(): Promise<void> {
  const [rows] = await db.execute(
    "SELECT COUNT(*) AS n FROM loan_reasons WHERE tenant_id = ?",
    [TENANT_ID],
  );

  if (Number((rows as { n: number }[])[0]?.n ?? 0) > 0) return;

  for (const name of DEFAULT_REASONS) {
    await db.execute(
      "INSERT IGNORE INTO loan_reasons (tenant_id, reason_name) VALUES (?, ?)",
      [TENANT_ID, name],
    );
  }
  console.log("Added default loan reasons.");
}

async function ensureAccount(
  role: "ADMIN" | "STAFF",
  email: string | undefined,
  password: string | undefined,
): Promise<void> {
  if (!email || !password) return;

  const normalized = email.trim().toLowerCase();
  const [existingProfiles] = await db.execute(
    `SELECT id FROM users
      WHERE tenant_id = ? AND email = ?
      LIMIT 1`,
    [TENANT_ID, normalized],
  );
  if ((existingProfiles as { id: number }[]).length > 0) {
    console.log(`${role} account ${normalized}: already exists`);
    return;
  }

  const hash = await hashPassword(password);

  const result = await createAccount(TENANT_ID, normalized, hash, role);
  const created = result.success;
  console.log(
    `${role} account ${normalized}: ${created ? "created" : "already exists"}`,
  );
}

try {
  for (const statement of TABLES) {
    await db.query(statement);
  }
  await migrateForUserAccounts();
  await ensureAccessTemplates();
  console.log("Database tables are in place.");
  await ensureLoanReasons();

  await ensureAccount(
    "ADMIN",
    process.env.SETUP_ADMIN_EMAIL,
    process.env.SETUP_ADMIN_PASSWORD,
  );
  await ensureAccount(
    "STAFF",
    process.env.SETUP_STAFF_EMAIL,
    process.env.SETUP_STAFF_PASSWORD,
  );
} catch (error) {
  console.error(
    "Database setup failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
