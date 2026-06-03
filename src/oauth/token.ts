import { Router, Request, Response } from 'express';
import { config } from '../config';
import { IStorage } from '../storage/interface';
import {
  generateMcpAccessToken,
  generateMcpRefreshToken,
  verifyPkce,
} from '../utils/crypto';
import { refreshDingtalkToken } from '../utils/dingtalk-api';

/**
 * 解析客户端凭据，兼容三种 OAuth 客户端认证方式：
 * - client_secret_basic：client_id/secret 放在 Authorization: Basic 头（Amazon Quick 用此方式）
 * - client_secret_post / none：client_id 放在请求 body
 * body 优先；body 没有时回退到 Basic 头。
 */
function extractClientCredentials(req: Request): {
  clientId?: string;
  clientSecret?: string;
} {
  // 1) 优先从 body 取（client_secret_post / public client）
  let clientId: string | undefined = req.body?.client_id;
  let clientSecret: string | undefined = req.body?.client_secret;

  // 2) body 没有 client_id 时，尝试从 Authorization: Basic 头解析
  if (!clientId) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
        const sep = decoded.indexOf(':');
        if (sep >= 0) {
          // client_id 和 client_secret 按 RFC 6749 需 form-urlencode，这里解码还原
          clientId = decodeURIComponent(decoded.substring(0, sep));
          clientSecret = decodeURIComponent(decoded.substring(sep + 1));
        }
      } catch {
        // 解析失败则保持 undefined，由后续逻辑报错
      }
    }
  }

  return { clientId, clientSecret };
}


/**
 * OAuth Token Endpoint
 * 支持 authorization_code 和 refresh_token 两种 grant_type
 */
export function createTokenRouter(storage: IStorage): Router {
  const router = Router();

  router.post('/token', async (req: Request, res: Response) => {
    try {
      // 诊断日志：打印请求的 content-type 与 body 字段，便于排查客户端兼容性
      console.log(`[token] 请求 content-type=${req.headers['content-type']}, body keys=${JSON.stringify(Object.keys(req.body || {}))}, grant_type=${req.body?.grant_type}`);

      const { grant_type } = req.body;

      if (grant_type === 'authorization_code') {
        await handleAuthorizationCode(req, res, storage);
      } else if (grant_type === 'refresh_token') {
        await handleRefreshToken(req, res, storage);
      } else {
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: '仅支持 authorization_code 和 refresh_token',
        });
      }
    } catch (error) {
      console.error('Token endpoint error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: '令牌处理失败',
      });
    }
  });

  return router;
}

/**
 * 处理 authorization_code 换 token
 */
async function handleAuthorizationCode(
  req: Request,
  res: Response,
  storage: IStorage
): Promise<void> {
  const { code, redirect_uri, code_verifier } = req.body;
  const { clientId: client_id } = extractClientCredentials(req);

  // 验证必填参数
  if (!code || !client_id || !redirect_uri || !code_verifier) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: '缺少必填参数: code, client_id, redirect_uri, code_verifier',
    });
    return;
  }

  // 查找 mcp_authorization_code
  const mcpCode = await storage.getMcpCode(code);
  if (!mcpCode) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'authorization_code 无效或已过期',
    });
    return;
  }

  // 获取对应的 session
  const session = await storage.getAuthSession(mcpCode.sessionId);
  if (!session) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: '授权会话已过期',
    });
    return;
  }

  // 验证 client_id 一致
  if (session.clientId !== client_id) {
    res.status(400).json({
      error: 'invalid_client',
      error_description: 'client_id 不匹配',
    });
    return;
  }

  // 验证 redirect_uri 一致
  if (session.redirectUri !== redirect_uri) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'redirect_uri 不匹配',
    });
    return;
  }

  // 验证 PKCE
  if (!verifyPkce(code_verifier, session.codeChallenge)) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'PKCE 验证失败，code_verifier 不匹配',
    });
    return;
  }

  // 生成 MCP token
  const mcpAccessToken = generateMcpAccessToken();
  const mcpRefreshToken = generateMcpRefreshToken();
  const now = Date.now();

  await storage.saveToken({
    mcpAccessToken,
    mcpRefreshToken,
    clientId: client_id,
    userId: mcpCode.userId,
    corpId: mcpCode.corpId,
    scope: session.scope,
    dingtalkAccessToken: mcpCode.dingtalkAccessToken,
    dingtalkRefreshToken: mcpCode.dingtalkRefreshToken,
    dingtalkTokenExpiresAt: mcpCode.dingtalkTokenExpiresAt,
    mcpTokenExpiresAt: now + config.mcp.tokenExpiry * 1000,
    createdAt: now,
  });

  // 删除已使用的 code（一次性）
  await storage.deleteMcpCode(code);
  // 清理 session
  await storage.deleteAuthSession(mcpCode.sessionId);

  console.log(`[token] 颁发 token: user=${mcpCode.userId}, client=${client_id}`);

  res.json({
    access_token: mcpAccessToken,
    token_type: 'Bearer',
    expires_in: config.mcp.tokenExpiry,
    refresh_token: mcpRefreshToken,
    scope: session.scope,
  });
}

