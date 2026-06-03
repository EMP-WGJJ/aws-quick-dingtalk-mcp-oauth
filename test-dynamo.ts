/**
 * DynamoStorage 本地集成测试脚本
 *
 * 针对 DynamoDB Local 验证 DynamoStorage 的核心逻辑，重点覆盖：
 * - Client / AuthSession / McpCode / Token 的增删查往返
 * - Token 双键查找（accessToken 主记录 + refreshToken 指针）
 * - 应用层过期校验（session 10min / code 5min / access token）
 * - access token 过期但 refresh 仍可用（续期场景）
 * - deleteToken 同时清除主记录与指针（事务一致性）
 * - TTL 字段（expireAt）正确写入
 * - 敏感字段加解密往返（默认透传；设置 TEST_KMS_KEY_ID 可测真实 KMS）
 *
 * 前置条件：启动 DynamoDB Local
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * 运行方式：
 *   npx tsx test-dynamo.ts
 *   # 或测真实 KMS 加密：TEST_KMS_KEY_ID=<keyId> npx tsx test-dynamo.ts
 */

// ⚠️ 必须最先 import 本模块以预设环境变量。
// ES module 的 import 会被提升并按顺序执行，config.ts 在加载时即读取
// process.env，因此环境变量必须在 config 加载前设置（见 test-dynamo-env.ts 说明）。
import './test-dynamo-env';

import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoStorage } from './src/storage/dynamo';
import {
  ClientRecord,
  AuthSession,
  McpCode,
  TokenRecord,
} from './src/storage/interface';

const TABLE = process.env.DYNAMO_TABLE_NAME!;
const ENDPOINT = process.env.DYNAMO_ENDPOINT!;
const REGION = process.env.AWS_REGION!;

const rawClient = new DynamoDBClient({ region: REGION, endpoint: ENDPOINT });
const rawDoc = DynamoDBDocumentClient.from(rawClient);

