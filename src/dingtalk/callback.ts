import { Router, Request, Response } from 'express';
import { IStorage } from '../storage/interface';
import { generateMcpCode } from '../utils/crypto';
import { exchangeDingtalkToken, getDingtalkUserInfo } from '../utils/dingtalk-api';

/**
 * 钉钉 OAuth 回调处理
 * 接收钉钉授权后的 authCode，换取 token，然后重定向回 MCP Client
 */
export function createDingtalkCallbackRouter(storage: IStorage): Router {
  const router = Router();

  router.get('/dingtalk/callback', async (req: Request, res: Response) => {
    try {
      const { authCode, state } = req.query as Record<string, string>;

      if (!authCode || !state) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: '缺少 authCode 或 state 参数',
        });
        return;
      }

      // 用 state（即 sessionId）找回 session
      const session = await storage.getAuthSession(state);
      if (!session) {
        res.status(400).json({
          error: 'invalid_state',
          error_description: '授权会话已过期或无效',
        });
        return;
      }

      // 用 authCode 换取钉钉 token
      const dingtalkToken = await exchangeDingtalkToken(authCode);
      console.log(`[dingtalk/callback] 钉钉 token 获取成功, corpId=${dingtalkToken.corpId}`);

      // 获取用户信息
      let userId = '';
      try {
        const userInfo = await getDingtalkUserInfo(dingtalkToken.accessToken);
        userId = userInfo.openId || userInfo.unionId || '';
        console.log(`[dingtalk/callback] 用户信息: nick=${userInfo.nick}, openId=${userInfo.openId}`);
      } catch (error) {
        console.warn('[dingtalk/callback] 获取用户信息失败，继续流程:', error);
      }

      // 生成 MCP authorization code
      const mcpCode = generateMcpCode();
      await storage.saveMcpCode({
        code: mcpCode,
        sessionId: session.sessionId,
        dingtalkAccessToken: dingtalkToken.accessToken,
        dingtalkRefreshToken: dingtalkToken.refreshToken,
        dingtalkTokenExpiresAt: Date.now() + dingtalkToken.expireIn * 1000,
        corpId: dingtalkToken.corpId || '',
        userId,
        createdAt: Date.now(),
      });

      // 302 重定向回 MCP Client（Quick）的回调地址
      const redirectUrl = new URL(session.redirectUri);
      redirectUrl.searchParams.set('code', mcpCode);
      redirectUrl.searchParams.set('state', session.state);

      console.log(`[dingtalk/callback] 重定向回 client: ${session.clientId}`);
      res.redirect(302, redirectUrl.toString());
    } catch (error) {
      console.error('DingTalk callback error:', error);
      res.status(500).send(`
        <html>
          <body>
            <h2>授权失败</h2>
            <p>钉钉授权过程中发生错误，请关闭此页面后重试。</p>
            <p>错误信息: ${error instanceof Error ? error.message : '未知错误'}</p>
          </body>
        </html>
      `);
    }
  });

  return router;
}
