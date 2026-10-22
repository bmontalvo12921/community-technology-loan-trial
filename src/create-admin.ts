
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { db } from "./db.js";
import { hashPassword } from "./password.js";

const execFileAsync = promisify(execFile);
const TENANT_ID = "city-of-orlando";

async function promptHidden(prompt: string): Promise<string> {
  if (process.platform === "win32") {
    const escapedPrompt = prompt.replace(/'/g, "''");
    const script =
      `$secure = Read-Host '${escapedPrompt}' -AsSecureString; ` +
      "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); " +
      "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } " +
      "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }";

  const { stdout: password } = await execFileAsync(
  `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  ["-NoProfile", "-Command", script],
  { windowsHide: false, maxBuffer: 4096 },
);

    return password.replace(/\r?\n$/, "");
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(prompt);
    return answer;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const email = (await rl.question("Administrator email: "))
      .trim()
      .toLowerCase();

    if (
      email.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      throw new Error("Enter a valid email address.");
    }

    const password = await promptHidden("Administrator password: ");

    if (password.length < 12 || password.length > 256) {
      throw new Error("Password must be between 12 and 256 characters.");
    }

    const confirmation = await promptHidden("Confirm password: ");

    if (password !== confirmation) {
      throw new Error("Passwords do not match.");
    }

    const passwordHash = await hashPassword(password);

    const [result] = await db.execute(
      `INSERT INTO users
         (tenant_id, email, password_hash, role, is_active)
       VALUES (?, ?, ?, 'ADMIN', 1)`,
      [TENANT_ID, email, passwordHash],
    );

    console.log("Administrator account created successfully.");
    console.log(`User ID: ${(result as { insertId: number }).insertId}`);
    console.log(`Email: ${email}`);
    console.log(`Tenant: ${TENANT_ID}`);
    console.log("Role: ADMIN");
  } finally {
    rl.close();
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Administrator setup failed.",
  );
  process.exitCode = 1;
});