/**
 * 处理 refresh_token 换新 token
 */
async function handleRefreshToken(
  req: Request,
  res: Response,
  storage: IStorage
): Promise<void> {
  const { refresh_token } = req.body;
  const { clientId: client_id } = extractClientCredentials(req);

  if (!refresh_token || !client_id) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: '缺少必填参数: refresh_token, client_id',
    });
    return;
  }

  // 查找 refresh token 对应的记录
  const tokenRecord = await storage.getTokenByRefreshToken(refresh_token);
  if (!tokenRecord) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'refresh_token 无效或已过期',
    });
    return;
  }

  // 验证 client_id
  if (tokenRecord.clientId !== client_id) {
    res.status(400).json({
      error: 'invalid_client',
      error_description: 'client_id 不匹配',
    });
    return;
  }

  // 检查钉钉 token 是否需要刷新
  let dingtalkAccessToken = tokenRecord.dingtalkAccessToken;
  let dingtalkRefreshToken = tokenRecord.dingtalkRefreshToken;
  let dingtalkTokenExpiresAt = tokenRecord.dingtalkTokenExpiresAt;

  if (Date.now() >= dingtalkTokenExpiresAt) {
    try {
      const newDingtalkToken = await refreshDingtalkToken(dingtalkRefreshToken);
      dingtalkAccessToken = newDingtalkToken.accessToken;
      dingtalkRefreshToken = newDingtalkToken.refreshToken;
      dingtalkTokenExpiresAt = Date.now() + newDingtalkToken.expireIn * 1000;
      console.log(`[token] 钉钉 token 已续期: user=${tokenRecord.userId}`);
    } catch (error) {
      console.error('钉钉 token 刷新失败:', error);
      // 钉钉 refresh token 也过期了，需要用户重新授权
      await storage.deleteToken(tokenRecord.mcpAccessToken);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: '钉钉授权已过期，请重新授权',
      });
      return;
    }
  }

  // 删除旧 token
  await storage.deleteToken(tokenRecord.mcpAccessToken);

  // 生成新 token（轮换策略）
  const newAccessToken = generateMcpAccessToken();
  const newRefreshToken = generateMcpRefreshToken();
  const now = Date.now();

  await storage.saveToken({
    mcpAccessToken: newAccessToken,
    mcpRefreshToken: newRefreshToken,
    clientId: client_id,
    userId: tokenRecord.userId,
    corpId: tokenRecord.corpId,
    scope: tokenRecord.scope,
    dingtalkAccessToken,
    dingtalkRefreshToken,
    dingtalkTokenExpiresAt,
    mcpTokenExpiresAt: now + config.mcp.tokenExpiry * 1000,
    createdAt: now,
  });

  console.log(`[token] 刷新 token: user=${tokenRecord.userId}, client=${client_id}`);

  res.json({
    access_token: newAccessToken,
    token_type: 'Bearer',
    expires_in: config.mcp.tokenExpiry,
    refresh_token: newRefreshToken,
    scope: tokenRecord.scope,
  });
}
