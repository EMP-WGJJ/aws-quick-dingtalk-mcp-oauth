/**
 * 本地 OAuth 登录流程
 *
 * 1. 启动临时 HTTP server (localhost:3456)
 * 2. 打开浏览器跳转钉钉授权页
 * 3. 钉钉回调 /callback，拿到 authCode
 * 4. 用 authCode 换取 user_access_token
 * 5. 存入本地文件，关闭 HTTP server
 *
 * 钉钉后台需配置回调地址: http://localhost:3456/callback
 */

import http from 'http';
import { URL } from 'url';
import { saveToken, LocalToken } from './token-store';

const LOCAL_PORT = 3456;
const CALLBACK_PATH = '/callback';

/** 钉钉 OAuth 相关常量 */
const DINGTALK_AUTH_URL = 'https://login.dingtalk.com/oauth2/auth';
const DINGTALK_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
const DINGTALK_USER_URL = 'https://api.dingtalk.com/v1.0/contact/users/me';

/**
 * 打开浏览器（跨平台）
 */
async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('child_process');
  const platform = process.platform;
  const cmd =
    platform === 'win32' ? `start "" "${url}"` :
    platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd);
}

/**
 * 用 authCode 换取钉钉 token
 */
async function exchangeToken(
  authCode: string,
  appKey: string,
  appSecret: string,
): Promise<{ accessToken: string; refreshToken: string; expireIn: number; corpId?: string }> {
  const res = await fetch(DINGTALK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: appKey,
      clientSecret: appSecret,
      code: authCode,
      grantType: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`钉钉 token 交换失败: ${res.status} ${text}`);
  }

  return res.json() as Promise<{ accessToken: string; refreshToken: string; expireIn: number; corpId?: string }>;
}

/**
 * 获取钉钉用户昵称
 */
async function getUserNick(accessToken: string): Promise<string> {
  try {
    const res = await fetch(DINGTALK_USER_URL, {
      headers: { 'x-acs-dingtalk-access-token': accessToken },
    });
    if (!res.ok) return '';
    const data = (await res.json()) as { nick?: string };
    return data.nick || '';
  } catch {
    return '';
  }
}

/**
 * 发起本地 OAuth 登录，返回获取到的 token
 *
 * @param appKey 钉钉 AppKey
 * @param appSecret 钉钉 AppSecret
 * @param log 日志输出函数（stdio 模式下需避免 stdout，用 stderr）
 * @returns 登录成功的 token
 */
export function localLogin(
  appKey: string,
  appSecret: string,
  log: (msg: string) => void = (msg) => process.stderr.write(msg + '\n'),
): Promise<LocalToken> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', `http://localhost:${LOCAL_PORT}`);

      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const authCode = reqUrl.searchParams.get('authCode');
      if (!authCode) {
        res.writeHead(400);
        res.end('缺少 authCode 参数');
        return;
      }

      try {
        // 换取 token
        const tokenData = await exchangeToken(authCode, appKey, appSecret);
        const nick = await getUserNick(tokenData.accessToken);

        const token: LocalToken = {
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          expiresAt: Date.now() + tokenData.expireIn * 1000,
          corpId: tokenData.corpId || '',
          nick,
        };

        // 持久化
        saveToken(token);

        // 返回成功页面
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 60px;">
              <h2>✅ 钉钉登录成功</h2>
              <p>欢迎，${nick || '用户'}！</p>
              <p>token 已保存到本地，可以关闭此页面。</p>
              <script>setTimeout(() => window.close(), 2000);</script>
            </body>
          </html>
        `);

        log(`✅ 登录成功: ${nick || '用户'} (corpId=${token.corpId})`);

        // 关闭临时 server
        server.close();
        resolve(token);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 60px;">
              <h2>❌ 登录失败</h2>
              <p>${err instanceof Error ? err.message : '未知错误'}</p>
              <p>请关闭此页面后重试。</p>
            </body>
          </html>
        `);
        server.close();
        reject(err);
      }
    });

    server.listen(LOCAL_PORT, () => {
      const callbackUrl = `http://localhost:${LOCAL_PORT}${CALLBACK_PATH}`;
      const authUrl = new URL(DINGTALK_AUTH_URL);
      authUrl.searchParams.set('redirect_uri', callbackUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', appKey);
      authUrl.searchParams.set('scope', 'openid corpid');
      authUrl.searchParams.set('prompt', 'consent');

      log(`🔐 正在打开浏览器进行钉钉登录...`);
      log(`   如果浏览器未自动打开，请手动访问:`);
      log(`   ${authUrl.toString()}`);

      openBrowser(authUrl.toString());
    });

    server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(new Error(`端口 ${LOCAL_PORT} 已被占用，请释放后重试`));
      } else {
        reject(err);
      }
    });

    // 超时保护：3 分钟无响应则放弃
    setTimeout(() => {
      server.close();
      reject(new Error('登录超时（3 分钟），请重试'));
    }, 3 * 60 * 1000);
  });
}
