import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { db } from "./db.js";
import type { DeviceType } from "./types.js";

export type RequestStatus = "PENDING" | "APPROVED" | "DENIED" | "CANCELLED";

export interface EquipmentRequest {
  requestId: number;
  userId: number;
  userEmail: string | null;
  deviceType: DeviceType;
  reasonId: number | null;
  reasonText: string;
  status: RequestStatus;
  loanId: number | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

const iso = (v: unknown) =>
  v == null ? null : new Date(v as string | Date).toISOString();

function map(row: RowDataPacket): EquipmentRequest {
  return {
    requestId: Number(row.request_id),
    userId: Number(row.user_id),
    userEmail: (row.email as string | null) ?? null,
    deviceType: row.device_type,
    reasonId: row.reason_id == null ? null : Number(row.reason_id),
    reasonText: row.reason_text,
    status: row.status,
    loanId: row.loan_id == null ? null : Number(row.loan_id),
    reviewNote: row.review_note ?? null,
    createdAt: iso(row.created_at) as string,
    reviewedAt: iso(row.reviewed_at),
  };
}

const SELECT = `SELECT r.request_id, r.user_id, r.device_type,
       r.reason_id, r.reason_text, r.status, r.loan_id, r.review_note,
       r.created_at, r.reviewed_at
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
  input: { deviceType: DeviceType; reasonId?: number; reasonText: string },
): Promise<EquipmentRequest> {
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
       (tenant_id, user_id, device_type, reason_id, reason_text)
     VALUES (?, ?, ?, ?, ?)`,
    [tenantId, userId, input.deviceType, input.reasonId ?? null, input.reasonText],
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
  opts: { ownerId?: number; reviewerId?: number; note?: string; loanId?: number } = {},
): Promise<boolean> {
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE equipment_requests
        SET status = ?, reviewed_by = ?, review_note = ?, loan_id = ?,
            reviewed_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ? AND request_id = ? AND status = 'PENDING'
        AND (? IS NULL OR user_id = ?)`,
    [
      status,
      opts.reviewerId ?? null,
      opts.note ?? null,
      opts.loanId ?? null,
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
        SET status = 'PENDING', reviewed_by = NULL, loan_id = NULL, reviewed_at = NULL
      WHERE tenant_id = ? AND request_id = ?`,
    [tenantId, requestId],
  );
}

export async function attachLoan(
  tenantId: string,
  requestId: number,
  loanId: number,
): Promise<void> {
  await db.execute(
    "UPDATE equipment_requests SET loan_id = ? WHERE tenant_id = ? AND request_id = ?",
    [loanId, tenantId, requestId],
  );
}
