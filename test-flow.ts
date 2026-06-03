/**
 * 本地 OAuth 全流程测试脚本
 * 
 * 模拟 Amazon Quick 的行为，在本地完成完整的 OAuth 授权流程：
 * 1. 发起授权请求（模拟 Quick）
 * 2. 打开浏览器让用户在钉钉授权
 * 3. 本地接收钉钉回调
 * 4. 用 authorization_code 换 token
 * 5. 用 token 调用 MCP Tool
 * 
 * 使用方式：npx tsx test-flow.ts
 */

import http from 'http';
import { createHash, randomBytes } from 'crypto';
import { exec } from 'child_process';

const GATEWAY_BASE = 'http://localhost:3000';
const CLIENT_ID = 'amazon_quick_001';
// 本地测试用的回调地址（模拟 Quick 的回调）
const LOCAL_CALLBACK_PORT = 3001;
const LOCAL_CALLBACK_URL = `http://localhost:${LOCAL_CALLBACK_PORT}/callback`;

/**
 * 生成 PKCE code_verifier 和 code_challenge
 */
function generatePkce() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * 打开浏览器
 */
function openBrowser(url: string) {
  const command = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(command);
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   MCP OAuth Gateway - 本地全流程测试             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // ========== Step 0: 注册本地回调地址到 Gateway ==========
  console.log('[Step 0] 更新 Client 的 redirect_uri 为本地回调地址...');
  
  // 先通过 register 端点注册一个测试 client，或者我们直接用预分配的
  // 但预分配的 redirect_uri 是 quick 的地址，我们需要让 Gateway 接受本地地址
  // 方案：直接调 Gateway 的 authorize，它会验证 redirect_uri
  // 所以我们需要先确保 Gateway 的预分配 client 包含本地回调地址
  
  // 注册一个本地测试 client
  const registerRes = await fetch(`${GATEWAY_BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Local Test Client',
      redirect_uris: [LOCAL_CALLBACK_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!registerRes.ok) {
    console.error('注册 Client 失败:', await registerRes.text());
    process.exit(1);
  }

  const clientInfo = await registerRes.json() as { client_id: string };
  const testClientId = clientInfo.client_id;
  console.log(`  ✓ 注册成功, client_id = ${testClientId}`);
  console.log('');

  // ========== Step 1: 生成 PKCE 参数 ==========
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = randomBytes(16).toString('hex');

  console.log('[Step 1] 生成 PKCE 参数:');
  console.log(`  code_verifier  = ${codeVerifier}`);
  console.log(`  code_challenge = ${codeChallenge}`);
  console.log(`  state          = ${state}`);
  console.log('');

  // ========== Step 2: 构造授权 URL ==========
  const authorizeUrl = new URL(`${GATEWAY_BASE}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', testClientId);
  authorizeUrl.searchParams.set('redirect_uri', LOCAL_CALLBACK_URL);
  authorizeUrl.searchParams.set('scope', 'openid dingtalk:contact:read');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('[Step 2] 授权 URL:');
  console.log(`  ${authorizeUrl.toString()}`);
  console.log('');

  // ========== Step 3: 启动本地回调服务器，等待授权码 ==========
  console.log('[Step 3] 启动本地回调服务器，等待钉钉授权完成...');
  console.log(`  监听: http://localhost:${LOCAL_CALLBACK_PORT}/callback`);
  console.log('');

  const authCode = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${LOCAL_CALLBACK_PORT}`);
      
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');

        if (!code) {
          res.writeHead(400);
          res.end('缺少 code 参数');
          reject(new Error('回调中缺少 code'));
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400);
          res.end('state 不匹配');
          reject(new Error(`state 不匹配: 期望 ${state}, 收到 ${returnedState}`));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h2>✅ 授权成功！</h2>
              <p>authorization_code 已收到，可以关闭此页面。</p>
              <p style="color: #666; font-size: 12px;">code = ${code}</p>
            </body>
          </html>
        `);

        server.close();
        resolve(code);
      }
    });

    server.listen(LOCAL_CALLBACK_PORT, () => {
      // 打开浏览器，开始授权流程
      console.log('  → 正在打开浏览器，请在钉钉页面完成授权...');
      console.log('');
      openBrowser(authorizeUrl.toString());
    });

    // 超时处理
    setTimeout(() => {
      server.close();
      reject(new Error('授权超时（2分钟），请重试'));
    }, 120000);
  });

  console.log(`[Step 3] ✓ 收到 authorization_code: ${authCode.substring(0, 30)}...`);
  console.log('');

  // ========== Step 4: 用 code 换 token ==========
  console.log('[Step 4] 用 authorization_code 换取 token...');

  const tokenRes = await fetch(`${GATEWAY_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: testClientId,
      redirect_uri: LOCAL_CALLBACK_URL,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const error = await tokenRes.text();
    console.error('  ✗ Token 交换失败:', error);
    process.exit(1);
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
  console.log('  ✓ Token 获取成功:');
  console.log(`    access_token  = ${tokenData.access_token.substring(0, 30)}...`);
  console.log(`    refresh_token = ${tokenData.refresh_token.substring(0, 30)}...`);
  console.log(`    expires_in    = ${tokenData.expires_in}s`);
  console.log(`    scope         = ${tokenData.scope}`);
  console.log('');

  // ========== Step 5: 调用 MCP Tool（代理转发到钉钉 MCP 网关） ==========
  console.log('[Step 5] 调用钉钉 MCP 代理: contact (通讯录)...');

  // 先测试 tools/list，看看钉钉通讯录 MCP 有哪些工具
  const mcpListRes = await fetch(`${GATEWAY_BASE}/mcp/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenData.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });

  if (!mcpListRes.ok) {
    const error = await mcpListRes.text();
    console.error('  ✗ MCP tools/list 失败:', error);
  } else {
    const listData = await mcpListRes.json() as any;
    if (listData.error) {
      console.error('  ✗ MCP tools/list 错误:', listData.error.message);
    } else {
      const tools = listData.result?.tools || listData.tools || [];
      console.log(`  ✓ 通讯录 MCP 工具列表 (共 ${tools.length} 个):`);
      for (const tool of tools.slice(0, 5)) {
        console.log(`    • ${tool.name}: ${tool.description || ''}`);
      }
      if (tools.length > 5) {
        console.log(`    ... 还有 ${tools.length - 5} 个工具`);
      }
    }
  }

  console.log('');

  // 再测试本地 MCP Tool（保留兼容）
  console.log('[Step 5b] 调用本地 MCP Tool: get_current_user...');

  const mcpRes = await fetch(`${GATEWAY_BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenData.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'get_current_user',
        arguments: {},
      },
    }),
  });

  if (!mcpRes.ok) {
    const error = await mcpRes.text();
    console.error('  ✗ MCP 调用失败:', error);
  } else {
    const mcpData = await mcpRes.json() as {
      result?: { content: Array<{ text: string }> };
      error?: { message: string };
    };

    if (mcpData.error) {
      console.error('  ✗ MCP Tool 返回错误:', mcpData.error.message);
    } else {
      console.log('  ✓ MCP Tool 返回结果:');
      const content = mcpData.result?.content?.[0]?.text;
      if (content) {
        try {
          const parsed = JSON.parse(content);
          console.log(JSON.stringify(parsed, null, 4));
        } catch {
          console.log(`    ${content}`);
        }
      }
    }
  }

  // ========== Step 6: 测试 Token 刷新 ==========
  console.log('');
  console.log('[Step 6] 测试 refresh_token 刷新...');

  const refreshRes = await fetch(`${GATEWAY_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenData.refresh_token,
      client_id: testClientId,
    }).toString(),
  });

  if (!refreshRes.ok) {
    const error = await refreshRes.text();
    console.error('  ✗ Token 刷新失败:', error);
  } else {
    const refreshData = await refreshRes.json() as {
      access_token: string;
      refresh_token: string;
    };
    console.log('  ✓ Token 刷新成功:');
    console.log(`    new access_token  = ${refreshData.access_token.substring(0, 30)}...`);
    console.log(`    new refresh_token = ${refreshData.refresh_token.substring(0, 30)}...`);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  🎉 全流程测试完成！');
  console.log('══════════════════════════════════════════════════');
}

main().catch((error) => {
  console.error('测试失败:', error.message);
  process.exit(1);
});
