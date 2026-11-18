import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  encryptToken,
  decryptToken,
  validateEncryptionConfig,
} from '../src/utils/encryption.js';

describe('Slack Token AES-256-GCM Encryption Unit Tests', () => {
  it('encrypts and decrypts a Slack bot token successfully round-trip', () => {
    const rawSlackToken = 'mock-slack-bot-token-sample-value-for-testing-only';
    const encrypted = encryptToken(rawSlackToken);

    assert.ok(encrypted, 'Encrypted string must exist');
    assert.notStrictEqual(encrypted, rawSlackToken, 'Ciphertext must not be plaintext');
    assert.ok(!encrypted.includes('mock-slack-bot-token'), 'Plaintext token pattern must not appear in encrypted payload');

    // Expected format: iv:authTag:ciphertext (3 parts)
    const parts = encrypted.split(':');
    assert.strictEqual(parts.length, 3, 'Must contain IV, Auth Tag, and Ciphertext separated by colons');
    assert.strictEqual(parts[0].length, 24, 'IV must be 12 bytes (24 hex characters)');
    assert.strictEqual(parts[1].length, 32, 'Auth tag must be 16 bytes (32 hex characters)');

    // Decryption must match exactly
    const decrypted = decryptToken(encrypted);
    assert.strictEqual(decrypted, rawSlackToken, 'Decrypted token must match original plaintext');
  });

  it('encrypts and decrypts an Incoming Webhook URL successfully', () => {
    const rawWebhook = 'https://mock.slack.internal.test/services/T_MOCK_TEAM/B_MOCK_BOT/mock_incoming_secret_key';
    const encrypted = encryptToken(rawWebhook);

    assert.ok(!encrypted.includes('mock.slack.internal.test'), 'Webhook URL must not appear in plaintext');
    const decrypted = decryptToken(encrypted);
    assert.strictEqual(decrypted, rawWebhook);
  });

  it('rejects tampered ciphertext with authentication tag mismatch', () => {
    const rawToken = 'mock-tamper-test-token-12345';
    const encrypted = encryptToken(rawToken);
    const parts = encrypted.split(':');

    // Tamper with the ciphertext byte
    const tamperedCiphertext = parts[2].substring(0, parts[2].length - 2) + (parts[2].endsWith('a') ? 'b' : 'a');
    const tamperedPayload = `${parts[0]}:${parts[1]}:${tamperedCiphertext}`;

    assert.throws(
      () => {
        decryptToken(tamperedPayload);
      },
      (err: any) => {
        return (
          err.message.includes('Authentication tag mismatch') ||
          err.message.includes('Failed to decrypt token')
        );
      },
      'Tampered ciphertext must fail GCM authentication check'
    );
  });

  it('rejects tampered authentication tag', () => {
    const rawToken = 'mock-auth-tag-tamper-test';
    const encrypted = encryptToken(rawToken);
    const parts = encrypted.split(':');

    // Tamper with the auth tag
    const tamperedTag = '00'.repeat(16);
    const tamperedPayload = `${parts[0]}:${tamperedTag}:${parts[2]}`;

    assert.throws(
      () => {
        decryptToken(tamperedPayload);
      },
      (err: any) => {
        return err.message.includes('Authentication tag mismatch') || err.message.includes('Failed to decrypt token');
      },
      'Tampered auth tag must fail verification'
    );
  });

  it('rejects malformed encrypted strings', () => {
    assert.throws(() => decryptToken('invalid_string_no_colons'), /Malformed encrypted token format/);
    assert.throws(() => decryptToken('only:two_parts'), /Malformed encrypted token format/);
    assert.throws(() => decryptToken(''), /Encrypted string cannot be empty/);
  });

  it('passes startup self-test verification probe', () => {
    const isHealthy = validateEncryptionConfig();
    assert.strictEqual(isHealthy, true, 'AES-256-GCM startup self-test probe must return true');
  });
});