// ============ 极简测试 harness ============
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}（期望 ${String(expected)}，实际 ${String(actual)}）`);
  }
}

// ============ 测试数据工厂 ============
const MINUTE = 60 * 1000;

function makeClient(id: string): ClientRecord {
  return {
    clientId: id,
    clientSecretHash: 'hash_secret',
    redirectUris: ['https://example.com/cb'],
    clientName: 'Test Client',
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'none',
    createdAt: Date.now(),
  };
}

function makeSession(id: string, createdAt = Date.now()): AuthSession {
  return {
    sessionId: id,
    clientId: 'client_x',
    redirectUri: 'https://example.com/cb',
    state: 'state_abc',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
    scope: 'openid',
    createdAt,
  };
}

function makeCode(code: string, createdAt = Date.now()): McpCode {
  return {
    code,
    sessionId: 'session_x',
    dingtalkAccessToken: 'dt_access_secret',
    dingtalkRefreshToken: 'dt_refresh_secret',
    dingtalkTokenExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
    corpId: 'corp_1',
    userId: 'user_1',
    createdAt,
  };
}

function makeToken(
  accessToken: string,
  refreshToken: string,
  overrides: Partial<TokenRecord> = {}
): TokenRecord {
  const now = Date.now();
  return {
    mcpAccessToken: accessToken,
    mcpRefreshToken: refreshToken,
    clientId: 'client_x',
    userId: 'user_1',
    corpId: 'corp_1',
    scope: 'openid',
    dingtalkAccessToken: 'dt_access_secret',
    dingtalkRefreshToken: 'dt_refresh_secret',
    dingtalkTokenExpiresAt: now + 2 * 60 * 60 * 1000,
    mcpTokenExpiresAt: now + 60 * MINUTE,
    createdAt: now,
    ...overrides,
  };
}

// ============ 建表 / 清表 ============
async function deleteTableIfExists(): Promise<void> {
  try {
    await rawClient.send(new DeleteTableCommand({ TableName: TABLE }));
    await waitUntilTableNotExists({ client: rawClient, maxWaitTime: 30 }, { TableName: TABLE });
  } catch (e) {
    if ((e as Error).name !== 'ResourceNotFoundException') throw e;
  }
}

async function createTable(): Promise<void> {
  await rawClient.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    })
  );
  await waitUntilTableExists({ client: rawClient, maxWaitTime: 30 }, { TableName: TABLE });
}

/** 直接读底层 item，用于验证 TTL 字段等存储细节 */
async function getRawItem(pk: string): Promise<Record<string, any> | undefined> {
  const res = await rawDoc.send(new GetCommand({ TableName: TABLE, Key: { pk } }));
  return res.Item;
}

// ============ 主流程 ============
async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   DynamoStorage 本地集成测试                    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  表名: ${TABLE}`);
  console.log(`  端点: ${ENDPOINT}`);
  console.log(`  KMS 加密: ${process.env.KMS_KEY_ID ? '启用（真实 KMS）' : '关闭（透传）'}`);
  console.log('');

  console.log('[setup] 重建测试表...');
  await deleteTableIfExists();
  await createTable();
  console.log('  ✓ 表已就绪');
  console.log('');

  const storage = new DynamoStorage();

  // ---------- Client ----------
  console.log('[Client]');
  await test('saveClient + getClient 往返一致', async () => {
    const c = makeClient('client_a');
    await storage.saveClient(c);
    const got = await storage.getClient('client_a');
    assert(got !== null, 'client 应存在');
    assertEqual(got!.clientId, c.clientId, 'clientId 一致');
    assertEqual(got!.clientName, c.clientName, 'clientName 一致');
    assertEqual(got!.redirectUris[0], c.redirectUris[0], 'redirectUri 一致');
  });
  await test('getClient 不存在返回 null', async () => {
    const got = await storage.getClient('not_exist');
    assertEqual(got, null, '应返回 null');
  });

  // ---------- AuthSession ----------
  console.log('[AuthSession]');
  await test('saveAuthSession + getAuthSession 往返', async () => {
    const s = makeSession('sess_1');
    await storage.saveAuthSession(s);
    const got = await storage.getAuthSession('sess_1');
    assert(got !== null, 'session 应存在');
    assertEqual(got!.codeChallenge, s.codeChallenge, 'codeChallenge 一致');
  });
  await test('过期 session（createdAt 20min 前）读取返回 null', async () => {
    const s = makeSession('sess_expired', Date.now() - 20 * MINUTE);
    await storage.saveAuthSession(s);
    const got = await storage.getAuthSession('sess_expired');
    assertEqual(got, null, '过期 session 应返回 null');
  });
  await test('deleteAuthSession 后返回 null', async () => {
    const s = makeSession('sess_del');
    await storage.saveAuthSession(s);
    await storage.deleteAuthSession('sess_del');
    const got = await storage.getAuthSession('sess_del');
    assertEqual(got, null, '删除后应返回 null');
  });
  await test('saveAuthSession 写入 TTL expireAt 字段', async () => {
    const s = makeSession('sess_ttl');
    await storage.saveAuthSession(s);
    const item = await getRawItem('SESSION#sess_ttl');
    assert(item !== undefined, 'item 应存在');
    assert(typeof item!.expireAt === 'number', 'expireAt 应为数字');
    assertEqual(item!.expireAt, Math.floor((s.createdAt + 10 * MINUTE) / 1000), 'expireAt 应为 createdAt+10min 的秒值');
  });

  // ---------- McpCode ----------
  console.log('[McpCode]');
  await test('saveMcpCode + getMcpCode 往返（含钉钉 token 字段完整）', async () => {
    const c = makeCode('code_1');
    await storage.saveMcpCode(c);
    const got = await storage.getMcpCode('code_1');
    assert(got !== null, 'code 应存在');
    assertEqual(got!.userId, c.userId, 'userId 一致');
    assertEqual(got!.dingtalkAccessToken, c.dingtalkAccessToken, '钉钉 access token 解密后一致');
    assertEqual(got!.dingtalkRefreshToken, c.dingtalkRefreshToken, '钉钉 refresh token 解密后一致');
  });
  await test('过期 code（createdAt 10min 前）读取返回 null', async () => {
    const c = makeCode('code_expired', Date.now() - 10 * MINUTE);
    await storage.saveMcpCode(c);
    const got = await storage.getMcpCode('code_expired');
    assertEqual(got, null, '过期 code 应返回 null');
  });
  await test('deleteMcpCode 后返回 null', async () => {
    const c = makeCode('code_del');
    await storage.saveMcpCode(c);
    await storage.deleteMcpCode('code_del');
    const got = await storage.getMcpCode('code_del');
    assertEqual(got, null, '删除后应返回 null');
  });

  // ---------- Token（核心） ----------
  console.log('[Token]');
  await test('saveToken + getTokenByAccessToken 往返', async () => {
    const t = makeToken('at_1', 'rt_1');
    await storage.saveToken(t);
    const got = await storage.getTokenByAccessToken('at_1');
    assert(got !== null, 'token 应存在');
    assertEqual(got!.mcpRefreshToken, 'rt_1', 'refreshToken 一致');
    assertEqual(got!.dingtalkAccessToken, t.dingtalkAccessToken, '钉钉 token 解密后一致');
  });
  await test('getTokenByRefreshToken 通过指针拿到同一记录', async () => {
    const t = makeToken('at_2', 'rt_2');
    await storage.saveToken(t);
    const got = await storage.getTokenByRefreshToken('rt_2');
    assert(got !== null, '应通过 refresh 指针查到');
    assertEqual(got!.mcpAccessToken, 'at_2', '指针应指向正确的 accessToken');
  });
  await test('access token 过期时 getByAccessToken 返回 null，但 getByRefreshToken 仍可用', async () => {
    const t = makeToken('at_3', 'rt_3', { mcpTokenExpiresAt: Date.now() - 1000 });
    await storage.saveToken(t);
    const byAccess = await storage.getTokenByAccessToken('at_3');
    assertEqual(byAccess, null, 'access 过期应返回 null');
    const byRefresh = await storage.getTokenByRefreshToken('rt_3');
    assert(byRefresh !== null, 'refresh 续期场景应仍能查到（不校验 access 过期）');
    assertEqual(byRefresh!.mcpAccessToken, 'at_3', 'refresh 应查到正确记录');
  });
  await test('deleteToken 同时清除主记录与 refresh 指针', async () => {
    const t = makeToken('at_4', 'rt_4');
    await storage.saveToken(t);
    await storage.deleteToken('at_4');
    const byAccess = await storage.getTokenByAccessToken('at_4');
    const byRefresh = await storage.getTokenByRefreshToken('rt_4');
    assertEqual(byAccess, null, '主记录应已删除');
    assertEqual(byRefresh, null, 'refresh 指针应已删除');
    // 底层确认指针 item 物理删除
    const pointer = await getRawItem('REFRESH#rt_4');
    assertEqual(pointer, undefined, 'REFRESH 指针 item 应物理删除');
  });
  await test('token 主记录与指针写入 TTL（对齐 refresh 30 天）', async () => {
    const t = makeToken('at_5', 'rt_5');
    await storage.saveToken(t);
    const main = await getRawItem('TOKEN#at_5');
    const pointer = await getRawItem('REFRESH#rt_5');
    assert(typeof main!.expireAt === 'number', '主记录 expireAt 应为数字');
    assert(typeof pointer!.expireAt === 'number', '指针 expireAt 应为数字');
    assertEqual(main!.expireAt, pointer!.expireAt, '主记录与指针 TTL 应一致');
    const expected = Math.floor((t.createdAt + 30 * 24 * 60 * MINUTE) / 1000);
    assertEqual(main!.expireAt, expected, 'expireAt 应对齐 refresh 30 天');
  });
  await test('token 轮换：保存新 token 后旧记录被替换', async () => {
    const oldToken = makeToken('at_old', 'rt_old');
    await storage.saveToken(oldToken);
    // 模拟刷新流程：删旧、存新
    await storage.deleteToken('at_old');
    const newToken = makeToken('at_new', 'rt_new');
    await storage.saveToken(newToken);

    assertEqual(await storage.getTokenByAccessToken('at_old'), null, '旧 access 应失效');
    assertEqual(await storage.getTokenByRefreshToken('rt_old'), null, '旧 refresh 应失效');
    const got = await storage.getTokenByRefreshToken('rt_new');
    assert(got !== null, '新 refresh 应可用');
    assertEqual(got!.mcpAccessToken, 'at_new', '新 refresh 指向新 access');
  });

  // ---------- 清理 ----------
  console.log('');
  console.log('[teardown] 删除测试表...');
  await deleteTableIfExists();
  console.log('  ✓ 已清理');

  // ---------- 汇总 ----------
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log(`  测试结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log(`  失败用例: ${failures.join(', ')}`);
    console.log('══════════════════════════════════════════════════');
    process.exit(1);
  }
  console.log('  🎉 全部通过');
  console.log('══════════════════════════════════════════════════');
}

main().catch((error) => {
  const msg = (error as Error).message || String(error);
  if (/ECONNREFUSED|fetch failed|connect/i.test(msg)) {
    console.error('');
    console.error('✗ 无法连接 DynamoDB Local。请先启动：');
    console.error('    docker run -p 8000:8000 amazon/dynamodb-local');
    console.error('');
  } else {
    console.error('测试运行失败:', msg);
  }
  process.exit(1);
});
