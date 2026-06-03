import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
} from '@aws-sdk/client-kms';
import { config } from '../config';

/**
 * 敏感字段加密工具
 *
 * 使用 AWS KMS 对钉钉 access_token / refresh_token 等敏感字段进行加密，
 * 避免明文落库。加密结果为 base64 编码的密文。
 *
 * 设计要点：
 * - 加密后的字符串带固定前缀 `kms:`，便于识别与向后兼容（明文数据可平滑迁移）。
 * - 未配置 KMS_KEY_ID 时（通常是本地开发），加解密退化为原样透传，
 *   不阻塞开发流程；生产环境务必配置 KMS_KEY_ID。
 */

const CIPHER_PREFIX = 'kms:';

let kmsClient: KMSClient | null = null;

function getClient(): KMSClient {
  if (!kmsClient) {
    kmsClient = new KMSClient({ region: config.aws.region });
  }
  return kmsClient;
}

/**
 * 是否启用了 KMS 加密
 */
export function isEncryptionEnabled(): boolean {
  return Boolean(config.kms.keyId);
}

/**
 * 加密明文。未启用 KMS 时原样返回。
 */
export async function encrypt(plaintext: string): Promise<string> {
  if (!plaintext) return plaintext;
  if (!isEncryptionEnabled()) return plaintext;

  const command = new EncryptCommand({
    KeyId: config.kms.keyId,
    Plaintext: Buffer.from(plaintext, 'utf-8'),
  });

  const result = await getClient().send(command);
  if (!result.CiphertextBlob) {
    throw new Error('KMS 加密失败：未返回密文');
  }

  const ciphertext = Buffer.from(result.CiphertextBlob).toString('base64');
  return `${CIPHER_PREFIX}${ciphertext}`;
}

/**
 * 解密密文。
 * - 对未加密（无前缀）的历史明文数据原样返回，保证向后兼容。
 * - 未启用 KMS 时原样返回。
 */
export async function decrypt(value: string): Promise<string> {
  if (!value) return value;

  // 没有前缀说明是明文（历史数据或未启用加密时写入），直接返回
  if (!value.startsWith(CIPHER_PREFIX)) {
    return value;
  }

  if (!isEncryptionEnabled()) {
    // 数据是密文但当前未配置 KMS，无法解密
    throw new Error('检测到加密数据，但未配置 KMS_KEY_ID，无法解密');
  }

  const ciphertext = value.substring(CIPHER_PREFIX.length);
  const command = new DecryptCommand({
    KeyId: config.kms.keyId,
    CiphertextBlob: Buffer.from(ciphertext, 'base64'),
  });

  const result = await getClient().send(command);
  if (!result.Plaintext) {
    throw new Error('KMS 解密失败：未返回明文');
  }

  return Buffer.from(result.Plaintext).toString('utf-8');
}
