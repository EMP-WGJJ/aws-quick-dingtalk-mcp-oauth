import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  // 钉钉应用凭据
  dingtalk: {
    appKey: process.env.DINGTALK_APP_KEY || '',
    appSecret: process.env.DINGTALK_APP_SECRET || '',
    authUrl: process.env.DINGTALK_AUTH_URL || 'https://login.dingtalk.com/oauth2/auth',
    tokenUrl: process.env.DINGTALK_TOKEN_URL || 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    callbackPath: process.env.DINGTALK_CALLBACK_PATH || '/dingtalk/callback',
  },

  // MCP OAuth 配置
  mcp: {
    tokenExpiry: parseInt(process.env.MCP_TOKEN_EXPIRY || '3600', 10),
    refreshExpiry: parseInt(process.env.MCP_REFRESH_EXPIRY || '2592000', 10),
    codeExpiry: parseInt(process.env.MCP_CODE_EXPIRY || '300', 10),
  },

  // 预分配 Client
  quick: {
    clientId: process.env.QUICK_CLIENT_ID || 'amazon_quick_001',
    clientSecret: process.env.QUICK_CLIENT_SECRET || '',
    // 支持逗号分隔的多个 redirect_uri（不同 region 的 Quick 回调地址）
    redirectUri: process.env.QUICK_REDIRECT_URI || 'https://quick.aws.com/sn/oauthcallback',
  },

  // 存储驱动: 'memory'（本地开发）| 'dynamo'（生产）
  storageDriver: (process.env.STORAGE_DRIVER || 'memory') as 'memory' | 'dynamo',

  // AWS 配置
  aws: {
    region: process.env.AWS_REGION || 'ap-southeast-1',
  },

  // DynamoDB 配置
  dynamo: {
    tableName: process.env.DYNAMO_TABLE_NAME || 'dingtalk-mcp-gateway',
    // 本地开发可指向 DynamoDB Local，例如 http://localhost:8000
    endpoint: process.env.DYNAMO_ENDPOINT || '',
  },

  // KMS 配置（用于加密钉钉 token 等敏感字段）
  kms: {
    // KMS Key ID 或 ARN；留空则不加密（仅本地开发用）
    keyId: process.env.KMS_KEY_ID || '',
  },

  // 存储（旧版 Redis 预留，当前未使用）
  redisUrl: process.env.REDIS_URL || '',
};
