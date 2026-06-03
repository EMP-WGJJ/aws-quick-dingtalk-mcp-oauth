import { randomUUID, createHash } from 'crypto';

/**
 * 生成随机 token
 * 格式：前缀_随机UUID（去掉横线）
 */
export function generateToken(prefix: string): string {
  const random = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  return `${prefix}_${random.substring(0, 48)}`;
}

/**
 * 生成 session ID
 */
export function generateSessionId(): string {
  return randomUUID();
}

/**
 * 生成 MCP authorization code
 */
export function generateMcpCode(): string {
  return generateToken('mcp_code');
}

/**
 * 生成 MCP access token
 */
export function generateMcpAccessToken(): string {
  return generateToken('mcp_at');
}

/**
 * 生成 MCP refresh token
 */
export function generateMcpRefreshToken(): string {
  return generateToken('mcp_rt');
}

/**
 * 生成 client ID
 */
export function generateClientId(): string {
  return `client_${randomUUID().replace(/-/g, '').substring(0, 16)}`;
}

/**
 * SHA256 哈希
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * SHA256 Base64URL 编码（用于 PKCE 验证）
 */
export function sha256Base64Url(input: string): string {
  return createHash('sha256')
    .update(input)
    .digest('base64url');
}

/**
 * 验证 PKCE code_verifier
 * code_challenge = BASE64URL(SHA256(code_verifier))
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = sha256Base64Url(codeVerifier);
  return computed === codeChallenge;
}
