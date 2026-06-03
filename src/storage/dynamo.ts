import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  IStorage,
  ClientRecord,
  AuthSession,
  McpCode,
  TokenRecord,
} from './interface';
import { config } from '../config';
import { encrypt, decrypt } from '../utils/encryption';

/**
 * DynamoDB 存储实现（生产用）
 *
 * 单表设计（single-table design）：
 *   用分区键 `pk` 区分实体类型，所有实体共用一张表。
 *
 *   | 实体            | pk                        | 说明                     |
 *   |-----------------|---------------------------|--------------------------|
 *   | Client          | CLIENT#<clientId>         | 长期保留                 |
 *   | AuthSession     | SESSION#<sessionId>       | 临时态，带 TTL           |
 *   | McpCode         | CODE#<code>               | 临时态、一次性，带 TTL   |
 *   | Token 主记录    | TOKEN#<accessToken>       | 带 TTL                   |
 *   | Refresh 指针    | REFRESH#<refreshToken>    | 指向 accessToken，带 TTL |
 *
 * 关键设计：
 * - 双键查找：TokenRecord 需同时按 accessToken 和 refreshToken 查询。
 *   通过额外写一条 REFRESH# 指针 item（refreshToken → accessToken）解决，
 *   主记录与指针用 TransactWrite 保证一致性。
 * - 过期校验：保留应用层基于 createdAt / expiresAt 的过期判断，
 *   DynamoDB TTL（expireAt 属性）仅作兜底清理（删除可能延迟最长约 48h）。
 * - 敏感字段加密：钉钉 access/refresh token 经 KMS 加密后落库。
 */

// 各实体逻辑过期时长（毫秒），与 MemoryStorage 保持一致
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 分钟
const CODE_TTL_MS = 5 * 60 * 1000; // 5 分钟

type EntityType = 'CLIENT' | 'SESSION' | 'CODE' | 'TOKEN' | 'REFRESH';

export class DynamoStorage implements IStorage {
  private doc: DynamoDBDocumentClient;
  private table: string;

  constructor() {
    const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = {
      region: config.aws.region,
    };
    // 本地开发可指向 DynamoDB Local
    if (config.dynamo.endpoint) {
      clientConfig.endpoint = config.dynamo.endpoint;
    }
    const base = new DynamoDBClient(clientConfig);
    this.doc = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.table = config.dynamo.tableName;
  }

  private pk(type: EntityType, id: string): string {
    return `${type}#${id}`;
  }

  /** 将毫秒时间戳转为 DynamoDB TTL 所需的 Unix 秒 */
  private toEpochSeconds(ms: number): number {
    return Math.floor(ms / 1000);
  }

  // ============ Client ============

