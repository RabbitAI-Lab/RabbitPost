/**
 * 数据库连接密码的可逆加密（AES-256-GCM）。
 * 密钥取环境变量 DB_SECRET_KEY（32 字节的 base64，生成：openssl rand -base64 32）。
 * 密文格式：v1:<ivB64>:<tagB64>:<ctB64>
 */
import crypto from "node:crypto";

const VERSION = "v1";

function loadKey(): Buffer {
  const raw = process.env.DB_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "DB_SECRET_KEY is not set (expected 32 bytes, base64; generate with: openssl rand -base64 32)",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `DB_SECRET_KEY must be a base64-encoded 32-byte key (decoded ${key.length} bytes)`,
    );
  }
  return key;
}

/** 加密 UTF-8 字符串，返回 v1:<ivB64>:<tagB64>:<ctB64> */
export function encryptSecret(plain: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(
    ":",
  );
}

/** 解密 encryptSecret 产出的密文；格式错误或认证失败时抛错 */
export function decryptSecret(payload: string): string {
  const key = loadKey();
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Invalid encrypted secret format (expected v1:<iv>:<tag>:<ct>)");
  }
  const ivB64 = parts[1]!;
  const tagB64 = parts[2]!;
  const ctB64 = parts[3]!;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new Error("Failed to decrypt secret (wrong key or corrupted payload)");
  }
}
