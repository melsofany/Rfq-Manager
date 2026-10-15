/**
 * Field encryption for HR sensitive data (national ID, bank account, IBAN).
 * AES-256-GCM. Key comes from HR_DATA_KEY (base64 of 32 random bytes).
 * Without the key, writes are refused — we never store these values in plain text.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
  const raw = process.env.HR_DATA_KEY;
  if (!raw) throw new HrKeyMissingError();
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new HrKeyMissingError();
  return k;
}

export class HrKeyMissingError extends Error {
  constructor() {
    super("HR_DATA_KEY is not set (32-byte base64). Sensitive HR data cannot be stored.");
  }
}

export function isHrKeyConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptField(payload: string): string {
  const [v, iv, tag, ct] = payload.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad HR ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

export function last4(v: string): string {
  return v.replace(/\s+/g, "").slice(-4);
}
