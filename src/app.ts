import Fastify, {
  type FastifyInstance,
  type FastifyRequest
} from "fastify";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { db } from "./db.js";
import { hashPassword } from "./password.js";

import { MySqlInventoryRepository } from "./mysql-inventory-repository.js";
import { authenticateUser } from "./auth-service.js";
import {
  DEVICE_STATUSES,
  DEVICE_TYPES,
  LOAN_STATUSES,
  MAINTENANCE_STATUSES,
  type InventoryRepository
} from "./types.js";

/**
 * JWT type definitions
 */
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub?: string;
      tenantId: string;
      roles: string[];
    };
    user: {
      sub?: string;
      tenantId: string;
      roles: string[];
    };
  }
}

/**
 * Validation helpers
 */
const positiveId = z.coerce.number().int().positive();

const deviceType = z.enum(DEVICE_TYPES);

const deviceStatus = z.enum(DEVICE_STATUSES);

const loanStatus = z.enum(LOAN_STATUSES);

const maintenanceStatus = z.enum(MAINTENANCE_STATUSES);

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
    "Invalid date"
  );

const dateTime = z.string().datetime({
  offset: true
});

const pagination = {
  cursor: positiveId.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
};

const nonempty = (max: number) =>
  z.string().trim().min(1).max(max);
const loginBodySchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(256),
}).strict();

const idParams = (name: string) =>
  z.object({
    [name]: positiveId
  });

/**
 * Request bodies
 */
const deviceBody = z
  .object({
    assetTag: nonempty(50),
    serialNumber: nonempty(100),
    deviceType,
    manufacturer: nonempty(100),
    model: nonempty(100),
    status: deviceStatus,
    centerId: positiveId
  })
  .strict();

const centerBody = z
  .object({
    centerName: nonempty(100),
    address: nonempty(255),
    phone: nonempty(20),
    isActive: z.boolean()
  })
  .strict();

const loanBody = z
  .object({
    deviceId: positiveId,
    centerId: positiveId,
    reasonId: positiveId,
    participantCode: nonempty(50),
    checkoutDate: dateTime,
    dueDate: dateTime
  })
  .strict()
  .refine(
    (value) => value.dueDate > value.checkoutDate,
    {
      message: "dueDate must be after checkoutDate",
      path: ["dueDate"]
    }
  );

const maintenanceBody = z
  .object({
    deviceId: positiveId,
    issueDescription: nonempty(65535),
    serviceDate: date
  })
  .strict();

/**
 * Development roles
 */
const developmentRoles = [
  "inventory:read",
  "inventory:write",
  "loans:read",
  "loans:write",
  "centers:read",
  "centers:write",
  "maintenance:read",
  "maintenance:write",
  "loan-reasons:read",
  "loan-reasons:write",
  "users:read",
  "users:write"
];
const staffRoles = [
  "inventory:read",
  "loans:read",
  "loans:write",
  "centers:read",
  "maintenance:read",
  "loan-reasons:read",
];
/**
 * Validation function
 */
function parse<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown
): z.output<S> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw Object.assign(
      new Error("Invalid request"),
      {
        statusCode: 400,
        issues: result.error.flatten()
      }
    );
  }

  return result.data;
}

/**
 * Role authorization
 */
function requireRole(
  request: FastifyRequest,
  role: string
) {
  if (!request.user.roles.includes(role)) {
    throw Object.assign(
      new Error("Insufficient permissions"),
      {
        statusCode: 403
      }
    );
  }
}

const authorize =
  (role: string) =>
  async (request: FastifyRequest) => {
    requireRole(request, role);
  };

/**
 * Pagination response
 */
const pageResponse = <T>(
  result: {
    items: T[];
    nextCursor?: number;
  },
  limit: number
) => ({
  data: result.items,
  page: {
    limit,
    nextCursor: result.nextCursor ?? null
  }
});

/**
 * Build Fastify application
 */
