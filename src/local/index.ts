/**
 * 本地 stdio MCP server 入口
 *
 * 使用方式：
 *   npx tsx src/local/index.ts
 *
 * MCP Client 配置示例（Claude Desktop / Cursor）：
 *   {
 *     "mcpServers": {
 *       "dingtalk": {
 *         "command": "npx",
 *         "args": ["tsx", "src/local/index.ts"],
 *         "cwd": "/path/to/mcp-oauth-dingtalk"
 *       }
 *     }
 *   }
 *
 * 环境变量（从 .env 读取）：
 *   DINGTALK_APP_KEY   - 钉钉 AppKey
 *   DINGTALK_APP_SECRET - 钉钉 AppSecret
 *
 * 独立于远程版，不引用 src/config.ts、src/storage/ 等模块。
 */

import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadToken, isTokenExpired, refreshAndSave, LocalToken } from './token-store';
import { localLogin } from './auth';
import { listTools, callTool } from './proxy';

// 加载 .env（与远程版共享同一个 .env 文件，但只读 DINGTALK_APP_KEY/SECRET）
dotenv.config();

const APP_KEY = process.env.DINGTALK_APP_KEY || '';
const APP_SECRET = process.env.DINGTALK_APP_SECRET || '';

/** 日志输出到 stderr，避免干扰 stdio 协议通信 */
function log(msg: string): void {
  process.stderr.write(`[dingtalk-local] ${msg}\n`);
}

/**
 * 确保有有效的 token，必要时触发登录或刷新
 */
async function ensureToken(): Promise<LocalToken> {
  let token = loadToken();

  if (token && !isTokenExpired(token)) {
    return token;
  }

  // 尝试刷新
  if (token && token.refreshToken) {
    try {
      log('Token 即将过期，尝试刷新...');
      token = await refreshAndSave(token, APP_KEY, APP_SECRET);
      log('Token 刷新成功');
      return token;
    } catch (err) {
      log(`Token 刷新失败: ${err instanceof Error ? err.message : '未知错误'}，需要重新登录`);
    }
  }

  // 需要登录
  log('需要钉钉登录授权...');
  token = await localLogin(APP_KEY, APP_SECRET, log);
  return token;
}

async function main(): Promise<void> {
  // 校验配置
  if (!APP_KEY || !APP_SECRET) {
    log('❌ 错误: 缺少 DINGTALK_APP_KEY 或 DINGTALK_APP_SECRET');
    log('   请在 .env 文件中配置钉钉应用凭据');
    process.exit(1);
  }

  // 确保 token 有效（可能触发浏览器登录）
  let token = await ensureToken();
  log(`已登录: ${token.nick || '用户'} (corpId=${token.corpId})`);

  // 创建 MCP server
  const server = new McpServer(
    {
      name: 'dingtalk-mcp-local',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );

  // 注册动态工具处理
  // MCP SDK 的 tool() 需要预注册，但我们的工具列表是动态的（来自上游）
  // 使用底层 server 的 setRequestHandler 直接处理 tools/list 和 tools/call
  server.server.setRequestHandler(
    { method: 'tools/list' } as any,
    async () => {
      // 确保 token 有效
      token = await ensureToken();
      const tools = await listTools(token.accessToken, log);
      return { tools };
    },
  );

  server.server.setRequestHandler(
    { method: 'tools/call' } as any,
    async (request: any) => {
      // 确保 token 有效
      token = await ensureToken();

      const { name, arguments: args } = request.params;
      try {
        const result = await callTool(name, args || {}, token.accessToken, log);

        // 统一返回格式：MCP 规范要求 content 数组
        if (result?.content) {
          return result;
        }
        return {
          content: [
            { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `错误: ${err instanceof Error ? err.message : '未知错误'}` },
          ],
          isError: true,
        };
      }
    },
  );

  // 连接 stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('✅ stdio MCP server 已启动，等待客户端请求...');
}

main().catch((err) => {
  log(`❌ 启动失败: ${err instanceof Error ? err.message : '未知错误'}`);
  process.exit(1);
});
