
import type { DeviceType } from "./types.js";

export type AuthRole = "ADMIN" | "STAFF" | "USER";
export type RequestStatus =
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "CANCELLED";

export interface MemoryUser {
  id: string;
  tenantId: string;
  email: string;
  role: AuthRole;
  passwordHash: string;
  isActive: boolean;
  approvalStatus: "APPROVED" | "PENDING";
  failedAttempts: number;
  locked: boolean;
}

export interface SecurityAuditEvent {
  tenantId: string;
  userId: string | null;
  eventType: string;
  eventStatus: string;
  requestId: string | null;
  timestamp: string;
}

export interface EquipmentRequest {
  requestId: number;
  tenantId: string;
  userId: number;
  userEmail: string | null;
  centerId: number;
  deviceType: DeviceType;
  reasonId: number | null;
  reasonText: string;
  status: RequestStatus;
  createdAt: string;
}

export class MemoryStore {
  private users = new Map<string, MemoryUser>();
  private requests = new Map<number, EquipmentRequest>();
  private auditEvents: SecurityAuditEvent[] = [];

  private nextUserId = 1;
  private nextRequestId = 1;

  // --------------------------------------------------
  // USERS
  // --------------------------------------------------

  findUserByEmail(
    tenantId: string,
    email: string
  ): MemoryUser | undefined {
    const normalizedEmail = email.trim().toLowerCase();

    return [...this.users.values()].find(
      user =>
        user.tenantId === tenantId &&
        user.email === normalizedEmail
    );
  }

  findUserById(
    tenantId: string,
    userId: string | number
  ): MemoryUser | undefined {
    const user = this.users.get(String(userId));

    if (!user || user.tenantId !== tenantId) {
      return undefined;
    }

    return user;
  }

  createUser(
    tenantId: string,
    email: string,
    passwordHash: string,
    role: AuthRole,
    isActive = true
  ): MemoryUser | undefined {
    const normalizedEmail = email.trim().toLowerCase();

    if (this.findUserByEmail(tenantId, normalizedEmail)) {
      return undefined;
    }

    const user: MemoryUser = {
      id: String(this.nextUserId++),
      tenantId,
      email: normalizedEmail,
      passwordHash,
      role,
      isActive,
      approvalStatus: isActive ? "APPROVED" : "PENDING",
      failedAttempts: 0,
      locked: false
    };

    this.users.set(user.id, user);

    return user;
  }

  listUsers(
    tenantId: string,
    includeStaffAndAdmins: boolean
  ) {
    return [...this.users.values()]
      .filter(user =>
        user.tenantId === tenantId &&
        (
          includeStaffAndAdmins ||
          user.role === "USER"
        )
      )
      .map(user => ({
        userId: Number(user.id),
        email: user.email,
        role: user.role,
        isActive: user.isActive
      }));
  }

  setUserActive(
    tenantId: string,
    userId: string | number,
    isActive: boolean
  ): boolean {
    const user = this.findUserById(tenantId, userId);

    if (!user) return false;

    user.isActive = isActive;

    return true;
  }

  // --------------------------------------------------
  // EQUIPMENT REQUESTS
  // --------------------------------------------------

  createRequest(
    tenantId: string,
    userId: number,
    userEmail: string | null,
    input: {
      centerId: number;
      deviceType: DeviceType;
      reasonId?: number;
      reasonText: string;
    }
  ): EquipmentRequest {
    const request: EquipmentRequest = {
      requestId: this.nextRequestId++,
      tenantId,
      userId,
      userEmail,
      centerId: input.centerId,
      deviceType: input.deviceType,
      reasonId: input.reasonId ?? null,
      reasonText: input.reasonText,
      status: "PENDING",
      createdAt: new Date().toISOString()
    };

    this.requests.set(request.requestId, request);

    return this.cleanRequest(request);
  }

  getRequest(
    tenantId: string,
    requestId: number
  ): EquipmentRequest | undefined {
    const request = this.requests.get(requestId);

    if (!request || request.tenantId !== tenantId) {
      return undefined;
    }

    return this.cleanRequest(request);
  }

  listRequests(
    tenantId: string,
    filter: {
      userId?: number;
      status?: RequestStatus;
    }
  ): EquipmentRequest[] {
    return [...this.requests.values()]
      .filter(request => {
        if (request.tenantId !== tenantId) return false;

        if (
          filter.userId !== undefined &&
          request.userId !== filter.userId
        ) {
          return false;
        }

        if (
          filter.status &&
          request.status !== filter.status
        ) {
          return false;
        }

        return true;
      })
      .sort((a, b) => b.requestId - a.requestId)
      .slice(0, 200)
      .map(request => this.cleanRequest(request));
  }

  transitionPending(
    tenantId: string,
    requestId: number,
    status: Exclude<RequestStatus, "PENDING">,
    ownerId?: number
  ): boolean {
    const request = this.requests.get(requestId);

    if (
      !request ||
      request.tenantId !== tenantId ||
      request.status !== "PENDING"
    ) {
      return false;
    }

    if (
      ownerId !== undefined &&
      request.userId !== ownerId
    ) {
      return false;
    }

    request.status = status;

    return true;
  }

  revertToPending(
    tenantId: string,
    requestId: number
  ): void {
    const request = this.requests.get(requestId);

    if (
      request &&
      request.tenantId === tenantId &&
      request.status === "APPROVED"
    ) {
      request.status = "PENDING";
    }
  }

  // --------------------------------------------------
  // SECURITY AUDIT
  // --------------------------------------------------

  recordAudit(event: SecurityAuditEvent): void {
    this.auditEvents.push({ ...event });
  }

  getAuditEvents(tenantId: string): SecurityAuditEvent[] {
    return this.auditEvents
      .filter(event => event.tenantId === tenantId)
      .map(event => ({ ...event }));
  }

  private cleanRequest(
    request: EquipmentRequest
  ): EquipmentRequest {
    const { tenantId: _tenantId, ...publicRequest } = request;

    return publicRequest as EquipmentRequest;
  }
}

export const memoryStore = new MemoryStore();
