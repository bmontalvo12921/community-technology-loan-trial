
import type {
  CenterQuery,
  CreateCenter,
  CreateDevice,
  CreateLoan,
  CreateMaintenance,
  Device,
  DeviceQuery,
  InventoryRepository,
  Loan,
  LoanQuery,
  LoanReason,
  MaintenanceQuery,
  MaintenanceRecord,
  OutreachCenter,
  Page,
  UpdateCenter,
  UpdateDevice,
  UpdateLoan,
  UpdateMaintenance,
} from "./types.js";

import { db } from "./db.js";
import { RepositoryConflict, RepositoryNotFound } from "./types.js";

type DbRow = Record<string, unknown>;

function numberValue(value: unknown): number {
  return Number(value);
}

function stringValue(value: unknown): string {
  return String(value ?? "");
}

function dateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return stringValue(value);
}

// MySQL DATETIME columns reject ISO strings with a "Z"/offset suffix.
// The pool runs in UTC (see db.ts), so write UTC "YYYY-MM-DD HH:MM:SS".
function toSqlDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

function dateOnlyValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return stringValue(value).slice(0, 10);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function paginate<T extends object>(
  rows: T[],
  cursor: number | undefined,
  limit: number,
  id: keyof T,
): Page<T> {
  const sorted = [...rows].sort(
    (a, b) => Number(a[id]) - Number(b[id]),
  );

  const remaining =
    cursor === undefined
      ? sorted
      : sorted.filter((row) => Number(row[id]) > cursor);

  const items = remaining.slice(0, limit);

  return {
    items,
    nextCursor:
      remaining.length > limit
        ? Number(items.at(-1)?.[id])
        : undefined,
  };
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ER_DUP_ENTRY"
  );
}

function mapCenter(row: DbRow): OutreachCenter {
  return {
    centerId: numberValue(row.center_id),
    centerName: stringValue(row.center_name),
    address: stringValue(row.address),
    phone: stringValue(row.phone),
    isActive: booleanValue(row.is_active),
    createdAt: dateValue(row.created_at),
  };
}

function mapDevice(row: DbRow): Device {
  return {
    deviceId: numberValue(row.device_id),
    assetTag: stringValue(row.asset_tag),
    serialNumber: stringValue(row.serial_number),
    deviceType: stringValue(row.device_type) as Device["deviceType"],
    manufacturer: stringValue(row.manufacturer),
    model: stringValue(row.model),
    status: stringValue(row.status) as Device["status"],
    centerId: numberValue(row.center_id),
  };
}

function mapLoanReason(row: DbRow): LoanReason {
  return {
    reasonId: numberValue(row.reason_id),
    reasonName: stringValue(row.reason_name),
  };
}

function mapLoan(row: DbRow): Loan {
  return {
    loanId: numberValue(row.loan_id),
    deviceId: numberValue(row.device_id),
    centerId: numberValue(row.center_id),
    reasonId: numberValue(row.reason_id),
    participantCode: stringValue(row.participant_code),
    userId: row.user_id == null ? null : numberValue(row.user_id),
    checkoutDate: dateValue(row.checkout_date),
    dueDate: dateValue(row.due_date),
    returnDate: row.return_date == null ? null : dateValue(row.return_date),
    loanStatus: stringValue(row.loan_status) as Loan["loanStatus"],
  };
}

function mapMaintenance(row: DbRow): MaintenanceRecord {
  return {
    maintenanceId: numberValue(row.maintenance_id),
    deviceId: numberValue(row.device_id),
    issueDescription: stringValue(row.issue_description),
    serviceDate: dateOnlyValue(row.service_date),
    resolvedDate:
      row.resolved_date == null ? null : dateOnlyValue(row.resolved_date),
    maintenanceStatus:
      stringValue(row.maintenance_status) as MaintenanceRecord["maintenanceStatus"],
  };
}

export class MySqlInventoryRepository implements InventoryRepository {
  // ---------------------------------------------------------------------------
  // Outreach centers
  // ---------------------------------------------------------------------------

  async listCenters(t: string, q: CenterQuery): Promise<Page<OutreachCenter>> {
    const [rows] = await db.execute(
      `SELECT center_id, center_name, address, phone, is_active, created_at
       FROM outreach_centers
       WHERE tenant_id = ?
       ORDER BY center_id`,
      [t],
    );

    let centers = (rows as DbRow[]).map(mapCenter);

    if (q.isActive !== undefined) {
      centers = centers.filter((center) => center.isActive === q.isActive);
    }

    if (q.search) {
      const term = q.search.toLowerCase();
      centers = centers.filter((center) =>
        [center.centerName, center.address, center.phone].some((value) =>
          value.toLowerCase().includes(term),
        ),
      );
    }

    return paginate(centers, q.cursor, q.limit, "centerId");
  }

