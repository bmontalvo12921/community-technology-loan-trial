
import type { InventoryRepository, DeviceType } from "./types.js";
import {
  memoryStore,
  type RequestStatus,
  type EquipmentRequest
} from "./memory-store.js";

export type { RequestStatus, EquipmentRequest };

/**
 * Create a request after validating its center and optional loan reason.
 */
export async function createRequest(
  tenantId: string,
  userId: number,
  input: {
    centerId: number;
    deviceType: DeviceType;
    reasonId?: number;
    reasonText: string;
  },
  repository: InventoryRepository
): Promise<EquipmentRequest> {
  const center = await repository.getCenter(
    tenantId,
    input.centerId
  );

  if (!center || !center.isActive) {
    throw Object.assign(
      new Error("Outreach center not found or inactive"),
      { statusCode: 404 }
    );
  }

  if (input.reasonId !== undefined) {
    const reason = await repository.getLoanReason(
      tenantId,
      input.reasonId
    );

    if (!reason) {
      throw Object.assign(
        new Error("Loan reason not found"),
        { statusCode: 404 }
      );
    }
  }

  const user = memoryStore.findUserById(
    tenantId,
    userId
  );

  if (
    !user ||
    user.role !== "USER" ||
    !user.isActive ||
    user.approvalStatus !== "APPROVED"
  ) {
    throw Object.assign(
      new Error("Active user account not found"),
      { statusCode: 404 }
    );
  }

  return memoryStore.createRequest(
    tenantId,
    userId,
    user.email,
    input
  );
}

/**
 * Retrieve one request within its tenant.
 */
export async function getRequest(
  tenantId: string,
  requestId: number
): Promise<EquipmentRequest | undefined> {
  return memoryStore.getRequest(
    tenantId,
    requestId
  );
}

/**
 * List requests with optional user and status filters.
 */
export async function listRequests(
  tenantId: string,
  filter: {
    userId?: number;
    status?: RequestStatus;
  }
): Promise<EquipmentRequest[]> {
  return memoryStore.listRequests(
    tenantId,
    filter
  );
}

/**
 * Move a pending request to another status.
 *
 * The status changes only when the request exists,
 * belongs to the tenant, and is still pending.
 */
export async function transitionPending(
  tenantId: string,
  requestId: number,
  status: Exclude<RequestStatus, "PENDING">,
  opts: { ownerId?: number } = {}
): Promise<boolean> {
  return memoryStore.transitionPending(
    tenantId,
    requestId,
    status,
    opts.ownerId
  );
}

/**
 * Restore a request to pending if loan creation fails.
 */
export async function revertToPending(
  tenantId: string,
  requestId: number
): Promise<void> {
  memoryStore.revertToPending(
    tenantId,
    requestId
  );
}
