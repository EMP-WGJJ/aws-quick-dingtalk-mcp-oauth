import {
  IStorage,
  ClientRecord,
  AuthSession,
  McpCode,
  TokenRecord,
} from './interface';

/**
 * 内存存储实现（开发用）
 * 注意：进程重启后数据丢失，生产环境请使用 Redis
 */
export class MemoryStorage implements IStorage {
  private clients = new Map<string, ClientRecord>();
  private authSessions = new Map<string, AuthSession>();
  private mcpCodes = new Map<string, McpCode>();
  private tokens = new Map<string, TokenRecord>();
  private refreshTokenIndex = new Map<string, string>(); // refreshToken → accessToken

  async getClient(clientId: string): Promise<ClientRecord | null> {
    return this.clients.get(clientId) || null;
  }

  async saveClient(client: ClientRecord): Promise<void> {
    this.clients.set(client.clientId, client);
  }

  async getAuthSession(sessionId: string): Promise<AuthSession | null> {
    const session = this.authSessions.get(sessionId);
    if (!session) return null;

    // 检查是否过期（10分钟）
    if (Date.now() - session.createdAt > 10 * 60 * 1000) {
      this.authSessions.delete(sessionId);
      return null;
    }
    return session;
  }

  async saveAuthSession(session: AuthSession): Promise<void> {
    this.authSessions.set(session.sessionId, session);
  }

  async deleteAuthSession(sessionId: string): Promise<void> {
    this.authSessions.delete(sessionId);
  }

  async getMcpCode(code: string): Promise<McpCode | null> {
    const mcpCode = this.mcpCodes.get(code);
    if (!mcpCode) return null;

    // 检查是否过期（5分钟）
    if (Date.now() - mcpCode.createdAt > 5 * 60 * 1000) {
      this.mcpCodes.delete(code);
      return null;
    }
    return mcpCode;
  }

  async saveMcpCode(mcpCode: McpCode): Promise<void> {
    this.mcpCodes.set(mcpCode.code, mcpCode);
  }

  async deleteMcpCode(code: string): Promise<void> {
    this.mcpCodes.delete(code);
  }

  async getTokenByAccessToken(accessToken: string): Promise<TokenRecord | null> {
    const token = this.tokens.get(accessToken);
    if (!token) return null;

    // 检查 MCP token 是否过期
    if (Date.now() > token.mcpTokenExpiresAt) {
      return null; // 过期但不删除，可能还能通过 refresh 续期
    }
    return token;
  }

  async getTokenByRefreshToken(refreshToken: string): Promise<TokenRecord | null> {
    const accessToken = this.refreshTokenIndex.get(refreshToken);
    if (!accessToken) return null;
    return this.tokens.get(accessToken) || null;
  }

  async saveToken(token: TokenRecord): Promise<void> {
    this.tokens.set(token.mcpAccessToken, token);
    this.refreshTokenIndex.set(token.mcpRefreshToken, token.mcpAccessToken);
  }

  async deleteToken(accessToken: string): Promise<void> {
    const token = this.tokens.get(accessToken);
    if (token) {
      this.refreshTokenIndex.delete(token.mcpRefreshToken);
    }
    this.tokens.delete(accessToken);
  }
}
