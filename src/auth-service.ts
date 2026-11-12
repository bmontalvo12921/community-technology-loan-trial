
import { verifyPassword } from "./password.js";
import {
  memoryStore,
  type AuthRole,
  type MemoryUser
} from "./memory-store.js";

export const TENANT_ID = "city-of-orlando";
export const MAX_FAILED_ATTEMPTS = 3;

export type { AuthRole };

const USER_PERMISSIONS = [
  "centers:read",
  "loan-reasons:read",
  "my-loans:read",
  "my-requests:read",
  "my-requests:write"
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
  "users:read"
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
  "users:write"
];

export const ROLE_PERMISSIONS: Record<
  AuthRole,
  readonly string[]
> = {
  USER: USER_PERMISSIONS,
  STAFF: STAFF_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS
};

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  email: string;
  role: AuthRole;
  permissions: string[];
}

export type CreateAccountResult =
  | { success: true; user: AuthenticatedUser }
  | { success: false; reason: "EMAIL_TAKEN" };

export type LoginFailureReason =
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_PENDING_APPROVAL";

export type LoginResult =
  | { success: true; user: AuthenticatedUser }
  | { success: false; reason: LoginFailureReason };

export type RegisterResult = CreateAccountResult;

function toAuthenticatedUser(
  user: MemoryUser
): AuthenticatedUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
    permissions: [...ROLE_PERMISSIONS[user.role]]
  };
}

function audit(
  tenantId: string,
  userId: string | null,
  eventType: string,
  eventStatus: string,
  requestId: string | null
): void {
  memoryStore.recordAudit({
    tenantId,
    userId,
    eventType,
    eventStatus,
    requestId,
    timestamp: new Date().toISOString()
  });
}

/**
 * Create an account using the in-memory user store.
 *
 * Password hashing is performed by the caller.
 */
export async function createAccount(
  tenantId: string,
  email: string,
  passwordHash: string,
  role: AuthRole,
  isActive = true
): Promise<CreateAccountResult> {
  const user = memoryStore.createUser(
    tenantId,
    email,
    passwordHash,
    role,
    isActive
  );

  if (!user) {
    return {
      success: false,
      reason: "EMAIL_TAKEN"
    };
  }

  audit(
    tenantId,
    user.id,
    "ACCOUNT_CREATED",
    isActive ? "ACTIVE" : "INACTIVE",
    null
  );

  return {
    success: true,
    user: toAuthenticatedUser(user)
  };
}

/**
 * Authenticate a user.
 *
 * Accounts lock after three consecutive failed password attempts.
 */
export async function authenticateUser(
  email: string,
  password: string,
  requestId: string | null
): Promise<LoginResult> {
  const user = memoryStore.findUserByEmail(
    TENANT_ID,
    email
  );

  if (!user) {
    audit(
      TENANT_ID,
      null,
      "LOGIN_FAILURE",
      "INVALID_CREDENTIALS",
      requestId
    );

    return {
      success: false,
      reason: "INVALID_CREDENTIALS"
    };
  }

  if (user.locked) {
    audit(
      TENANT_ID,
      user.id,
      "LOGIN_FAILURE",
      "ACCOUNT_LOCKED",
      requestId
    );

    return {
      success: false,
      reason: "ACCOUNT_LOCKED"
    };
  }

  if (user.approvalStatus === "PENDING") {
    audit(
      TENANT_ID,
      user.id,
      "LOGIN_FAILURE",
      "PENDING_APPROVAL",
      requestId
    );

    return {
      success: false,
      reason: "ACCOUNT_PENDING_APPROVAL"
    };
  }

  if (!user.isActive) {
    audit(
      TENANT_ID,
      user.id,
      "LOGIN_FAILURE",
      "ACCOUNT_INACTIVE",
      requestId
    );

    return {
      success: false,
      reason: "ACCOUNT_INACTIVE"
    };
  }

  const passwordMatches = await verifyPassword(
    password,
    user.passwordHash
  );

  if (!passwordMatches) {
    user.failedAttempts++;

    const shouldLock =
      user.failedAttempts >= MAX_FAILED_ATTEMPTS;

    if (shouldLock) {
      user.locked = true;
    }

    audit(
      TENANT_ID,
      user.id,
      shouldLock ? "ACCOUNT_LOCKED" : "LOGIN_FAILURE",
      shouldLock ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS",
      requestId
    );

    return {
      success: false,
      reason: shouldLock
        ? "ACCOUNT_LOCKED"
        : "INVALID_CREDENTIALS"
    };
  }

  user.failedAttempts = 0;

  audit(
    TENANT_ID,
    user.id,
    "LOGIN_SUCCESS",
    "SUCCESS",
    requestId
  );

  return {
    success: true,
    user: toAuthenticatedUser(user)
  };
}

/**
 * Self-service registration creates a pending USER account.
 * An administrator must activate the account before login.
 */
export async function registerUser(
  email: string,
  passwordHash: string,
  requestId: string | null
): Promise<RegisterResult> {
  const result = await createAccount(
    TENANT_ID,
    email,
    passwordHash,
    "USER",
    false
  );

  if (!result.success) {
    return result;
  }

  audit(
    TENANT_ID,
    result.user.id,
    "ACCOUNT_REGISTERED",
    "PENDING_APPROVAL",
    requestId
  );

  return result;
}

/**
 * List users within a tenant.
 */
export function listUsers(
  tenantId: string,
  includeStaffAndAdmins: boolean
) {
  return memoryStore.listUsers(
    tenantId,
    includeStaffAndAdmins
  );
}

/**
 * Activate or deactivate an account.
 */
export function setUserActive(
  tenantId: string,
  userId: string | number,
  isActive: boolean
): boolean {
  const success = memoryStore.setUserActive(
    tenantId,
    userId,
    isActive
  );

  if (success) {
    audit(
      tenantId,
      String(userId),
      isActive ? "ACCOUNT_ACTIVATED" : "ACCOUNT_DEACTIVATED",
      isActive ? "ACTIVE" : "INACTIVE",
      null
    );
  }

  return success;
}

/**
 * Verify that a user is an active regular user.
 * Used when assigning equipment to a user account.
 */
export function findActiveRegularUser(
  tenantId: string,
  userId: string | number
): MemoryUser | undefined {
  const user = memoryStore.findUserById(
    tenantId,
    userId
  );

  if (
    !user ||
    user.role !== "USER" ||
    !user.isActive ||
    user.approvalStatus !== "APPROVED" ||
    user.locked
  ) {
    return undefined;
  }

  return user;
}
