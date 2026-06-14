const crypto = require("crypto");

/**
 * Symmetric encryption for tenant secrets (Stripe keys, webhook secrets).
 * AES-256-GCM. The 32-byte key comes from PAYMENT_ENC_KEY if set (hex/base64/
 * passphrase), otherwise it is derived from JWT_SECRET so the feature works
 * out-of-the-box — but set a dedicated PAYMENT_ENC_KEY in production.
 *
 * Ciphertext format: "<iv b64>:<authTag b64>:<data b64>".
 */
function getKey() {
  const raw = process.env.PAYMENT_ENC_KEY;
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex"); // exact 32-byte hex key
  }
  const seed = raw || process.env.JWT_SECRET || "ngo-platform-default-key";
  return crypto.createHash("sha256").update(String(seed)).digest(); // 32 bytes
}

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === "") return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(payload) {
  if (!payload) return "";
  try {
    const [ivB, tagB, dataB] = String(payload).split(":");
    if (!ivB || !tagB || !dataB) return "";
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
  } catch (e) {
    console.error("Secret decrypt failed:", e.message);
    return "";
  }
}

module.exports = { encrypt, decrypt };
