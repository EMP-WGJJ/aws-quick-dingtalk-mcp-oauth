import { Router, Request, Response } from 'express';
import { config } from '../config';
import { IStorage } from '../storage/interface';
import { generateSessionId } from '../utils/crypto';

/**
 * OAuth Authorization Endpoint
 * 接收 MCP Client 的授权请求，重定向到钉钉授权页
 */
export function createAuthorizeRouter(storage: IStorage): Router {
  const router = Router();

  router.get('/authorize', async (req: Request, res: Response) => {
    try {
      const {
        response_type,
        client_id,
        redirect_uri,
        scope,
        state,
        code_challenge,
        code_challenge_method,
      } = req.query as Record<string, string>;

      // 验证必填参数
      if (!response_type || response_type !== 'code') {
        res.status(400).json({
          error: 'unsupported_response_type',
          error_description: '仅支持 response_type=code',
        });
        return;
      }

      if (!client_id) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: '缺少 client_id',
        });
        return;
      }

      if (!redirect_uri) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: '缺少 redirect_uri',
        });
        return;
      }

      if (!state) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: '缺少 state 参数',
        });
        return;
      }

      if (!code_challenge || !code_challenge_method) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'PKCE 为必填项，需要 code_challenge 和 code_challenge_method',
        });
        return;
      }

      if (code_challenge_method !== 'S256') {
        res.status(400).json({
          error: 'invalid_request',
          error_description: '仅支持 code_challenge_method=S256',
        });
        return;
      }

      // 验证 client_id
      const client = await storage.getClient(client_id);
      if (!client) {
        res.status(400).json({
          error: 'invalid_client',
          error_description: '未知的 client_id',
        });
        return;
      }

      // 验证 redirect_uri 在白名单中
      if (!client.redirectUris.includes(redirect_uri)) {
        console.warn(`[authorize] redirect_uri 不匹配: client=${client_id}, 收到=${redirect_uri}, 白名单=${JSON.stringify(client.redirectUris)}`);
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uri 不在已注册的白名单中',
          received_redirect_uri: redirect_uri,
          registered_redirect_uris: client.redirectUris,
        });
        return;
      }

      // 生成 session 并保存
      const sessionId = generateSessionId();
      await storage.saveAuthSession({
        sessionId,
        clientId: client_id,
        redirectUri: redirect_uri,
        state,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        scope: scope || 'openid',
        createdAt: Date.now(),
      });

      // 构造钉钉授权 URL，302 重定向
      const dingtalkCallbackUrl = `${config.baseUrl}${config.dingtalk.callbackPath}`;
      const dingtalkAuthUrl = new URL(config.dingtalk.authUrl);
      dingtalkAuthUrl.searchParams.set('redirect_uri', dingtalkCallbackUrl);
      dingtalkAuthUrl.searchParams.set('response_type', 'code');
      dingtalkAuthUrl.searchParams.set('client_id', config.dingtalk.appKey);
      dingtalkAuthUrl.searchParams.set('scope', 'openid corpid');
      dingtalkAuthUrl.searchParams.set('state', sessionId);
      dingtalkAuthUrl.searchParams.set('prompt', 'consent');

      console.log(`[authorize] 新授权请求: client=${client_id}, session=${sessionId}`);
      res.redirect(302, dingtalkAuthUrl.toString());
    } catch (error) {
      console.error('Authorization error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: '授权处理失败',
      });
    }
  });

  return router;
}
