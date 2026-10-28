
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "./db.js";
import { hashPassword } from "./password.js";
import { createAccount } from "./auth-service.js";

const execFileAsync = promisify(execFile);
const TENANT_ID = "city-of-orlando";
const DEFAULT_EMAIL = "staff@orlando.gov";

async function readHidden(prompt: string): Promise<string> {
  const escapedPrompt = prompt.replace(/'/g, "''");

  const script = [
    `$secure = Read-Host '${escapedPrompt}' -AsSecureString`,
    "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }",
    "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
  ].join("\n");

  const { stdout } = await execFileAsync(
    `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ["-NoProfile", "-Command", script],
    { windowsHide: false }
  );

  return stdout.replace(/\r?\n$/, "");
}

async function main(): Promise<void> {
  try {
    const emailInput = await readHidden(
      `Enter staff email (default ${DEFAULT_EMAIL})`
    );
    const email = emailInput.trim().toLowerCase() || DEFAULT_EMAIL;

    const password = await readHidden(
      "Enter staff password (12-256 characters)"
    );
    const confirmation = await readHidden("Confirm staff password");

    if (password.length < 12 || password.length > 256) {
      throw new Error("Password must be between 12 and 256 characters.");
    }

    if (password !== confirmation) {
      throw new Error("Passwords do not match.");
    }

    const passwordHash = await hashPassword(password);

    const result = await createAccount(TENANT_ID, email, passwordHash, "STAFF");
    if (!result.success) throw new Error("An account with this email already exists for this tenant.");

    console.log("Staff account created successfully.");
    console.log("User ID:", result.user.id);
    console.log("Email:", email);
    console.log("Tenant:", TENANT_ID);
    console.log("Role: STAFF");
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ER_DUP_ENTRY"
  ) {
    console.error(
      "An account with this email already exists for this tenant."
    );
  } else {
    console.error(
      error instanceof Error
        ? error.message
        : "Staff account creation failed."
    );
  }

  process.exitCode = 1;
});
