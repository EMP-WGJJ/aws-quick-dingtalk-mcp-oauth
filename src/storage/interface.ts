/**
 * 存储接口定义
 * 支持 Redis 和内存两种实现
 */

export interface ClientRecord {
  clientId: string;
  clientSecretHash: string;
  redirectUris: string[];
  clientName: string;
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  createdAt: number;
}

export interface AuthSession {
  sessionId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  createdAt: number;
}

export interface McpCode {
  code: string;
  sessionId: string;
  dingtalkAccessToken: string;
  dingtalkRefreshToken: string;
  dingtalkTokenExpiresAt: number;
  corpId: string;
  userId: string;
  createdAt: number;
}

export interface TokenRecord {
  mcpAccessToken: string;
  mcpRefreshToken: string;
  clientId: string;
  userId: string;
  corpId: string;
  scope: string;
  dingtalkAccessToken: string;
  dingtalkRefreshToken: string;
  dingtalkTokenExpiresAt: number;
  mcpTokenExpiresAt: number;
  createdAt: number;
}

export interface IStorage {
  // Client 管理
  getClient(clientId: string): Promise<ClientRecord | null>;
  saveClient(client: ClientRecord): Promise<void>;

  // Auth Session 管理
  getAuthSession(sessionId: string): Promise<AuthSession | null>;
  saveAuthSession(session: AuthSession): Promise<void>;
  deleteAuthSession(sessionId: string): Promise<void>;

  // MCP Authorization Code 管理
  getMcpCode(code: string): Promise<McpCode | null>;
  saveMcpCode(mcpCode: McpCode): Promise<void>;
  deleteMcpCode(code: string): Promise<void>;

  // Token 管理
  getTokenByAccessToken(accessToken: string): Promise<TokenRecord | null>;
  getTokenByRefreshToken(refreshToken: string): Promise<TokenRecord | null>;
  saveToken(token: TokenRecord): Promise<void>;
  deleteToken(accessToken: string): Promise<void>;
}