  async getCenter(t: string, id: number): Promise<OutreachCenter | undefined> {
    const [rows] = await db.execute(
      `SELECT center_id, center_name, address, phone, is_active, created_at
       FROM outreach_centers
       WHERE tenant_id = ? AND center_id = ?
       LIMIT 1`,
      [t, id],
    );

    const row = (rows as DbRow[])[0];
    return row ? mapCenter(row) : undefined;
  }

  async createCenter(
    t: string,
    input: CreateCenter,
  ): Promise<OutreachCenter> {
    try {
      const [result] = await db.execute(
        `INSERT INTO outreach_centers
           (tenant_id, center_name, address, phone, is_active)
         VALUES (?, ?, ?, ?, ?)`,
        [t, input.centerName, input.address, input.phone, input.isActive],
      );

      const id = numberValue(
        (result as { insertId: number | bigint }).insertId,
      );

      const created = await this.getCenter(t, id);
      if (!created) throw new Error("Created center could not be retrieved");

      return created;
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new RepositoryConflict("Center name already exists");
      }
      throw error;
    }
  }

  async updateCenter(
    t: string,
    id: number,
    patch: UpdateCenter,
  ): Promise<OutreachCenter | undefined> {
    const columns: Record<keyof UpdateCenter, string> = {
      centerName: "center_name",
      address: "address",
      phone: "phone",
      isActive: "is_active",
    };

    const entries = Object.entries(patch) as [
      keyof UpdateCenter,
      string | boolean,
    ][];

    if (entries.length > 0) {
      const assignments = entries
        .map(([key]) => `${columns[key]} = ?`)
        .join(", ");

      try {
        await db.execute(
          `UPDATE outreach_centers
           SET ${assignments}
           WHERE tenant_id = ? AND center_id = ?`,
          [...entries.map(([, value]) => value), t, id],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new RepositoryConflict("Center name already exists");
        }
        throw error;
      }
    }

    return this.getCenter(t, id);
  }

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  async listDevices(t: string, q: DeviceQuery): Promise<Page<Device>> {
    const [rows] = await db.execute(
      `SELECT device_id, asset_tag, serial_number, device_type,
              manufacturer, model, status, center_id
       FROM devices
       WHERE tenant_id = ?
       ORDER BY device_id`,
      [t],
    );

    let devices = (rows as DbRow[]).map(mapDevice);

    if (q.deviceType) {
      devices = devices.filter((device) => device.deviceType === q.deviceType);
    }
    if (q.status) {
      devices = devices.filter((device) => device.status === q.status);
    }
    if (q.centerId !== undefined) {
      devices = devices.filter((device) => device.centerId === q.centerId);
    }
    if (q.assetTag) {
      devices = devices.filter((device) => device.assetTag === q.assetTag);
    }
    if (q.serialNumber) {
      devices = devices.filter(
        (device) => device.serialNumber === q.serialNumber,
      );
    }
    if (q.manufacturer) {
      const term = q.manufacturer.toLowerCase();
      devices = devices.filter((device) =>
        device.manufacturer.toLowerCase().includes(term),
      );
    }
    if (q.model) {
      const term = q.model.toLowerCase();
      devices = devices.filter((device) =>
        device.model.toLowerCase().includes(term),
      );
    }
    if (q.search) {
      const term = q.search.toLowerCase();
      devices = devices.filter((device) =>
        [
          device.assetTag,
          device.serialNumber,
          device.manufacturer,
          device.model,
        ].some((value) => value.toLowerCase().includes(term)),
      );
    }

    return paginate(devices, q.cursor, q.limit, "deviceId");
  }

  async getDevice(t: string, id: number): Promise<Device | undefined> {
    const [rows] = await db.execute(
      `SELECT device_id, asset_tag, serial_number, device_type,
              manufacturer, model, status, center_id
       FROM devices
       WHERE tenant_id = ? AND device_id = ?
       LIMIT 1`,
      [t, id],
    );

    const row = (rows as DbRow[])[0];
    return row ? mapDevice(row) : undefined;
  }

  async createDevice(t: string, input: CreateDevice): Promise<Device> {
    const center = await this.getCenter(t, input.centerId);
    if (!center) throw new RepositoryNotFound("Center not found");

    try {
      const [result] = await db.execute(
        `INSERT INTO devices
           (tenant_id, asset_tag, serial_number, device_type,
            manufacturer, model, status, center_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t,
          input.assetTag,
          input.serialNumber,
          input.deviceType,
          input.manufacturer,
          input.model,
          input.status,
          input.centerId,
        ],
      );

      const id = numberValue(
        (result as { insertId: number | bigint }).insertId,
      );

      const created = await this.getDevice(t, id);
      if (!created) throw new Error("Created device could not be retrieved");

      return created;
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new RepositoryConflict(
          "Asset tag or serial number already exists",
        );
      }
      throw error;
    }
  }

  async updateDevice(
    t: string,
    id: number,
    patch: UpdateDevice,
  ): Promise<Device | undefined> {
    const columns: Record<keyof UpdateDevice, string> = {
      assetTag: "asset_tag",
      serialNumber: "serial_number",
      deviceType: "device_type",
      manufacturer: "manufacturer",
      model: "model",
      centerId: "center_id",
    };

    if (patch.centerId !== undefined) {
      const center = await this.getCenter(t, patch.centerId);
      if (!center) throw new RepositoryNotFound("Center not found");
    }

    const entries = Object.entries(patch) as [
      keyof UpdateDevice,
      string | number,
    ][];

    if (entries.length > 0) {
      const assignments = entries
        .map(([key]) => `${columns[key]} = ?`)
        .join(", ");

      try {
        await db.execute(
          `UPDATE devices
           SET ${assignments}
           WHERE tenant_id = ? AND device_id = ?`,
          [...entries.map(([, value]) => value), t, id],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new RepositoryConflict(
            "Asset tag or serial number already exists",
          );
        }
        throw error;
      }
    }

    return this.getDevice(t, id);
  }

  // ---------------------------------------------------------------------------
  // Loans
  // ---------------------------------------------------------------------------

  async listLoans(t: string, q: LoanQuery): Promise<Page<Loan>> {
    const [rows] = await db.execute(
      `SELECT loan_id, device_id, center_id, reason_id, participant_code, user_id,
              checkout_date, due_date, return_date, loan_status
       FROM loans
       WHERE tenant_id = ?
       ORDER BY loan_id`,
      [t],
    );

    let items = (rows as DbRow[]).map(mapLoan);

    if (q.loanStatus) {
      items = items.filter((item) => item.loanStatus === q.loanStatus);
    }
    if (q.centerId !== undefined) {
      items = items.filter((item) => item.centerId === q.centerId);
    }
    if (q.deviceId !== undefined) {
      items = items.filter((item) => item.deviceId === q.deviceId);
    }
    if (q.reasonId !== undefined) {
      items = items.filter((item) => item.reasonId === q.reasonId);
    }
    if (q.userId !== undefined) {
      items = items.filter((item) => item.userId === q.userId);
    }
    if (q.participantCode) {
      items = items.filter(
        (item) => item.participantCode === q.participantCode,
      );
    }
    if (q.checkoutFrom) {
      items = items.filter((item) => item.checkoutDate >= q.checkoutFrom!);
    }
    if (q.checkoutTo) {
      items = items.filter((item) => item.checkoutDate <= q.checkoutTo!);
    }
    if (q.dueFrom) {
      items = items.filter((item) => item.dueDate >= q.dueFrom!);
    }
    if (q.dueTo) {
      items = items.filter((item) => item.dueDate <= q.dueTo!);
    }

    return paginate(items, q.cursor, q.limit, "loanId");
  }

  async getLoan(t: string, id: number): Promise<Loan | undefined> {
    const [rows] = await db.execute(
      `SELECT loan_id, device_id, center_id, reason_id, participant_code, user_id,
              checkout_date, due_date, return_date, loan_status
       FROM loans
       WHERE tenant_id = ? AND loan_id = ?
       LIMIT 1`,
      [t, id],
    );

    const row = (rows as DbRow[])[0];
    return row ? mapLoan(row) : undefined;
  }

  async createLoan(t: string, input: CreateLoan): Promise<Loan> {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [deviceRows] = await connection.execute(
        `SELECT device_id, status
         FROM devices
         WHERE tenant_id = ? AND device_id = ?
         FOR UPDATE`,
        [t, input.deviceId],
      );

      const device = (deviceRows as DbRow[])[0];
      if (!device) throw new RepositoryNotFound("Device not found");

      if (stringValue(device.status) !== "AVAILABLE") {
        throw new RepositoryConflict("Device is not available for checkout");
      }

      const [centerRows] = await connection.execute(
        `SELECT center_id
         FROM outreach_centers
         WHERE tenant_id = ? AND center_id = ?
         LIMIT 1`,
        [t, input.centerId],
      );

      if (!(centerRows as DbRow[]).length) {
        throw new RepositoryNotFound("Center not found");
      }

      const [reasonRows] = await connection.execute(
        `SELECT reason_id
         FROM loan_reasons
         WHERE tenant_id = ? AND reason_id = ?
         LIMIT 1`,
        [t, input.reasonId],
      );

      if (!(reasonRows as DbRow[]).length) {
        throw new RepositoryNotFound("Loan reason not found");
      }

      if (new Date(input.dueDate) < new Date(input.checkoutDate)) {
        throw new RepositoryConflict("Due date cannot precede checkout date");
      }

      const [result] = await connection.execute(
        `INSERT INTO loans
           (tenant_id, device_id, center_id, reason_id, participant_code,
            user_id, checkout_date, due_date, loan_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [
          t,
          input.deviceId,
          input.centerId,
          input.reasonId,
          input.participantCode,
          input.userId ?? null,
          toSqlDateTime(input.checkoutDate),
          toSqlDateTime(input.dueDate),
        ],
      );

      const loanId = numberValue(
        (result as { insertId: number | bigint }).insertId,
      );

      await connection.execute(
        `UPDATE devices
         SET status = 'CHECKED_OUT'
         WHERE tenant_id = ? AND device_id = ?`,
        [t, input.deviceId],
      );

      await connection.commit();

      const created = await this.getLoan(t, loanId);
      if (!created) throw new Error("Created loan could not be retrieved");

      return created;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateLoan(
    t: string,
    id: number,
    patch: UpdateLoan,
  ): Promise<Loan | undefined> {
    const current = await this.getLoan(t, id);
    if (!current) return undefined;

    if (current.loanStatus === "RETURNED") {
      throw new RepositoryConflict("Returned loans cannot be changed");
    }

    if (patch.reasonId !== undefined) {
      const reason = await this.getLoanReason(t, patch.reasonId);
      if (!reason) throw new RepositoryNotFound("Loan reason not found");
    }

    if (
      patch.dueDate !== undefined &&
      new Date(patch.dueDate) < new Date(current.checkoutDate)
    ) {
      throw new RepositoryConflict("Due date cannot precede checkout date");
    }

    const assignments: string[] = [];
    const values: unknown[] = [];

    if (patch.dueDate !== undefined) {
      assignments.push("due_date = ?");
      values.push(toSqlDateTime(patch.dueDate));
    }

    if (patch.reasonId !== undefined) {
      assignments.push("reason_id = ?");
      values.push(patch.reasonId);
    }

    if (assignments.length > 0) {
      await db.query(
        `UPDATE loans
         SET ${assignments.join(", ")}
         WHERE tenant_id = ? AND loan_id = ?
           AND loan_status <> 'RETURNED'`,
        [...values, t, id],
      );
    }

    return this.getLoan(t, id);
  }

  async returnLoan(
    t: string,
    id: number,
    returnDate: string,
  ): Promise<Loan | undefined> {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [loanRows] = await connection.execute(
        `SELECT loan_id, device_id, loan_status
         FROM loans
         WHERE tenant_id = ? AND loan_id = ?
         FOR UPDATE`,
        [t, id],
      );

      const loan = (loanRows as DbRow[])[0];

      if (!loan) {
        await connection.rollback();
        return undefined;
      }

      if (stringValue(loan.loan_status) === "RETURNED") {
        throw new RepositoryConflict("Loan has already been returned");
      }

      const deviceId = numberValue(loan.device_id);

      const [deviceRows] = await connection.execute(
        `SELECT status
         FROM devices
         WHERE tenant_id = ? AND device_id = ?
         FOR UPDATE`,
        [t, deviceId],
      );

      const device = (deviceRows as DbRow[])[0];
      if (!device) throw new RepositoryNotFound("Device not found");

      if (stringValue(device.status) !== "CHECKED_OUT") {
        throw new RepositoryConflict("Device is not checked out");
      }

      await connection.execute(
        `UPDATE loans
         SET return_date = ?, loan_status = 'RETURNED'
         WHERE tenant_id = ? AND loan_id = ?`,
        [toSqlDateTime(returnDate), t, id],
      );

      await connection.execute(
        `UPDATE devices
         SET status = 'AVAILABLE'
         WHERE tenant_id = ? AND device_id = ?`,
        [t, deviceId],
      );

      await connection.commit();
      return this.getLoan(t, id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Loan reasons
  // ---------------------------------------------------------------------------

  async listLoanReasons(t: string): Promise<LoanReason[]> {
    const [rows] = await db.execute(
      `SELECT reason_id, reason_name
       FROM loan_reasons
       WHERE tenant_id = ?
       ORDER BY reason_id`,
      [t],
    );

    return (rows as DbRow[]).map(mapLoanReason);
  }

  async getLoanReason(
    t: string,
    id: number,
  ): Promise<LoanReason | undefined> {
    const [rows] = await db.execute(
      `SELECT reason_id, reason_name
       FROM loan_reasons
       WHERE tenant_id = ? AND reason_id = ?
       LIMIT 1`,
      [t, id],
    );

    const row = (rows as DbRow[])[0];
    return row ? mapLoanReason(row) : undefined;
  }

  async createLoanReason(
    t: string,
    reasonName: string,
  ): Promise<LoanReason> {
    try {
      const [result] = await db.execute(
        `INSERT INTO loan_reasons (tenant_id, reason_name)
         VALUES (?, ?)`,
        [t, reasonName],
      );

      const id = numberValue(
        (result as { insertId: number | bigint }).insertId,
      );

      const created = await this.getLoanReason(t, id);
      if (!created) {
        throw new Error("Created loan reason could not be retrieved");
      }

      return created;
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new RepositoryConflict("Loan reason already exists");
      }
      throw error;
    }
  }

  async updateLoanReason(
    t: string,
    id: number,
    reasonName: string,
  ): Promise<LoanReason | undefined> {
    try {
      await db.execute(
        `UPDATE loan_reasons
         SET reason_name = ?
         WHERE tenant_id = ? AND reason_id = ?`,
        [reasonName, t, id],
      );
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new RepositoryConflict("Loan reason already exists");
      }
      throw error;
    }

    return this.getLoanReason(t, id);
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  async listMaintenance(
    t: string,
    q: MaintenanceQuery,
  ): Promise<Page<MaintenanceRecord>> {
    const [rows] = await db.execute(
      `SELECT maintenance_id, device_id, issue_description, service_date,
              resolved_date, maintenance_status
       FROM maintenance_records
       WHERE tenant_id = ?
       ORDER BY maintenance_id`,
      [t],
    );

    let items = (rows as DbRow[]).map(mapMaintenance);

    if (q.deviceId !== undefined) {
      items = items.filter((item) => item.deviceId === q.deviceId);
    }

    if (q.maintenanceStatus) {
      items = items.filter(
        (item) => item.maintenanceStatus === q.maintenanceStatus,
      );
    }

    if (q.serviceFrom) {
      items = items.filter((item) => item.serviceDate >= q.serviceFrom!);
    }

    if (q.serviceTo) {
      items = items.filter((item) => item.serviceDate <= q.serviceTo!);
    }

    if (q.resolvedFrom) {
      items = items.filter(
        (item) =>
          item.resolvedDate !== null &&
          item.resolvedDate >= q.resolvedFrom!,
      );
    }

    if (q.resolvedTo) {
      items = items.filter(
        (item) =>
          item.resolvedDate !== null &&
          item.resolvedDate <= q.resolvedTo!,
      );
    }

    return paginate(items, q.cursor, q.limit, "maintenanceId");
  }

  async getMaintenance(
    t: string,
    id: number,
  ): Promise<MaintenanceRecord | undefined> {
    const [rows] = await db.execute(
      `SELECT maintenance_id, device_id, issue_description, service_date,
              resolved_date, maintenance_status
       FROM maintenance_records
       WHERE tenant_id = ? AND maintenance_id = ?
       LIMIT 1`,
      [t, id],
    );

    const row = (rows as DbRow[])[0];
    return row ? mapMaintenance(row) : undefined;
  }

  async createMaintenance(
    t: string,
    input: CreateMaintenance,
  ): Promise<MaintenanceRecord> {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [deviceRows] = await connection.execute(
        `SELECT status
         FROM devices
         WHERE tenant_id = ? AND device_id = ?
         FOR UPDATE`,
        [t, input.deviceId],
      );

      const device = (deviceRows as DbRow[])[0];
      if (!device) throw new RepositoryNotFound("Device not found");

      const status = stringValue(device.status);

      if (status === "CHECKED_OUT") {
        throw new RepositoryConflict(
          "Checked-out devices cannot enter maintenance",
        );
      }

      if (status === "MAINTENANCE") {
        throw new RepositoryConflict("Device is already in maintenance");
      }

      const [result] = await connection.execute(
        `INSERT INTO maintenance_records
           (tenant_id, device_id, issue_description, service_date,
            maintenance_status)
         VALUES (?, ?, ?, ?, 'OPEN')`,
        [t, input.deviceId, input.issueDescription, input.serviceDate],
      );

      const id = numberValue(
        (result as { insertId: number | bigint }).insertId,
      );

      await connection.execute(
        `UPDATE devices
         SET status = 'MAINTENANCE'
         WHERE tenant_id = ? AND device_id = ?`,
        [t, input.deviceId],
      );

      await connection.commit();

      const created = await this.getMaintenance(t, id);
      if (!created) {
        throw new Error("Created maintenance record could not be retrieved");
      }

      return created;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateMaintenance(
    t: string,
    id: number,
    patch: UpdateMaintenance,
  ): Promise<MaintenanceRecord | undefined> {
    const current = await this.getMaintenance(t, id);
    if (!current) return undefined;

    if (current.maintenanceStatus === "RESOLVED") {
      throw new RepositoryConflict(
        "Resolved maintenance records cannot be changed",
      );
    }

    if (
      patch.maintenanceStatus === "IN_PROGRESS" &&
      current.maintenanceStatus !== "OPEN"
    ) {
      throw new RepositoryConflict(
        "Only open maintenance can move to in-progress",
      );
    }

    const assignments: string[] = [];
    const values: unknown[] = [];

    if (patch.issueDescription !== undefined) {
      assignments.push("issue_description = ?");
      values.push(patch.issueDescription);
    }

    if (patch.maintenanceStatus !== undefined) {
      assignments.push("maintenance_status = ?");
      values.push(patch.maintenanceStatus);
    }

    if (assignments.length > 0) {
      await db.query(
        `UPDATE maintenance_records
         SET ${assignments.join(", ")}
         WHERE tenant_id = ? AND maintenance_id = ?
           AND maintenance_status <> 'RESOLVED'`,
        [...values, t, id],
      );
    }

    return this.getMaintenance(t, id);
  }

  async resolveMaintenance(
    t: string,
    id: number,
    resolvedDate: string,
  ): Promise<MaintenanceRecord | undefined> {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [recordRows] = await connection.execute(
        `SELECT device_id, maintenance_status
         FROM maintenance_records
         WHERE tenant_id = ? AND maintenance_id = ?
         FOR UPDATE`,
        [t, id],
      );

      const record = (recordRows as DbRow[])[0];

      if (!record) {
        await connection.rollback();
        return undefined;
      }

      if (stringValue(record.maintenance_status) === "RESOLVED") {
        throw new RepositoryConflict("Maintenance record is already resolved");
      }

      const deviceId = numberValue(record.device_id);

      const [deviceRows] = await connection.execute(
        `SELECT status
         FROM devices
         WHERE tenant_id = ? AND device_id = ?
         FOR UPDATE`,
        [t, deviceId],
      );

      const device = (deviceRows as DbRow[])[0];
      if (!device) throw new RepositoryNotFound("Device not found");

      const [otherRows] = await connection.execute(
        `SELECT maintenance_id
         FROM maintenance_records
         WHERE tenant_id = ?
           AND device_id = ?
           AND maintenance_status <> 'RESOLVED'
           AND maintenance_id <> ?
         LIMIT 1`,
        [t, deviceId, id],
      );

      if ((otherRows as DbRow[]).length > 0) {
        throw new RepositoryConflict(
          "Another unresolved maintenance record exists for this device",
        );
      }

      await connection.execute(
        `UPDATE maintenance_records
         SET maintenance_status = 'RESOLVED', resolved_date = ?
         WHERE tenant_id = ? AND maintenance_id = ?`,
        [resolvedDate, t, id],
      );

      await connection.execute(
        `UPDATE devices
         SET status = 'AVAILABLE'
         WHERE tenant_id = ? AND device_id = ? AND status = 'MAINTENANCE'`,
        [t, deviceId],
      );

      await connection.commit();
      return this.getMaintenance(t, id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