  async getClient(clientId: string): Promise<ClientRecord | null> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk('CLIENT', clientId) },
      })
    );
    if (!result.Item) return null;
    const { pk, expireAt, ...record } = result.Item;
    return record as ClientRecord;
  }

  async saveClient(client: ClientRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: this.pk('CLIENT', client.clientId),
          ...client,
        },
      })
    );
  }

  // ============ AuthSession ============

  async getAuthSession(sessionId: string): Promise<AuthSession | null> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk('SESSION', sessionId) },
      })
    );
    if (!result.Item) return null;

    const { pk, expireAt, ...record } = result.Item;
    const session = record as AuthSession;

    // 应用层过期校验（10 分钟）
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      await this.deleteAuthSession(sessionId);
      return null;
    }
    return session;
  }

  async saveAuthSession(session: AuthSession): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: this.pk('SESSION', session.sessionId),
          ...session,
          expireAt: this.toEpochSeconds(session.createdAt + SESSION_TTL_MS),
        },
      })
    );
  }

  async deleteAuthSession(sessionId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { pk: this.pk('SESSION', sessionId) },
      })
    );
  }

  // ============ McpCode ============

  async getMcpCode(code: string): Promise<McpCode | null> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk('CODE', code) },
      })
    );
    if (!result.Item) return null;

    const { pk, expireAt, ...record } = result.Item;
    const mcpCode = record as McpCode;

    // 应用层过期校验（5 分钟）
    if (Date.now() - mcpCode.createdAt > CODE_TTL_MS) {
      await this.deleteMcpCode(code);
      return null;
    }

    // 解密敏感字段
    mcpCode.dingtalkAccessToken = await decrypt(mcpCode.dingtalkAccessToken);
    mcpCode.dingtalkRefreshToken = await decrypt(mcpCode.dingtalkRefreshToken);
    return mcpCode;
  }

  async saveMcpCode(mcpCode: McpCode): Promise<void> {
    // 加密敏感字段后落库
    const encrypted: McpCode = {
      ...mcpCode,
      dingtalkAccessToken: await encrypt(mcpCode.dingtalkAccessToken),
      dingtalkRefreshToken: await encrypt(mcpCode.dingtalkRefreshToken),
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: this.pk('CODE', mcpCode.code),
          ...encrypted,
          expireAt: this.toEpochSeconds(mcpCode.createdAt + CODE_TTL_MS),
        },
      })
    );
  }

  async deleteMcpCode(code: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { pk: this.pk('CODE', code) },
      })
    );
  }

  // ============ Token ============

  async getTokenByAccessToken(accessToken: string): Promise<TokenRecord | null> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk('TOKEN', accessToken) },
      })
    );
    if (!result.Item) return null;

    const { pk, expireAt, ...record } = result.Item;
    const token = record as TokenRecord;

    // MCP token 过期则视为不可用（但不删除，可能还能 refresh 续期）
    if (Date.now() > token.mcpTokenExpiresAt) {
      return null;
    }

    return this.decryptToken(token);
  }

  async getTokenByRefreshToken(refreshToken: string): Promise<TokenRecord | null> {
    // 第一步：读指针 item 拿到 accessToken
    const pointer = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk('REFRESH', refreshToken) },
      })
    );
    if (!pointer.Item?.accessToken) return null;

    // 第二步：读主记录（不做 mcpTokenExpiresAt 过期判断，
    // 因为 refresh 场景本就用于续期已过期的 access token）
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk('TOKEN', pointer.Item.accessToken as string) },
      })
    );
    if (!result.Item) return null;

    const { pk, expireAt, ...record } = result.Item;
    return this.decryptToken(record as TokenRecord);
  }

  async saveToken(token: TokenRecord): Promise<void> {
    // 加密敏感字段
    const encrypted: TokenRecord = {
      ...token,
      dingtalkAccessToken: await encrypt(token.dingtalkAccessToken),
      dingtalkRefreshToken: await encrypt(token.dingtalkRefreshToken),
    };

    // refresh token 的物理过期对齐 refresh 有效期（30 天）
    const refreshExpireAt = this.toEpochSeconds(
      token.createdAt + config.mcp.refreshExpiry * 1000
    );

    // 主记录与指针 item 用事务一起写，保证一致性
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: {
                pk: this.pk('TOKEN', token.mcpAccessToken),
                ...encrypted,
                // 主记录保留到 refresh 过期，避免 access 先过期导致 refresh 查不到主记录
                expireAt: refreshExpireAt,
              },
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: {
                pk: this.pk('REFRESH', token.mcpRefreshToken),
                accessToken: token.mcpAccessToken,
                expireAt: refreshExpireAt,
              },
            },
          },
        ],
      })
    );
  }

  async deleteToken(accessToken: string): Promise<void> {
    // 先取主记录以拿到 refreshToken，才能一并删除指针
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk('TOKEN', accessToken) },
      })
    );

    if (!result.Item) {
      return;
    }

    const refreshToken = result.Item.mcpRefreshToken as string | undefined;

    if (refreshToken) {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.table,
                Key: { pk: this.pk('TOKEN', accessToken) },
              },
            },
            {
              Delete: {
                TableName: this.table,
                Key: { pk: this.pk('REFRESH', refreshToken) },
              },
            },
          ],
        })
      );
    } else {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { pk: this.pk('TOKEN', accessToken) },
        })
      );
    }
  }

  /** 解密 TokenRecord 的敏感字段 */
  private async decryptToken(token: TokenRecord): Promise<TokenRecord> {
    token.dingtalkAccessToken = await decrypt(token.dingtalkAccessToken);
    token.dingtalkRefreshToken = await decrypt(token.dingtalkRefreshToken);
    return token;
  }
}
