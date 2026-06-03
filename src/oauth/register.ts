import { Router, Request, Response } from 'express';
import { IStorage } from '../storage/interface';
import { generateClientId, generateToken } from '../utils/crypto';

/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591)
 *
 * MCP 客户端（Amazon Quick 的 Default OAuth app 模式）会自动调用本端点注册，
 * 然后用返回的 client_id 走 per-user 授权码流。
 *
 * 注意：RFC 7591 中除 redirect_uris 外大多字段可选，这里尽量宽松接收，
 * 避免因缺字段（如 client_name）误判为 invalid_client_metadata。
 */
export function createRegisterRouter(storage: IStorage): Router {
  const router = Router();

  router.post('/register', async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const {
        client_name,
        redirect_uris,
        grant_types,
        response_types,
        token_endpoint_auth_method,
        scope,
      } = body;

      console.log(`[register] DCR 请求: ${JSON.stringify(body)}`);

      // redirect_uris 必填且为非空数组
      if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        console.warn('[register] 缺少 redirect_uris');
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uris 为必填项且不能为空',
        });
        return;
      }

      // 校验 redirect_uris 格式（非 localhost 必须 HTTPS）
      for (const uri of redirect_uris) {
        try {
          const parsed = new URL(uri);
          if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
            res.status(400).json({
              error: 'invalid_redirect_uri',
              error_description: `非 localhost 的 redirect_uri 必须使用 HTTPS: ${uri}`,
            });
            return;
          }
        } catch {
          res.status(400).json({
            error: 'invalid_redirect_uri',
            error_description: `无效的 redirect_uri: ${uri}`,
          });
          return;
        }
      }

      const clientId = generateClientId();
      const authMethod = token_endpoint_auth_method || 'none';
      const grantTypes = Array.isArray(grant_types) && grant_types.length > 0
        ? grant_types
        : ['authorization_code', 'refresh_token'];
      const responseTypes = Array.isArray(response_types) && response_types.length > 0
        ? response_types
        : ['code'];

      // 若客户端声明使用 client_secret_basic/post，则签发 client_secret；
      // public client（none）则不签发。secret 实际不参与鉴权（安全由 PKCE 保证），
      // 但需在注册响应中返回，否则声明用 secret 的客户端（如 Quick）会校验失败。
      const needsSecret = authMethod === 'client_secret_basic' || authMethod === 'client_secret_post';
      const clientSecret = needsSecret ? generateToken('cs') : '';

      await storage.saveClient({
        clientId,
        clientSecretHash: clientSecret, // 存明文占位；token 端点不强制校验 secret
        redirectUris: redirect_uris,
        clientName: client_name || 'MCP Client',
        grantTypes,
        tokenEndpointAuthMethod: authMethod,
        createdAt: Date.now(),
      });

      console.log(`[register] 注册成功: client_id=${clientId}, auth_method=${authMethod}, secret=${needsSecret ? '已签发' : '无'}`);

      // RFC 7591 注册响应
      const response: Record<string, unknown> = {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris,
        grant_types: grantTypes,
        response_types: responseTypes,
        token_endpoint_auth_method: authMethod,
        client_name: client_name || 'MCP Client',
      };
      if (needsSecret) {
        response.client_secret = clientSecret;
        response.client_secret_expires_at = 0; // 0 = 永不过期（RFC 7591）
      }
      if (scope) response.scope = scope;

      res.status(201).json(response);
    } catch (error) {
      console.error('[register] 注册失败:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: '注册失败，请稍后重试',
      });
    }
  });

  return router;
}
