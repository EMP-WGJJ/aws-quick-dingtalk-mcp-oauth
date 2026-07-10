/**
 * 钉钉 MCP 网关代理层
 *
 * 本地 stdio server 不做分组（本地无 100 工具限制），直接聚合全部 15 个 server 的工具。
 * 工具名仍用 <server>__<tool> 前缀（便于辨识来源），但不做长度截断。
 *
 * 独立于远程版的 aggregator.ts，不共享状态。
 */

const DINGTALK_MCP_GW_BASE = 'https://mcp-gw.dingtalk.com/server';
const PREFIX_SEP = '__';

/** 全部 15 个上游 server */
const ALL_SERVERS = [
  'contact', 'calendar', 'todo', 'report',
  'doc', 'wiki', 'drive',
  'aitable', 'sheet',
  'oa', 'mail', 'bot', 'group', 'live', 'teambition',
];

const SERVER_LABEL: Record<string, string> = {
  bot: '机器人消息', report: '钉钉日志', aitable: 'AI表格', doc: '钉钉文档',
  wiki: '知识库', contact: '通讯录', calendar: '日历', todo: '待办',
  sheet: '在线表格', group: '群聊', drive: '钉盘', oa: 'OA审批',
  mail: '邮箱', teambition: '项目管理', live: '直播',
};

/** 危险动词判定 */
const DANGER_VERBS = ['delete', 'remove', 'revoke', 'reject'];
function isDangerTool(name: string): boolean {
  const n = name.replace(/^batch_/, '');
  return DANGER_VERBS.some((v) => n === v || n.startsWith(v + '_'));
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

/** 工具全名 → 原始 { server, tool } 的反向映射 */
const nameMap = new Map<string, { server: string; tool: string }>();

function buildToolName(server: string, tool: string): string {
  const fullName = `${server}${PREFIX_SEP}${tool}`;
  nameMap.set(fullName, { server, tool });
  return fullName;
}

function splitToolName(prefixed: string): { server: string; tool: string } | null {
  const mapped = nameMap.get(prefixed);
  if (mapped) return mapped;
  const sep = prefixed.indexOf(PREFIX_SEP);
  if (sep <= 0) return null;
  const server = prefixed.slice(0, sep);
  const tool = prefixed.slice(sep + PREFIX_SEP.length);
  if (!ALL_SERVERS.includes(server) || !tool) return null;
  return { server, tool };
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

/**
 * 调用钉钉 MCP 网关上游
 */
async function callUpstream(
  server: string,
  method: string,
  token: string,
  params: unknown,
  id: string | number,
): Promise<any> {
  const res = await fetch(`${DINGTALK_MCP_GW_BASE}/${server}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-user-access-token': token,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
  });

  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();

  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    return dataLine ? safeJson(dataLine.slice(5).trim()) : { _raw: text };
  }
  return safeJson(text);
}

/**
 * 工具列表缓存（本地单进程，内存缓存即可）
 */
let toolsCache: { tools: McpTool[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 获取全量工具列表（聚合 15 个 server）
 */
export async function listTools(
  token: string,
  log: (msg: string) => void,
): Promise<McpTool[]> {
  const now = Date.now();
  if (toolsCache && now - toolsCache.fetchedAt < CACHE_TTL_MS) {
    return toolsCache.tools;
  }

  log(`[proxy] 正在拉取全部 ${ALL_SERVERS.length} 个 server 的工具列表...`);

  const results = await Promise.allSettled(
    ALL_SERVERS.map((s) => callUpstream(s, 'tools/list', token, {}, `list-${s}`))
  );

  const tools: McpTool[] = [];
  results.forEach((r, idx) => {
    const server = ALL_SERVERS[idx];
    if (r.status !== 'fulfilled') {
      log(`[proxy] ⚠️ ${server} tools/list 失败，跳过`);
      return;
    }
    const resp = r.value;
    if (resp?.error) {
      log(`[proxy] ⚠️ ${server} 返回错误: ${resp.error.message}，跳过`);
      return;
    }
    const serverTools: McpTool[] = resp?.result?.tools ?? resp?.tools ?? [];
    for (const t of serverTools) {
      let description = `[${SERVER_LABEL[server] || server}] ${t.description ?? ''}`.trim();
      if (isDangerTool(t.name)) {
        description = `⚠️【危险/不可逆】调用前请确认。` + description;
      }
      tools.push({
        name: buildToolName(server, t.name),
        title: t.title,
        description,
        inputSchema: t.inputSchema,
      });
    }
  });

  toolsCache = { tools, fetchedAt: Date.now() };
  log(`[proxy] 工具列表刷新完成: ${tools.length} 个工具`);
  return tools;
}

/**
 * 调用工具
 */
export async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  token: string,
  log: (msg: string) => void,
): Promise<any> {
  // 尝试解析工具名
  let parsed = splitToolName(toolName);

  // 反向映射可能未填充（重启后第一次直接调用），触发一次 listTools 填充
  if (!parsed) {
    await listTools(token, log);
    parsed = splitToolName(toolName);
  }

  if (!parsed) {
    throw new Error(`无效的工具名: ${toolName}`);
  }

  log(`[proxy] tools/call → ${parsed.server}.${parsed.tool}`);

  const resp = await callUpstream(
    parsed.server,
    'tools/call',
    token,
    { name: parsed.tool, arguments: args },
    `call-${Date.now()}`,
  );

  if (resp?.error) {
    throw new Error(resp.error.message || JSON.stringify(resp.error));
  }

  return resp?.result ?? resp;
}
