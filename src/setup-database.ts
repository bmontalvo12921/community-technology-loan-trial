// Idempotent first-run setup: creates missing tables and, when the
// SETUP_* variables are present, the first admin and staff accounts.
// Safe to run on every start. Existing tables and accounts are untouched.
import { db } from "./db.js";
import { hashPassword } from "./password.js";

const TENANT_ID = "city-of-orlando";

const TABLES: string[] = [
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
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('ADMIN','STAFF','USER') NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    failed_login_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    last_login_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_tenant_email (tenant_id, email)
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
    device_type ENUM('LAPTOP','TABLET','HOTSPOT') NOT NULL,
    reason_id INT UNSIGNED NULL,
    reason_text VARCHAR(1000) NOT NULL,
    status ENUM('PENDING','APPROVED','DENIED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    loan_id INT UNSIGNED NULL,
    reviewed_by BIGINT UNSIGNED NULL,
    review_note VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (request_id),
    KEY idx_requests_tenant_user (tenant_id, user_id),
    KEY idx_requests_tenant_status (tenant_id, status)
  ) ENGINE=InnoDB`;

// Upgrades for databases created before regular user accounts existed.
async function migrateForUserAccounts(): Promise<void> {
  await db.query(
    "ALTER TABLE users MODIFY role ENUM('ADMIN','STAFF','USER') NOT NULL",
  );

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
  const hash = await hashPassword(password);

  const [result] = await db.execute(
    `INSERT IGNORE INTO users
       (tenant_id, email, password_hash, role, is_active)
     VALUES (?, ?, ?, ?, 1)`,
    [TENANT_ID, normalized, hash, role],
  );

  const created = (result as { affectedRows: number }).affectedRows > 0;
  console.log(
    `${role} account ${normalized}: ${created ? "created" : "already exists"}`,
  );
}

try {
  for (const statement of TABLES) {
    await db.query(statement);
  }
  await migrateForUserAccounts();
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
