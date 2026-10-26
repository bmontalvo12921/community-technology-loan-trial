# Community Outreach Technology Loan

City of Orlando portal for lending laptops, tablets and hotspots through outreach centers. It is a Fastify/TypeScript API with a single-page staff portal (`frontend/index.html`) served at `/`, backed by MySQL. JSON fields use camelCase; the MySQL repository maps them to snake_case columns. Everything is scoped to the `city-of-orlando` tenant.

## Staff portal

Open `/` and sign in with a staff or admin account. Tabs: Inventory, Outreach Centers, Loans, Maintenance, and Users (admins only).

- **Loans:** assign equipment (pick a device, center and reason, type the borrower's name or participant ID, set the due date), edit an active loan's reason or due date, and mark it returned. Loan reasons are listed under the loans table; admins add new ones with "+ Add loan reason".
- **Admins** can also add equipment, centers, maintenance records and users, deactivate centers and users, and resolve maintenance.
- Records are deactivated, not deleted, so loan history stays intact. Borrowers are free text, not accounts.

| Role | Can do |
| --- | --- |
| `STAFF` | Read inventory, centers, loans, loan reasons and maintenance; create, edit and return loans |
| `ADMIN` | Everything staff can, plus write inventory, centers, loan reasons, maintenance and users |

## Run locally

```sh
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Fill in `.env`, then create the tables and accounts and start the API:

```sh
npm run build
SETUP_ADMIN_EMAIL=you@example.gov SETUP_ADMIN_PASSWORD='at-least-12-characters' npm run db:setup
npm run dev
```

| Variable | Purpose |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | MySQL connection |
| `JWT_SECRET` | Private signing key, at least 32 characters (add it to `.env`; it is not in `.env.example`) |
| `PORT` | Listen port, default `3020` |
| `NODE_ENV` | `production` disables `/v1/dev/token` |
| `SETUP_ADMIN_EMAIL`, `SETUP_ADMIN_PASSWORD` | Admin account created by `db:setup` if missing (password 12-256 characters) |
| `SETUP_STAFF_EMAIL`, `SETUP_STAFF_PASSWORD` | Optional staff account created the same way |

`npm run db:setup` (`src/setup-database.ts`) is safe to repeat. It creates the tables if they do not exist, adds five default loan reasons (Job search, School or education, Telehealth or medical appointment, Government services, Other) only when none exist, and creates the accounts above if their emails are missing. `npm start` runs it before the server. Remove the `SETUP_*` variables once the accounts exist, and never commit real credentials. You can also create accounts with `npx tsx src/create-admin.ts` and `src/create-staff.ts`.

## Deploy on Railway

1. Add a MySQL service to the project.
2. On the API service, set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` as reference variables to the MySQL service, plus `JWT_SECRET` and `NODE_ENV=production`.
3. For the first deploy also set the `SETUP_*` variables, then delete them.
4. The start command is `npm start`; `/health` returns `{"status":"ok"}` and works as a health check path.

## Sign in

`POST /v1/auth/login` takes `{ "email", "password" }` and returns `{ "token", "user": { "role" } }`. The bearer token is valid for 15 minutes; send it as `Authorization: Bearer <token>`. Invalid credentials return `401`, and login attempts are rate limited.

```sh
curl -X POST http://127.0.0.1:3020/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"YOUR_ADMIN_EMAIL","password":"YOUR_PASSWORD"}'
```

## API reference

All `/v1` endpoints except the development token endpoint require `Authorization: Bearer <JWT>`. Successful resource responses use `{ "data": ... }`. Paginated responses also contain `{ "page": { "limit": 25, "nextCursor": null } }`. Errors use `{ "error": string, "requestId": string }` and include validation details when applicable.

Protected endpoints can return `400` for invalid input, `401` for missing or invalid authentication, `403` for insufficient permissions, and `500` for unexpected errors. Resource-specific `404` and `409` responses are noted below.

## Health

### GET `/health`

- Use case: Check basic process health.
- Authentication: None.
- Required role: None.
- Request: No path parameters, query parameters, or body.
- Response: `200` with `{ "status": "ok" }`.
- Notes: MySQL connectivity/readiness is not currently checked separately.

## Inventory / Devices

### GET `/v1/inventory`

- Use case: Return a filtered, cursor-paginated list of devices.
- Authentication: JWT required.
- Required role: `inventory:read`.
- Query parameters: `deviceType`, `status`, `centerId`, `assetTag`, `serialNumber`, `manufacturer`, `model`, `search`, `cursor`, and `limit`.
- Response: `200` with a device array and pagination metadata.
- Constraints: `deviceType` is `LAPTOP`, `TABLET`, or `HOTSPOT`; `status` is `AVAILABLE`, `CHECKED_OUT`, or `MAINTENANCE`; IDs and cursors are positive integers; `limit` is 1–100 and defaults to 25.

### POST `/v1/inventory`

- Use case: Create a device assigned to an outreach center.
- Authentication: JWT required.
- Required role: `inventory:write`.
- Request body: `assetTag`, `serialNumber`, `deviceType`, `manufacturer`, `model`, `status`, and `centerId`.
- Response: `201` with the created device.
- Errors: `404` when the center does not exist; `409` for duplicate asset tags or serial numbers.
- Constraints: `assetTag` is 1–50 characters; `serialNumber`, `manufacturer`, and `model` are 1–100 characters; enum values must match those listed above.

### GET `/v1/inventory/{deviceId}`

- Use case: Return one device by its database primary key.
- Authentication: JWT required.
- Required role: `inventory:read`.
- Path parameters: `deviceId`, a positive integer.
- Response: `200` with the device.
- Errors: `404` when the device does not exist.

### PATCH `/v1/inventory/{deviceId}`

- Use case: Update editable device identity, descriptive, or center-assignment fields.
- Authentication: JWT required.
- Required role: `inventory:write`.
- Path parameters: `deviceId`, a positive integer.
- Request body: A nonempty subset of `assetTag`, `serialNumber`, `deviceType`, `manufacturer`, `model`, and `centerId`.
- Response: `200` with the updated device.
- Errors: `404` when the device or referenced center does not exist; `409` for uniqueness conflicts.
- Notes: `status` is intentionally excluded because checkout and maintenance operations control lifecycle transitions.

### GET `/v1/inventory/{deviceId}/history`

- Use case: Return schema-backed history associated with a device.
- Authentication: JWT required.
- Required role: `inventory:read`.
- Path parameters: `deviceId`, a positive integer.
- Response: `200` with `{ "data": { "loans": [], "maintenanceRecords": [] } }`.
- Errors: `404` when the device does not exist.
- Notes: Transfers, manual changes, and edits require a future dedicated device-event table.

### GET `/v1/inventory/{deviceId}/maintenance`

- Use case: Return maintenance history for one device.
- Authentication: JWT required.
- Required role: `maintenance:read`.
- Path parameters: `deviceId`, a positive integer.
- Query parameters: `cursor` and `limit`.
- Response: `200` with a maintenance-record page.
- Errors: `404` when the device does not exist.

## Outreach Centers

### GET `/v1/centers`

- Use case: Return outreach centers.
- Authentication: JWT required.
- Required role: `centers:read`.
- Query parameters: `isActive`, `search`, `cursor`, and `limit`.
- Response: `200` with a center page.
- Constraints: `isActive` is `true` or `false`; `search` is 1–120 characters.

### POST `/v1/centers`

- Use case: Create an outreach center.
- Authentication: JWT required.
- Required role: `centers:write`.
- Request body: `centerName`, `address`, `phone`, and `isActive`.
- Response: `201` with the created center.
- Constraints: `centerName` is 1–100 characters, `address` is 1–255, `phone` is 1–20, and `isActive` is boolean.

### GET `/v1/centers/{centerId}`

- Use case: Return one outreach center.
- Authentication: JWT required.
- Required role: `centers:read`.
- Path parameters: `centerId`, a positive integer.
- Response: `200` with the center.
- Errors: `404` when the center does not exist.

### PATCH `/v1/centers/{centerId}`

- Use case: Update an outreach center.
- Authentication: JWT required.
- Required role: `centers:write`.
- Path parameters: `centerId`, a positive integer.
- Request body: A nonempty subset of `centerName`, `address`, `phone`, and `isActive`.
- Response: `200` with the updated center.
- Errors: `404` when the center does not exist.

### GET `/v1/centers/{centerId}/inventory`

- Use case: Return devices assigned to a center.
- Authentication: JWT required.
- Required role: `inventory:read`.
- Path parameters: `centerId`, a positive integer.
- Query parameters: `cursor` and `limit`.
- Response: `200` with a device page.
- Errors: `404` when the center does not exist.

### GET `/v1/centers/{centerId}/loans`

- Use case: Return loans associated with a center.
- Authentication: JWT required.
- Required role: `loans:read`.
- Path parameters: `centerId`, a positive integer.
- Query parameters: `cursor` and `limit`.
- Response: `200` with a loan page.
- Errors: `404` when the center does not exist.

## Loans

### GET `/v1/loans`

- Use case: Return filtered, paginated loans.
- Authentication: JWT required.
- Required role: `loans:read`.
- Query parameters: `loanStatus`, `centerId`, `deviceId`, `participantCode`, `reasonId`, `checkoutFrom`, `checkoutTo`, `dueFrom`, `dueTo`, `cursor`, and `limit`.
- Response: `200` with a loan page.
- Constraints: `loanStatus` is `ACTIVE`, `RETURNED`, or `OVERDUE`; range values are ISO 8601 datetimes with offsets.

### POST `/v1/loans`

- Use case: Check out an available device.
- Authentication: JWT required.
- Required role: `loans:write`.
- Request body: `deviceId`, `centerId`, `reasonId`, `participantCode`, `checkoutDate`, and `dueDate`.
- Response: `201` with an `ACTIVE` loan; the device becomes `CHECKED_OUT`.
- Errors: `404` when a referenced device, center, or reason does not exist; `409` when the device is unavailable or already has an active loan.
- Constraints: IDs are positive integers; `participantCode` is 1–50 characters; dates are ISO 8601 datetimes; `dueDate` must be after `checkoutDate`.

### GET `/v1/loans/{loanId}`

- Use case: Return one loan with its related device, center, and loan reason when available.
- Authentication: JWT required.
- Required role: `loans:read`.
- Path parameters: `loanId`, a positive integer.
- Response: `200` with the enriched loan.
- Errors: `404` when the loan does not exist.

### PATCH `/v1/loans/{loanId}`

- Use case: Update editable details on a current loan.
- Authentication: JWT required.
- Required role: `loans:write`.
- Path parameters: `loanId`, a positive integer.
- Request body: A nonempty subset of `dueDate` and `reasonId`.
- Response: `200` with the updated loan.
- Errors: `404` when the loan does not exist; `409` for a missing reason or an invalid lifecycle state.
- Notes: Loan status and return date cannot be manipulated through this endpoint.

### POST `/v1/loans/{loanId}/return`

- Use case: Return a checked-out device.
- Authentication: JWT required.
- Required role: `loans:write`.
- Path parameters: `loanId`, a positive integer.
- Request body: Optional `returnDate` as an ISO 8601 datetime; the current time is used when omitted.
- Response: `200` with the `RETURNED` loan; the device becomes `AVAILABLE`.
- Errors: `404` when the loan does not exist; `409` when it was already returned.

## Loan Reasons

### GET `/v1/loan-reasons`

- Use case: Return all valid loan reasons.
- Authentication: JWT required.
- Required role: `loan-reasons:read`.
- Request: No path parameters, query parameters, or body.
- Response: `200` with a loan-reason array.

### POST `/v1/loan-reasons`

- Use case: Create a loan reason.
- Authentication: JWT required.
- Required role: `loan-reasons:write`.
- Request body: `reasonName`.
- Response: `201` with the created reason.
- Errors: `409` when the reason name already exists.
- Constraints: `reasonName` is 1–100 characters and unique.

### GET `/v1/loan-reasons/{reasonId}`

- Use case: Return one loan reason.
- Authentication: JWT required.
- Required role: `loan-reasons:read`.
- Path parameters: `reasonId`, a positive integer.
- Response: `200` with the reason.
- Errors: `404` when the reason does not exist.

### PATCH `/v1/loan-reasons/{reasonId}`

- Use case: Rename a loan reason.
- Authentication: JWT required.
- Required role: `loan-reasons:write`.
- Path parameters: `reasonId`, a positive integer.
- Request body: `reasonName`.
- Response: `200` with the updated reason.
- Errors: `404` when the reason does not exist; `409` when the new name is already used.
- Notes: Deletion is intentionally unsupported; an `is_active` column is a future schema recommendation.

## Maintenance Records

### GET `/v1/maintenance`

- Use case: Return filtered, paginated maintenance records.
- Authentication: JWT required.
- Required role: `maintenance:read`.
- Query parameters: `deviceId`, `maintenanceStatus`, `serviceFrom`, `serviceTo`, `resolvedFrom`, `resolvedTo`, `cursor`, and `limit`.
- Response: `200` with a maintenance-record page.
- Constraints: `maintenanceStatus` is `OPEN`, `IN_PROGRESS`, or `RESOLVED`; date filters use `YYYY-MM-DD`.

### POST `/v1/maintenance`

- Use case: Open maintenance for an available device.
- Authentication: JWT required.
- Required role: `maintenance:write`.
- Request body: `deviceId`, `issueDescription`, and `serviceDate`.
- Response: `201` with an `OPEN` maintenance record; the device becomes `MAINTENANCE`.
- Errors: `404` when the device does not exist; `409` when the device is checked out or already in maintenance.
- Constraints: `deviceId` is positive, `issueDescription` is nonempty, and `serviceDate` uses `YYYY-MM-DD`.

### GET `/v1/maintenance/{maintenanceId}`

- Use case: Return one maintenance record.
- Authentication: JWT required.
- Required role: `maintenance:read`.
- Path parameters: `maintenanceId`, a positive integer.
- Response: `200` with the maintenance record.
- Errors: `404` when the record does not exist.

### PATCH `/v1/maintenance/{maintenanceId}`

- Use case: Update the issue description or advance an open record to `IN_PROGRESS`.
- Authentication: JWT required.
- Required role: `maintenance:write`.
- Path parameters: `maintenanceId`, a positive integer.
- Request body: A nonempty subset of `issueDescription` and `maintenanceStatus`; the only accepted status is `IN_PROGRESS`.
- Response: `200` with the updated maintenance record.
- Errors: `404` when the record does not exist; `409` for invalid transitions or updates to resolved records.
- Notes: Resolution uses the explicit resolve endpoint.

### POST `/v1/maintenance/{maintenanceId}/resolve`

- Use case: Resolve maintenance and return the device to inventory.
- Authentication: JWT required.
- Required role: `maintenance:write`.
- Path parameters: `maintenanceId`, a positive integer.
- Request body: Optional `resolvedDate` using `YYYY-MM-DD`; the current date is used when omitted.
- Response: `200` with the `RESOLVED` record; the device becomes `AVAILABLE`.
- Errors: `404` when the record does not exist; `409` when already resolved or another active maintenance record exists for the device.

## Users

### GET `/v1/users`

- Use case: List accounts in the tenant.
- Authentication: JWT required.
- Required role: `users:read` (admin).
- Response: `200` with `{ userId, email, role, isActive }` entries.

### POST `/v1/users`

- Use case: Create an account.
- Authentication: JWT required.
- Required role: `users:write` (admin).
- Request body: `email`, `password` (12-256 characters) and `role` (`ADMIN` or `STAFF`).
- Response: `201` with the new user.
- Errors: `409` when the email already exists.

### PATCH `/v1/users/{userId}`

- Use case: Activate or deactivate an account.
- Authentication: JWT required.
- Required role: `users:write` (admin).
- Request body: `isActive` (boolean).
- Errors: `400` when you try to deactivate your own account.

## Development Authentication

### POST `/v1/dev/token`

- Use case: Generate a short-lived local-development JWT without supplying role attributes.
- Authentication: None.
- Required role: None.
- Availability: Development only; the route is not registered when `NODE_ENV === "production"`.
- Request body: `tenantId`, a string from 1–120 characters.
- Response: `200` with `{ "token": string, "expiresIn": "15m" }`.
- Notes: The server assigns all development API permissions to the signed token.

```sh
curl -X POST http://127.0.0.1:3020/v1/dev/token -H "content-type: application/json" -d "{\"tenantId\":\"eigen-it\"}"
```

## Known gaps

- A dedicated device-event table is needed to record transfers, manual status changes and edits independently of loans and maintenance.
- Consider adding `is_active` to `loan_reasons` to retire reasons without deletion.
- `/health` does not check MySQL connectivity.

## Credits
- [@luismonserratt](https://github.com/luismonserratt) — Added CORS support for frontend integration.
- [@johnathan-mcallister](https://github.com/johnathan-mcallister) — Original inventory API implementation.
