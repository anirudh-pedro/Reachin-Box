import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

// Default 32-byte development key (used ONLY if SLACK_TOKEN_ENCRYPTION_KEY is unset in development)
const DEV_FALLBACK_KEY = 'reachinbox_slack_aes256_dev_key_32bytes_sec!';

/**
 * Resolves a 32-byte Buffer from the configured environment key.
 * Supports 64-character hex strings, 44-character base64 strings, or raw 32-byte strings.
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.SLACK_TOKEN_ENCRYPTION_KEY;

  if (!envKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: SLACK_TOKEN_ENCRYPTION_KEY environment variable is required in production.');
    }
    return crypto.scryptSync(DEV_FALLBACK_KEY, 'reachinbox_salt', 32);
  }

  // Hex encoded key (64 hex characters = 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }

  // Base64 encoded key
  if (envKey.length === 44 && envKey.endsWith('=')) {
    const buf = Buffer.from(envKey, 'base64');
    if (buf.length === 32) return buf;
  }

  // Raw string: if exactly 32 bytes, use as buffer; otherwise derive 32 bytes via scrypt
  if (Buffer.byteLength(envKey, 'utf8') === 32) {
    return Buffer.from(envKey, 'utf8');
  }

  return crypto.scryptSync(envKey, 'reachinbox_slack_salt', 32);
}

/**
 * Encrypts plaintext string using AES-256-GCM.
 * Output format: `iv:authTag:ciphertext` (all in hex format)
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext) {
    throw new Error('Plaintext cannot be empty');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an encrypted token string using AES-256-GCM.
 * Validates integrity via GCM authentication tag.
 */
export function decryptToken(encryptedString: string): string {
  if (!encryptedString) {
    throw new Error('Encrypted string cannot be empty');
  }

  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted token format. Expected iv:authTag:ciphertext');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid IV or auth tag length for AES-256-GCM');
  }

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err: any) {
    throw new Error(`Failed to decrypt token: ${err.message}. Authentication tag mismatch or invalid key.`);
  }
}

/**
 * Startup self-test to verify encryption and decryption are functioning before accepting traffic.
 */
export function validateEncryptionConfig(): boolean {
  try {
    const testSecret = 'reachinbox_verification_probe_' + Date.now();
    const ciphered = encryptToken(testSecret);
    const deciphered = decryptToken(ciphered);

    if (deciphered !== testSecret) {
      throw new Error('Self-test decryption returned mismatched value.');
    }
    return true;
  } catch (err: any) {
    console.error('❌ [Encryption] AES-256-GCM self-test failed:', err.message);
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Encryption configuration invalid in production: ' + err.message);
    }
    return false;
  }
}
