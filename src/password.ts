
import {
  randomBytes,
  pbkdf2 as pbkdf2Callback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const pbkdf2 = promisify(pbkdf2Callback);

const ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const SALT_LENGTH = 16;
const FORMAT = "pbkdf2-sha256";

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) {
    throw new Error("Password must be between 12 and 256 characters");
  }

  const salt = randomBytes(SALT_LENGTH);

  const derivedKey = await pbkdf2(
    password,
    salt,
    ITERATIONS,
    KEY_LENGTH,
    DIGEST,
  );

  return [
    FORMAT,
    ITERATIONS,
    salt.toString("base64"),
    derivedKey.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split("$");

  if (parts.length !== 4 || parts[0] !== FORMAT) {
    return false;
  }

  const iterations = Number(parts[1]);
  const saltText = parts[2];
  const keyText = parts[3];

  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 1 ||
    iterations > 1_000_000 ||
    !saltText ||
    !keyText
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(saltText, "base64");
    const expectedKey = Buffer.from(keyText, "base64");

    if (salt.length !== SALT_LENGTH || expectedKey.length !== KEY_LENGTH) {
      return false;
    }

    const actualKey = await pbkdf2(
      password,
      salt,
      iterations,
      KEY_LENGTH,
      DIGEST,
    );

    return timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  }
}
