import "server-only";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { serverEnv } from "./env";

function encryptionKey(): Buffer {
  const key = Buffer.from(serverEnv("CONFIG_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) throw new Error("CONFIG_ENCRYPTION_KEY 必须是 32 字节密钥的 Base64 编码。");
  return key;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(value: string): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("无法读取已保存的 API 密钥。");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