export async function buildApp(
  repository: InventoryRepository =
    new MySqlInventoryRepository()
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.body.password",
        "reply.headers.set-cookie"
      ]
    }
  });

  /**
   * Environment configuration
   */
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET must be set to at least 32 characters"
    );
  }

  /**
   * Security middleware
   */
  await app.register(helmet, {
    contentSecurityPolicy: false
  });

  /**
   * CORS
   *
   * Allows the local frontend to communicate with
   * the backend API.
   */
  await app.register(cors, {
    origin: [
      "http://localhost:5500",
      "http://127.0.0.1:5500"
    ],
    methods: [
      "GET",
      "POST",
      "PATCH",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ],
    credentials: false
  });

  /**
   * Rate limiting
   */
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute"
  });

  /**
   * JWT authentication
   */
  await app.register(jwt, {
    secret
  });

  /**
   * Global error handler
   */
  app.setErrorHandler(
    (error, request, reply) => {
      request.log.warn(
        {
          err: error,
          requestId: request.id
        },
        "Request failed"
      );

      const known = error as Error & {
        statusCode?: number;
        issues?: unknown;
      };

      const statusCode =
        known.statusCode &&
        known.statusCode >= 400
          ? known.statusCode
          : 500;

      reply
        .code(statusCode)
        .send({
          error:
            statusCode === 500
              ? "Internal server error"
              : known.message,
          requestId: request.id,
          ...(known.issues
            ? {
                details: known.issues
              }
            : {})
        });
    }
  );

  /**
   * Staff portal (single-page frontend)
   */
  const portalUrl = new URL("../frontend/index.html", import.meta.url);
  app.get("/", async (_request, reply) => {
    const html = await readFile(portalUrl, "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  /**
   * Health check
   */
app.post(
  "/v1/auth/login",
  {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 minute",
      },
    },
  },
  async (request, reply) => {
    const body = parse(loginBodySchema, request.body);

    const result = await authenticateUser(
      body.email,
      body.password,
      request.id,
    );

    if (!result.success) {
      return reply.code(401).send({
        error: "Invalid email or password",
        requestId: request.id,
      });
    }

    const permissions = result.user.permissions;

    const token = await reply.jwtSign(
      {
        sub: result.user.id,
        tenantId: result.user.tenantId,
        permissions,
      },
      { expiresIn: "15m" },
    );

    return {
      token,
      tokenType: "Bearer",
      expiresIn: "15m",
      user: {
        id: result.user.id,
        email: result.user.email,
        role: result.user.role,
        permissions,
      },
    };
  },
);

  /**
   * JWT authentication hook
   *
   * Development token endpoint remains public.
   */
 app.addHook(
    "onRequest",
    async (request) => {
      const pathname = request.url.split("?")[0] ?? request.url;

      if (
        !pathname.startsWith("/v1/") ||
        pathname === "/v1/dev/token" ||
        pathname === "/v1/auth/login"
      ) {
        return;
      }

      await request.jwtVerify();
    }
  );

  /**
   * ============================
   * USERS (admin only)
   * ============================
   */

  const userBody = z
    .object({
      email: z.string().trim().toLowerCase().email().max(255),
      password: z.string().min(12).max(256),
      role: z.enum(["ADMIN", "STAFF"])
    })
    .strict();

  app.get(
    "/v1/users",
    { preHandler: authorize("users:read") },
    async (request) => {
      const [rows] = await db.execute(
        `SELECT id, email, role, is_active
           FROM users
          WHERE tenant_id = ?
          ORDER BY id`,
        [request.user.tenantId]
      );

      return {
        data: (rows as any[]).map((row) => ({
          userId: Number(row.id),
          email: row.email,
          role: row.role,
          isActive: Boolean(row.is_active)
        }))
      };
    }
  );

  app.post(
    "/v1/users",
    { preHandler: authorize("users:write") },
    async (request, reply) => {
      const body = parse(userBody, request.body);
      const passwordHash = await hashPassword(body.password);

      try {
        const [result] = await db.execute(
          `INSERT INTO users
             (tenant_id, email, password_hash, role, is_active)
           VALUES (?, ?, ?, ?, 1)`,
          [request.user.tenantId, body.email, passwordHash, body.role]
        );

        return reply.code(201).send({
          data: {
            userId: Number((result as { insertId: number }).insertId),
            email: body.email,
            role: body.role,
            isActive: true
          }
        });
      } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          throw Object.assign(
            new Error("A user with that email already exists"),
            { statusCode: 409 }
          );
        }
        throw error;
      }
    }
  );

  app.patch(
    "/v1/users/:userId",
    { preHandler: authorize("users:write") },
    async (request) => {
      const { userId } = parse(
        idParams("userId"),
        request.params
      ) as { userId: number };

      const body = parse(
        z.object({ isActive: z.boolean() }).strict(),
        request.body
      );

      if (String(userId) === String(request.user.sub) && !body.isActive) {
        throw Object.assign(
          new Error("You cannot deactivate your own account"),
          { statusCode: 400 }
        );
      }

      const [result] = await db.execute(
        `UPDATE users SET is_active = ?
          WHERE id = ? AND tenant_id = ?`,
        [body.isActive ? 1 : 0, userId, request.user.tenantId]
      );

      if ((result as { affectedRows: number }).affectedRows === 0) {
        throw Object.assign(new Error("User not found"), {
          statusCode: 404
        });
      }

      return { data: { userId, isActive: body.isActive } };
    }
  );

  /**
   * ============================
   * INVENTORY / DEVICES
   * ============================
   */

  const deviceQuery = z
    .object({
      deviceType: deviceType.optional(),
      status: deviceStatus.optional(),
      centerId: positiveId.optional(),
      assetTag: nonempty(50).optional(),
      serialNumber: nonempty(100).optional(),
      manufacturer: nonempty(100).optional(),
      model: nonempty(100).optional(),
      search: nonempty(120).optional(),
      ...pagination
    })
    .strict();

  app.get(
    "/v1/inventory",
    {
      preHandler: authorize("inventory:read")
    },
    async (request) => {
      const query = parse(
        deviceQuery,
        request.query
      );

      const result =
        await repository.listDevices(
          request.user.tenantId,
          query
        );

      return pageResponse(
        result,
        query.limit
      );
    }
  );

  app.post(
    "/v1/inventory",
    {
      preHandler: authorize("inventory:write")
    },
    async (request, reply) => {
      const body = parse(
        deviceBody,
        request.body
      );

      const data =
        await repository.createDevice(
          request.user.tenantId,
          body
        );

      return reply
        .code(201)
        .send({ data });
    }
  );

  app.get(
    "/v1/inventory/:deviceId",
    {
      preHandler: authorize("inventory:read")
    },
    async (request, reply) => {
      const { deviceId } = parse(
        idParams("deviceId"),
        request.params
      ) as {
        deviceId: number;
      };

      const data =
        await repository.getDevice(
          request.user.tenantId,
          deviceId
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error: "Device not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  app.patch(
    "/v1/inventory/:deviceId",
    {
      preHandler: authorize("inventory:write")
    },
    async (request, reply) => {
      const { deviceId } = parse(
        idParams("deviceId"),
        request.params
      ) as {
        deviceId: number;
      };

      const body = parse(
        deviceBody
          .omit({ status: true })
          .partial()
          .refine(
            (value) =>
              Object.keys(value).length > 0,
            "At least one field is required"
          ),
        request.body
      );

      const data =
        await repository.updateDevice(
          request.user.tenantId,
          deviceId,
          body
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error: "Device not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  app.get(
    "/v1/inventory/:deviceId/history",
    {
      preHandler: authorize("inventory:read")
    },
    async (request, reply) => {
      const { deviceId } = parse(
        idParams("deviceId"),
        request.params
      ) as {
        deviceId: number;
      };

      const device =
        await repository.getDevice(
          request.user.tenantId,
          deviceId
        );

      if (!device) {
        return reply
          .code(404)
          .send({
            error: "Device not found",
            requestId: request.id
          });
      }

      const [loans, maintenance] =
        await Promise.all([
          repository.listLoans(
            request.user.tenantId,
            {
              deviceId,
              limit: 100
            }
          ),
          repository.listMaintenance(
            request.user.tenantId,
            {
              deviceId,
              limit: 100
            }
          )
        ]);

      return {
        data: {
          loans: loans.items,
          maintenanceRecords:
            maintenance.items
        }
      };
    }
  );

  app.get(
    "/v1/inventory/:deviceId/maintenance",
    {
      preHandler: authorize("maintenance:read")
    },
    async (request, reply) => {
      const { deviceId } = parse(
        idParams("deviceId"),
        request.params
      ) as {
        deviceId: number;
      };

      const device =
        await repository.getDevice(
          request.user.tenantId,
          deviceId
        );

      if (!device) {
        return reply
          .code(404)
          .send({
            error: "Device not found",
            requestId: request.id
          });
      }

      const query = parse(
        z.object(pagination).strict(),
        request.query
      );

      const result =
        await repository.listMaintenance(
          request.user.tenantId,
          {
            ...query,
            deviceId
          }
        );

      return pageResponse(
        result,
        query.limit
      );
    }
  );

  /**
   * ============================
   * OUTREACH CENTERS
   * ============================
   */

  const centerQuery = z
    .object({
      isActive: z
        .enum(["true", "false"])
        .transform(
          (value) => value === "true"
        )
        .optional(),

      search: nonempty(120).optional(),

      ...pagination
    })
    .strict();

  app.get(
    "/v1/centers",
    {
      preHandler: authorize("centers:read")
    },
    async (request) => {
      const query = parse(
        centerQuery,
        request.query
      );

      const result =
        await repository.listCenters(
          request.user.tenantId,
          query
        );

      return pageResponse(
        result,
        query.limit
      );
    }
  );

  app.post(
    "/v1/centers",
    {
      preHandler: authorize("centers:write")
    },
    async (request, reply) => {
      const body = parse(
        centerBody,
        request.body
      );

      const data =
        await repository.createCenter(
          request.user.tenantId,
          body
        );

      return reply
        .code(201)
        .send({ data });
    }
  );

  app.get(
    "/v1/centers/:centerId",
    {
      preHandler: authorize("centers:read")
    },
    async (request, reply) => {
      const { centerId } = parse(
        idParams("centerId"),
        request.params
      ) as {
        centerId: number;
      };

      const data =
        await repository.getCenter(
          request.user.tenantId,
          centerId
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error: "Center not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  app.patch(
    "/v1/centers/:centerId",
    {
      preHandler: authorize("centers:write")
    },
    async (request, reply) => {
      const { centerId } = parse(
        idParams("centerId"),
        request.params
      ) as {
        centerId: number;
      };

      const body = parse(
        centerBody
          .partial()
          .refine(
            (value) =>
              Object.keys(value).length > 0,
            "At least one field is required"
          ),
        request.body
      );

      const data =
        await repository.updateCenter(
          request.user.tenantId,
          centerId,
          body
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error: "Center not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  app.get(
    "/v1/centers/:centerId/inventory",
    {
      preHandler: authorize("inventory:read")
    },
    async (request, reply) => {
      const { centerId } = parse(
        idParams("centerId"),
        request.params
      ) as {
        centerId: number;
      };

      const center =
        await repository.getCenter(
          request.user.tenantId,
          centerId
        );

      if (!center) {
        return reply
          .code(404)
          .send({
            error: "Center not found",
            requestId: request.id
          });
      }

      const query = parse(
        z.object(pagination).strict(),
        request.query
      );

      const result =
        await repository.listDevices(
          request.user.tenantId,
          {
            ...query,
            centerId
          }
        );

      return pageResponse(
        result,
        query.limit
      );
    }
  );

  app.get(
    "/v1/centers/:centerId/loans",
    {
      preHandler: authorize("loans:read")
    },
    async (request, reply) => {
      const { centerId } = parse(
        idParams("centerId"),
        request.params
      ) as {
        centerId: number;
      };

      const center =
        await repository.getCenter(
          request.user.tenantId,
          centerId
        );

      if (!center) {
        return reply
          .code(404)
          .send({
            error: "Center not found",
            requestId: request.id
          });
      }

      const query = parse(
        z.object(pagination).strict(),
        request.query
      );

      const result =
        await repository.listLoans(
          request.user.tenantId,
          {
            ...query,
            centerId
          }
        );

      return pageResponse(
        result,
        query.limit
      );
    }
  );

  /**
   * ============================
   * LOANS
   * ============================
   */

  const loanQuery = z
    .object({
      loanStatus: loanStatus.optional(),
      centerId: positiveId.optional(),
      deviceId: positiveId.optional(),
      participantCode:
        nonempty(50).optional(),
      reasonId: positiveId.optional(),
      checkoutFrom:
        dateTime.optional(),
      checkoutTo:
        dateTime.optional(),
      dueFrom:
        dateTime.optional(),
      dueTo:
        dateTime.optional(),
      ...pagination
    })
    .strict();

  app.get(
    "/v1/loans",
    {
      preHandler: authorize("loans:read")
    },
    async (request) => {
      const query = parse(
        loanQuery,
        request.query
      );

      const result =
        await repository.listLoans(
          request.user.tenantId,
          query
        );

      return pageResponse(
        result,
        query.limit
      );
    }
  );

  app.post(
    "/v1/loans",
    {
      preHandler: authorize("loans:write")
    },
    async (request, reply) => {
      const body = parse(
        loanBody,
        request.body
      );

      const data =
        await repository.createLoan(
          request.user.tenantId,
          body
        );

      return reply
        .code(201)
        .send({ data });
    }
  );

  app.get(
    "/v1/loans/:loanId",
    {
      preHandler: authorize("loans:read")
    },
    async (request, reply) => {
      const { loanId } = parse(
        idParams("loanId"),
        request.params
      ) as {
        loanId: number;
      };

      const loan =
        await repository.getLoan(
          request.user.tenantId,
          loanId
        );

      if (!loan) {
        return reply
          .code(404)
          .send({
            error: "Loan not found",
            requestId: request.id
          });
      }

      const [
        device,
        center,
        reason
      ] = await Promise.all([
        repository.getDevice(
          request.user.tenantId,
          loan.deviceId
        ),
        repository.getCenter(
          request.user.tenantId,
          loan.centerId
        ),
        repository.getLoanReason(
          request.user.tenantId,
          loan.reasonId
        )
      ]);

      return {
        data: {
          ...loan,
          device,
          center,
          reason
        }
      };
    }
  );

  app.patch(
    "/v1/loans/:loanId",
    {
      preHandler: authorize("loans:write")
    },
    async (request, reply) => {
      const { loanId } = parse(
        idParams("loanId"),
        request.params
      ) as {
        loanId: number;
      };

      const body = parse(
        z
          .object({
            dueDate:
              dateTime.optional(),
            reasonId:
              positiveId.optional()
          })
          .strict()
          .refine(
            (value) =>
              Object.keys(value).length > 0,
            "At least one field is required"
          ),
        request.body
      );

      const data =
        await repository.updateLoan(
          request.user.tenantId,
          loanId,
          body
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error: "Loan not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  app.post(
    "/v1/loans/:loanId/return",
    {
      preHandler: authorize("loans:write")
    },
    async (request, reply) => {
      const { loanId } = parse(
        idParams("loanId"),
        request.params
      ) as {
        loanId: number;
      };

      const body = parse(
        z
          .object({
            returnDate:
              dateTime.default(
                () => new Date().toISOString()
              )
          })
          .strict(),
        request.body ?? {}
      );

      const data =
        await repository.returnLoan(
          request.user.tenantId,
          loanId,
          body.returnDate
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error: "Loan not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  /**
   * ============================
   * LOAN REASONS
   * ============================
   */

  app.get(
    "/v1/loan-reasons",
    {
      preHandler:
        authorize("loan-reasons:read")
    },
    async (request) => ({
      data:
        await repository.listLoanReasons(
          request.user.tenantId
        )
    })
  );

  app.post(
    "/v1/loan-reasons",
    {
      preHandler:
        authorize("loan-reasons:write")
    },
    async (request, reply) => {
      const body = parse(
        z
          .object({
            reasonName:
              nonempty(100)
          })
          .strict(),
        request.body
      );

      const data =
        await repository.createLoanReason(
          request.user.tenantId,
          body.reasonName
        );

      return reply
        .code(201)
        .send({ data });
    }
  );

  app.get(
    "/v1/loan-reasons/:reasonId",
    {
      preHandler:
        authorize("loan-reasons:read")
    },
    async (request, reply) => {
      const { reasonId } = parse(
        idParams("reasonId"),
        request.params
      ) as {
        reasonId: number;
      };

      const data =
        await repository.getLoanReason(
          request.user.tenantId,
          reasonId
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error: "Loan reason not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  app.patch(
    "/v1/loan-reasons/:reasonId",
    {
      preHandler:
        authorize("loan-reasons:write")
    },
    async (request, reply) => {
      const { reasonId } = parse(
        idParams("reasonId"),
        request.params
      ) as {
        reasonId: number;
      };

      const body = parse(
        z
          .object({
            reasonName:
              nonempty(100)
          })
          .strict(),
        request.body
      );

      const data =
        await repository.updateLoanReason(
          request.user.tenantId,
          reasonId,
          body.reasonName
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error: "Loan reason not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  /**
   * ============================
   * MAINTENANCE
   * ============================
   */

  const maintenanceQuery = z
    .object({
      deviceId:
        positiveId.optional(),

      maintenanceStatus:
        maintenanceStatus.optional(),

      serviceFrom:
        date.optional(),

      serviceTo:
        date.optional(),

      resolvedFrom:
        date.optional(),

      resolvedTo:
        date.optional(),

      ...pagination
    })
    .strict();

  app.get(
    "/v1/maintenance",
    {
      preHandler:
        authorize("maintenance:read")
    },
    async (request) => {
      const query = parse(
        maintenanceQuery,
        request.query
      );

      const result =
        await repository.listMaintenance(
          request.user.tenantId,
          query
        );

      return pageResponse(
        result,
        query.limit
      );
    }
  );

  app.post(
    "/v1/maintenance",
    {
      preHandler:
        authorize("maintenance:write")
    },
    async (request, reply) => {
      const body = parse(
        maintenanceBody,
        request.body
      );

      const data =
        await repository.createMaintenance(
          request.user.tenantId,
          body
        );

      return reply
        .code(201)
        .send({ data });
    }
  );

  app.get(
    "/v1/maintenance/:maintenanceId",
    {
      preHandler:
        authorize("maintenance:read")
    },
    async (request, reply) => {
      const { maintenanceId } = parse(
        idParams("maintenanceId"),
        request.params
      ) as {
        maintenanceId: number;
      };

      const data =
        await repository.getMaintenance(
          request.user.tenantId,
          maintenanceId
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error:
              "Maintenance record not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  app.patch(
    "/v1/maintenance/:maintenanceId",
    {
      preHandler:
        authorize("maintenance:write")
    },
    async (request, reply) => {
      const { maintenanceId } =
        parse(
          idParams("maintenanceId"),
          request.params
        ) as {
          maintenanceId: number;
        };

      const body = parse(
        z
          .object({
            issueDescription:
              nonempty(65535).optional(),

            maintenanceStatus:
              z
                .literal("IN_PROGRESS")
                .optional()
          })
          .strict()
          .refine(
            (value) =>
              Object.keys(value).length > 0,
            "At least one field is required"
          ),
        request.body
      );

      const data =
        await repository.updateMaintenance(
          request.user.tenantId,
          maintenanceId,
          body
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error:
              "Maintenance record not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  app.post(
    "/v1/maintenance/:maintenanceId/resolve",
    {
      preHandler:
        authorize("maintenance:write")
    },
    async (request, reply) => {
      const { maintenanceId } =
        parse(
          idParams("maintenanceId"),
          request.params
        ) as {
          maintenanceId: number;
        };

      const body = parse(
        z
          .object({
            resolvedDate:
              date.default(
                () =>
                  new Date()
                    .toISOString()
                    .slice(0, 10)
              )
          })
          .strict(),
        request.body ?? {}
      );

      const data =
        await repository.resolveMaintenance(
          request.user.tenantId,
          maintenanceId,
          body.resolvedDate
        );

      if (!data) {
        return reply
          .code(404)
          .send({
            error:
              "Maintenance record not found",
            requestId: request.id
          });
      }

      return { data };
    }
  );

  /**
   * ============================
   * DEVELOPMENT TOKEN
   * ============================
   *
   * This endpoint is intentionally
   * available only outside production.
   */
  if (process.env.NODE_ENV !== "production") {
    app.post(
      "/v1/dev/token",
      async (request, reply) => {
        const body = parse(
          z
            .object({
              tenantId:
                nonempty(120)
            })
            .strict(),
          request.body
        );

        const token =
          await reply.jwtSign(
            {
              tenantId:
                body.tenantId,
              roles:
                developmentRoles
            },
            {
              expiresIn: "15m"
            }
          );

        return {
          token,
          expiresIn: "15m"
        };
      }
    );
  }

  return app;
}
