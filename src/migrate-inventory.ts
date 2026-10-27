
import { db } from "./db.js";

async function migrateInventory(): Promise<void> {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Add the composite key required for tenant-scoped device references.
    const [deviceIndexes] = await connection.query<any[]>(
      `SHOW INDEX FROM devices WHERE Key_name = 'uq_devices_tenant_id'`
    );

    if (deviceIndexes.length === 0) {
      await connection.query(`
        ALTER TABLE devices
        ADD UNIQUE KEY uq_devices_tenant_id (tenant_id, device_id)
      `);
    }

    // Loan reasons.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS loan_reasons (
        reason_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id VARCHAR(100) NOT NULL,
        reason_name VARCHAR(100) NOT NULL,
        PRIMARY KEY (reason_id),
        UNIQUE KEY uq_reasons_tenant_id (tenant_id, reason_id),
        UNIQUE KEY uq_reasons_tenant_name (tenant_id, reason_name)
      ) ENGINE=InnoDB
    `);

    // Device loans.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS loans (
        loan_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id VARCHAR(100) NOT NULL,
        device_id INT UNSIGNED NOT NULL,
        center_id INT UNSIGNED NOT NULL,
        reason_id INT UNSIGNED NOT NULL,
        participant_code VARCHAR(100) NOT NULL,
        checkout_date DATETIME NOT NULL,
        due_date DATETIME NOT NULL,
        return_date DATETIME NULL,
        loan_status ENUM('ACTIVE', 'RETURNED', 'OVERDUE')
          NOT NULL DEFAULT 'ACTIVE',
        PRIMARY KEY (loan_id),
        UNIQUE KEY uq_loans_tenant_id (tenant_id, loan_id),
        KEY idx_loans_tenant_device_status
          (tenant_id, device_id, loan_status),
        KEY idx_loans_tenant_center (tenant_id, center_id),
        CONSTRAINT fk_loans_device
          FOREIGN KEY (tenant_id, device_id)
          REFERENCES devices (tenant_id, device_id),
        CONSTRAINT fk_loans_center
          FOREIGN KEY (tenant_id, center_id)
          REFERENCES outreach_centers (tenant_id, center_id),
        CONSTRAINT fk_loans_reason
          FOREIGN KEY (tenant_id, reason_id)
          REFERENCES loan_reasons (tenant_id, reason_id)
      ) ENGINE=InnoDB
    `);

    // Device maintenance records.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS maintenance_records (
        maintenance_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id VARCHAR(100) NOT NULL,
        device_id INT UNSIGNED NOT NULL,
        issue_description VARCHAR(1000) NOT NULL,
        service_date DATE NOT NULL,
        resolved_date DATE NULL,
        maintenance_status ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED')
          NOT NULL DEFAULT 'OPEN',
        PRIMARY KEY (maintenance_id),
        UNIQUE KEY uq_maintenance_tenant_id (tenant_id, maintenance_id),
        KEY idx_maintenance_tenant_device_status
          (tenant_id, device_id, maintenance_status),
        CONSTRAINT fk_maintenance_device
          FOREIGN KEY (tenant_id, device_id)
          REFERENCES devices (tenant_id, device_id)
      ) ENGINE=InnoDB
    `);

    await connection.commit();

    console.log("Inventory database migration completed successfully.");
  } catch (error) {
    await connection.rollback();
    console.error("Inventory database migration failed.");
    throw error;
  } finally {
    connection.release();
    await db.end();
  }
}

migrateInventory().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

