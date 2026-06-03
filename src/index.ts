import express from 'express';
import cors from 'cors';
import { config } from './config';
import { createStorage } from './storage/factory';
import metadataRouter from './oauth/metadata';
import { createRegisterRouter } from './oauth/register';
import { createAuthorizeRouter } from './oauth/authorize';
import { createTokenRouter } from './oauth/token';
import { createDingtalkCallbackRouter } from './dingtalk/callback';
import { createMcpAggregatorRouter } from './mcp/aggregator';

async function main() {
  const app = express();

  // 中间件
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 初始化存储（按 STORAGE_DRIVER 选择 memory / dynamo）
  const storage = createStorage();

  // 预注册 Quick Client
  // redirectUri 支持逗号分隔的多个地址，逐一加入白名单
  const quickRedirectUris = config.quick.redirectUri
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  await storage.saveClient({
    clientId: config.quick.clientId,
    clientSecretHash: config.quick.clientSecret ? config.quick.clientSecret : '',
    redirectUris: quickRedirectUris,
    clientName: 'Amazon Quick',
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'none',
    createdAt: Date.now(),
  });
  console.log(`[init] 预注册 Client: ${config.quick.clientId}, redirectUris=${JSON.stringify(quickRedirectUris)}`);

  // 挂载路由
  // OAuth Authorization Server
  app.use(metadataRouter);                              // /.well-known/oauth-authorization-server
  app.use(createRegisterRouter(storage));               // POST /register
  app.use(createAuthorizeRouter(storage));              // GET /authorize
  app.use(createTokenRouter(storage));                  // POST /token

  // 钉钉 OAuth Client
  app.use(createDingtalkCallbackRouter(storage));       // GET /dingtalk/callback

  // MCP 分组聚合网关（5 个分组，每组一个 endpoint）
  app.use(createMcpAggregatorRouter(storage));          // POST /mcp/:group, GET /mcp/groups

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 首页信息
  app.get('/', (_req, res) => {
    res.json({
      name: 'DingTalk MCP OAuth Gateway',
      version: '1.0.0',
      description: '为 MCP Client 提供标准 OAuth 2.1 接入，代理钉钉 OpenAPI',
      endpoints: {
        metadata: '/.well-known/oauth-authorization-server',
        authorize: '/authorize',
        token: '/token',
        register: '/register',
        mcpGroups: '/mcp/groups',
        mcp: '/mcp/{office|docs|tables|comm|danger}',
        dingtalkCallback: '/dingtalk/callback',
        health: '/health',
      },
    });
  });

  // 启动服务
  const server = app.listen(config.port, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   DingTalk MCP OAuth Gateway                    ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║   地址: ${config.baseUrl.padEnd(39)}║`);
    console.log(`║   端口: ${String(config.port).padEnd(39)}║`);
    console.log(`║   钉钉 AppKey: ${config.dingtalk.appKey.padEnd(32)}║`);
    console.log('╠══════════════════════════════════════════════════╣');
    console.log('║   端点:                                         ║');
    console.log('║   • OAuth Metadata  → /.well-known/oauth-...    ║');
    console.log('║   • Authorize       → GET  /authorize           ║');
    console.log('║   • Token           → POST /token               ║');
    console.log('║   • Register        → POST /register            ║');
    console.log('║   • MCP Groups      → GET  /mcp/groups          ║');
    console.log('║   • MCP (分组)      → POST /mcp/:group           ║');
    console.log('║   • DingTalk CB     → GET  /dingtalk/callback   ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
  });

  // 优雅停机：ECS Fargate 滚动更新 / 缩容时会发送 SIGTERM，
  // 这里停止接收新连接并等待进行中的请求（含 SSE 长连接）完成后再退出，
  // 配合 ALB 的 deregistration delay 避免请求被硬切断。
  const shutdown = (signal: string) => {
    console.log(`\n[shutdown] 收到 ${signal}，开始优雅停机...`);
    server.close((err) => {
      if (err) {
        console.error('[shutdown] 关闭服务器出错:', err);
        process.exit(1);
      }
      console.log('[shutdown] 服务器已关闭，进程退出');
      process.exit(0);
    });

    // 兜底：超时仍未关闭则强制退出，避免卡死
    setTimeout(() => {
      console.error('[shutdown] 优雅停机超时，强制退出');
      process.exit(1);
    }, 30_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
