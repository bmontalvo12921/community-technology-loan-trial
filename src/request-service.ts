import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { db } from "./db.js";
import type { DeviceType } from "./types.js";

export type RequestStatus = "PENDING" | "APPROVED" | "DENIED" | "CANCELLED";

export interface EquipmentRequest {
  requestId: number;
  userId: number;
  userEmail: string | null;
  centerId: number;
  deviceType: DeviceType;
  reasonId: number | null;
  reasonText: string;
  status: RequestStatus;
  createdAt: string;
}

const iso = (v: unknown) => new Date(v as string | Date).toISOString();

function map(row: RowDataPacket): EquipmentRequest {
  return {
    requestId: Number(row.request_id),
    userId: Number(row.user_id),
    userEmail: (row.email as string | null) ?? null,
    centerId: Number(row.center_id),
    deviceType: row.device_type,
    reasonId: row.reason_id == null ? null : Number(row.reason_id),
    reasonText: String(row.details ?? ""),
    status: row.status,
    createdAt: iso(row.created_at) as string,
  };
}

const SELECT = `SELECT r.request_id, r.user_id, r.center_id, r.device_type,
       r.reason_id, r.details, r.status, r.created_at
  FROM equipment_requests r`;

// Emails are looked up separately rather than joined: the users table can
// have a different collation from equipment_requests on an older database.
async function withEmails(
  tenantId: string,
  rows: RowDataPacket[],
): Promise<EquipmentRequest[]> {
  const ids = [...new Set(rows.map((r) => Number(r.user_id)))];
  const emails = new Map<number, string>();
  if (ids.length) {
    const [users] = await db.query<RowDataPacket[]>(
      "SELECT id, email FROM users WHERE tenant_id = ? AND id IN (?)",
      [tenantId, ids],
    );
    for (const u of users) emails.set(Number(u.id), u.email);
  }
  return rows.map((r) => map({ ...r, email: emails.get(Number(r.user_id)) ?? null }));
}

export async function createRequest(
  tenantId: string,
  userId: number,
  input: { centerId: number; deviceType: DeviceType; reasonId?: number; reasonText: string },
): Promise<EquipmentRequest> {
  const [centers] = await db.execute<RowDataPacket[]>(
    "SELECT 1 FROM outreach_centers WHERE tenant_id = ? AND center_id = ? AND is_active = 1",
    [tenantId, input.centerId],
  );
  if (!centers.length) {
    throw Object.assign(new Error("Outreach center not found or inactive"), { statusCode: 404 });
  }

  if (input.reasonId !== undefined) {
    const [r] = await db.execute<RowDataPacket[]>(
      "SELECT 1 FROM loan_reasons WHERE tenant_id = ? AND reason_id = ?",
      [tenantId, input.reasonId],
    );
    if (!r.length) {
      throw Object.assign(new Error("Loan reason not found"), { statusCode: 404 });
    }
  }

  const [result] = await db.execute<ResultSetHeader>(
    `INSERT INTO equipment_requests
       (tenant_id, user_id, center_id, device_type, reason_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tenantId, userId, input.centerId, input.deviceType, input.reasonId ?? null, input.reasonText],
  );
  const created = await getRequest(tenantId, result.insertId);
  if (!created) throw new Error("Created request could not be retrieved");
  return created;
}

export async function getRequest(
  tenantId: string,
  requestId: number,
): Promise<EquipmentRequest | undefined> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `${SELECT} WHERE r.tenant_id = ? AND r.request_id = ?`,
    [tenantId, requestId],
  );
  return rows[0] ? (await withEmails(tenantId, rows))[0] : undefined;
}

export async function listRequests(
  tenantId: string,
  filter: { userId?: number; status?: RequestStatus },
): Promise<EquipmentRequest[]> {
  const where = ["r.tenant_id = ?"];
  const params: (string | number)[] = [tenantId];
  if (filter.userId !== undefined) {
    where.push("r.user_id = ?");
    params.push(filter.userId);
  }
  if (filter.status) {
    where.push("r.status = ?");
    params.push(filter.status);
  }
  const [rows] = await db.execute<RowDataPacket[]>(
    `${SELECT} WHERE ${where.join(" AND ")} ORDER BY r.request_id DESC LIMIT 200`,
    params,
  );
  return withEmails(tenantId, rows);
}

/**
 * Atomically moves a PENDING request to a new status. Returns false when the
 * request is missing, belongs to someone else (when ownerId is given), or is
 * no longer pending.
 */
export async function transitionPending(
  tenantId: string,
  requestId: number,
  status: Exclude<RequestStatus, "PENDING">,
  opts: { ownerId?: number } = {},
): Promise<boolean> {
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE equipment_requests
        SET status = ?
      WHERE tenant_id = ? AND request_id = ? AND status = 'PENDING'
        AND (? IS NULL OR user_id = ?)`,
    [
      status,
      tenantId,
      requestId,
      opts.ownerId ?? null,
      opts.ownerId ?? null,
    ],
  );
  return result.affectedRows > 0;
}

export async function revertToPending(
  tenantId: string,
  requestId: number,
): Promise<void> {
  await db.execute(
    `UPDATE equipment_requests
        SET status = 'PENDING'
      WHERE tenant_id = ? AND request_id = ?`,
    [tenantId, requestId],
  );
}
