# Community Outreach Technology Loan API

Fastify/TypeScript API for tenant-scoped outreach centers, devices, loans, loan reasons, and maintenance. JSON fields use camelCase; a MySQL repository maps them to snake_case columns.

## Run

```sh
npm install
copy .env.example .env
npm run dev
```

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

## Transaction and schema TODOs

- A production MySQL repository must wrap checkout, return, maintenance opening, and maintenance resolution in transactions.
- A dedicated device-event table is required to record transfers, manual status changes, and edits independently of loans and maintenance.
- Consider adding `is_active` to `loan_reasons` if reasons need to be retired without deletion.
- Add a separate readiness endpoint or check for MySQL connectivity.
## Credits
- [@luismonserratt](https://github.com/luismonserratt) — Added CORS support for frontend integration.
- [@johnathan-mcallister](https://github.com/johnathan-mcallister) — Original inventory API implementation.
