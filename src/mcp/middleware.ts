import { Request, Response, NextFunction } from 'express';
import { IStorage, TokenRecord } from '../storage/interface';
import { refreshDingtalkToken } from '../utils/dingtalk-api';
import { config } from '../config';

/**
 * 扩展 Express Request，附加认证信息
 */
declare global {
  namespace Express {
    interface Request {
      tokenRecord?: TokenRecord;
      dingtalkAccessToken?: string;
    }
  }
}

/**
 * 设置 RFC 9728 要求的 WWW-Authenticate 头，指向当前 MCP 资源的
 * protected-resource metadata，供 MCP 客户端（Quick）发现授权服务器并走 DCR。
 */
function setWwwAuthenticate(req: Request, res: Response): void {
  // req.baseUrl + req.path 还原出资源路径，如 /mcp/office
  const resourcePath = req.originalUrl.split('?')[0];
  const metadataUrl = `${config.baseUrl}/.well-known/oauth-protected-resource${resourcePath}`;
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${metadataUrl}"`
  );
}

/**
 * Bearer Token 验证中间件
 * 验证 MCP access token，并确保钉钉 token 可用
 */
export function createAuthMiddleware(storage: IStorage) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // 提取 Bearer token
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        setWwwAuthenticate(req, res);
        res.status(401).json({
          error: 'unauthorized',
          error_description: '缺少 Authorization: Bearer <token> 头',
        });
        return;
      }

      const mcpAccessToken = authHeader.substring(7);

      // 查找 token 记录
      const tokenRecord = await storage.getTokenByAccessToken(mcpAccessToken);
      if (!tokenRecord) {
        setWwwAuthenticate(req, res);
        res.status(401).json({
          error: 'invalid_token',
          error_description: 'access_token 无效或已过期',
        });
        return;
      }

      // 检查 MCP token 是否过期
      if (Date.now() >= tokenRecord.mcpTokenExpiresAt) {
        setWwwAuthenticate(req, res);
        res.status(401).json({
          error: 'invalid_token',
          error_description: 'access_token 已过期，请使用 refresh_token 续期',
        });
        return;
      }

      // 检查钉钉 token 是否需要刷新
      let dingtalkAccessToken = tokenRecord.dingtalkAccessToken;
      if (Date.now() >= tokenRecord.dingtalkTokenExpiresAt) {
        try {
          const newToken = await refreshDingtalkToken(tokenRecord.dingtalkRefreshToken);
          dingtalkAccessToken = newToken.accessToken;

          // 更新存储中的钉钉 token
          const updatedRecord: TokenRecord = {
            ...tokenRecord,
            dingtalkAccessToken: newToken.accessToken,
            dingtalkRefreshToken: newToken.refreshToken,
            dingtalkTokenExpiresAt: Date.now() + newToken.expireIn * 1000,
          };
          await storage.deleteToken(tokenRecord.mcpAccessToken);
          await storage.saveToken(updatedRecord);

          console.log(`[auth] 自动续期钉钉 token: user=${tokenRecord.userId}`);
        } catch (error) {
          console.error('钉钉 token 自动续期失败:', error);
          res.status(401).json({
            error: 'invalid_token',
            error_description: '钉钉授权已过期，请重新授权',
          });
          return;
        }
      }

      // 附加到 request 上供后续使用
      req.tokenRecord = tokenRecord;
      req.dingtalkAccessToken = dingtalkAccessToken;
      next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: '认证处理失败',
      });
    }
  };
}
