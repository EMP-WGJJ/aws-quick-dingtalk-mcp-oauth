import { Router, Request, Response } from 'express';
import { IStorage } from '../storage/interface';
import { createAuthMiddleware } from './middleware';

/**
 * 钉钉 MCP 分组聚合网关
 *
 * 背景：钉钉上游 15 个 server 共 316 个工具，超过 Amazon Quick 单连接器 100 工具上限。
 * 方案：按业务域 + 危险隔离拆成 5 个分组，每个分组一个 endpoint，作为独立 MCP server。
 *
 * 分组（每组工具数均 < 100）：
 *   /mcp/office  办公协作  contact+calendar+todo+report（仅安全工具）   ~58
 *   /mcp/docs    文档知识  doc+wiki+drive（仅安全工具）                 ~45
 *   /mcp/tables  表格数据  aitable+sheet（仅安全工具）                  ~92
 *   /mcp/comm    沟通审批  oa+mail+bot+group+live+teambition（仅安全） ~89
 *   /mcp/danger  危险操作  以上所有 server 的 delete/remove/revoke/reject ~32
 *
 * 设计：
 * - 工具名加 `<server>__<tool>` 前缀，tools/call 按前缀路由回上游对应 server。
 * - 安全/危险按工具名动词判定（危险 = delete/remove/revoke/reject，含 batch_ 前缀）。
 * - tools/list 按分组全局缓存（工具定义对所有用户一致）。
 * - 某 server 失败则跳过（优雅降级）。
 */

const DINGTALK_MCP_GW_BASE = 'https://mcp-gw.dingtalk.com/server';
const PREFIX_SEP = '__';

const SERVER_LABEL: Record<string, string> = {
  bot: '机器人消息', report: '钉钉日志', aitable: 'AI表格', doc: '钉钉文档',
  wiki: '知识库', contact: '通讯录', calendar: '日历', todo: '待办',
  sheet: '在线表格', group: '群聊', drive: '钉盘', oa: 'OA审批',
  mail: '邮箱', teambition: '项目管理', live: '直播',
};

// 危险动词：工具名去掉 batch_ 前缀后以这些开头
const DANGER_VERBS = ['delete', 'remove', 'revoke', 'reject'];

function isDangerTool(name: string): boolean {
  const n = name.replace(/^batch_/, '');
  return DANGER_VERBS.some((v) => n === v || n.startsWith(v + '_'));
}

/** 分组定义 */
interface GroupDef {
  key: string;          // 路径与缓存键
  label: string;        // 中文名
  servers: string[];    // 包含的上游 server
  mode: 'safe' | 'danger'; // safe=仅非危险工具；danger=仅危险工具
  description: string;  // serverInfo 描述（给用户/agent 的提示）
}

const ALL_BUSINESS_SERVERS = [
  'contact', 'calendar', 'todo', 'report', 'doc', 'wiki', 'drive',
  'aitable', 'sheet', 'oa', 'mail', 'bot', 'group', 'live', 'teambition',
];

const GROUPS: Record<string, GroupDef> = {
  office: {
    key: 'office', label: '办公协作',
    servers: ['contact', 'calendar', 'todo', 'report'],
    mode: 'safe',
    description: '钉钉办公协作：通讯录、日历、待办、日志（仅查询与新增/更新类操作，不含删除）。',
  },
  docs: {
    key: 'docs', label: '文档知识',
    servers: ['doc', 'wiki', 'drive'],
    mode: 'safe',
    description: '钉钉文档知识：文档、知识库、钉盘（仅查询与新增/更新类操作，不含删除）。',
  },
  tables: {
    key: 'tables', label: '表格数据',
    servers: ['aitable', 'sheet'],
    mode: 'safe',
    description: '钉钉表格数据：AI 表格、在线表格（仅查询与新增/更新类操作，不含删除）。',
  },
  comm: {
    key: 'comm', label: '沟通审批',
    servers: ['oa', 'mail', 'bot', 'group', 'live', 'teambition'],
    mode: 'safe',
    description: '钉钉沟通审批：OA 审批、邮箱、机器人、群聊、直播、项目管理（仅查询与新增/更新类操作，不含删除）。',
  },
  danger: {
    key: 'danger', label: '危险操作',
    servers: ALL_BUSINESS_SERVERS,
    mode: 'danger',
    description:
      '⚠️ 钉钉危险操作集合：包含删除/移除/撤销/驳回等不可逆操作（delete/remove/revoke/reject）。' +
      '【给 AI 助手的强制要求】调用本组任何工具前，必须先向用户明确说明：(1)将要执行的具体操作；' +
      '(2)影响的对象与范围（如删除哪个日程、移除哪个成员）；(3)该操作不可逆。' +
      '必须获得用户明确确认后才能调用。严禁在未经用户确认的情况下执行本组工具。',
  },
};

const TOOLS_CACHE_TTL_MS =
  (parseInt(process.env.MCP_TOOLS_CACHE_TTL || '600', 10) || 600) * 1000;

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

async function callUpstream(
  server: string,
  method: string,
  dingtalkToken: string,
  params: unknown,
  id: string | number
): Promise<{ status: number; body: any; contentType: string }> {
  const res = await fetch(`${DINGTALK_MCP_GW_BASE}/${server}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-user-access-token': dingtalkToken,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
  });
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  let body: any;
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    body = dataLine ? safeJson(dataLine.slice(5).trim()) : { _raw: text };
  } else {
    body = safeJson(text);
  }
  return { status: res.status, body, contentType };
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

// 按分组缓存聚合工具
interface ToolsCache { fetchedAt: number; tools: McpTool[]; }
const groupCache: Record<string, ToolsCache> = {};
const inflight: Record<string, Promise<McpTool[]> | undefined> = {};

/** 拉取并聚合某分组的工具（带缓存 + 单飞 + 安全/危险过滤 + 前缀） */
async function getGroupTools(group: GroupDef, dingtalkToken: string): Promise<McpTool[]> {
  const now = Date.now();
  const cached = groupCache[group.key];
  if (cached && now - cached.fetchedAt < TOOLS_CACHE_TTL_MS) return cached.tools;
  if (inflight[group.key]) return inflight[group.key]!;

  inflight[group.key] = (async () => {
    const results = await Promise.allSettled(
      group.servers.map((s) => callUpstream(s, 'tools/list', dingtalkToken, {}, `list-${s}`))
    );
    const aggregated: McpTool[] = [];
    results.forEach((r, idx) => {
      const server = group.servers[idx];
      if (r.status !== 'fulfilled') {
        console.warn(`[aggregator:${group.key}] ${server} tools/list 失败，跳过`);
        return;
      }
      const resp = r.value.body;
      if (resp?.error) {
        console.warn(`[aggregator:${group.key}] ${server} 返回错误，跳过: ${resp.error.message}`);
        return;
      }
      const tools: McpTool[] = resp?.result?.tools ?? resp?.tools ?? [];
      for (const t of tools) {
        const danger = isDangerTool(t.name);
        // 按分组 mode 过滤：safe 组只要非危险，danger 组只要危险
        if (group.mode === 'safe' && danger) continue;
        if (group.mode === 'danger' && !danger) continue;

        let description = `[${SERVER_LABEL[server] || server}] ${t.description ?? ''}`.trim();
        if (group.mode === 'danger') {
          description =
            `⚠️【危险/不可逆操作】调用前必须先向用户说明操作内容与影响范围并取得明确确认。` +
            description;
        }
        aggregated.push({
          name: `${server}${PREFIX_SEP}${t.name}`,
          title: t.title,
          description,
          inputSchema: t.inputSchema,
        });
      }
    });
    groupCache[group.key] = { fetchedAt: Date.now(), tools: aggregated };
    console.log(`[aggregator:${group.key}] 刷新完成: ${aggregated.length} 个工具`);
    return aggregated;
  })();

  try {
    return await inflight[group.key]!;
  } finally {
    inflight[group.key] = undefined;
  }
}

function splitPrefixedName(prefixed: string): { server: string; tool: string } | null {
  const sep = prefixed.indexOf(PREFIX_SEP);
  if (sep <= 0) return null;
  const server = prefixed.slice(0, sep);
  const tool = prefixed.slice(sep + PREFIX_SEP.length);
  if (!SERVER_LABEL[server] || !tool) return null;
  return { server, tool };
}

function jsonRpcResult(id: any, result: unknown) { return { jsonrpc: '2.0', id, result }; }
function jsonRpcError(id: any, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * 分组 MCP 路由：/mcp/:group（office|docs|tables|comm|danger）
 */
export function createMcpAggregatorRouter(storage: IStorage): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(storage);

  // 列出所有分组（无需鉴权，便于发现）
  router.get('/mcp/groups', (_req: Request, res: Response) => {
    res.json({
      groups: Object.values(GROUPS).map((g) => ({
        key: g.key,
        label: g.label,
        url: `/mcp/${g.key}`,
        mode: g.mode,
        description: g.description,
      })),
    });
  });

  router.post('/mcp/:group', authMiddleware, async (req: Request, res: Response) => {
    const groupKey = req.params.group as string;
    const group = GROUPS[groupKey];
    if (!group) {
      res.status(404).json(
        jsonRpcError(req.body?.id ?? null, -32601,
          `未知分组: ${groupKey}。可用: ${Object.keys(GROUPS).join(', ')}`)
      );
      return;
    }

    const { method, params, id } = req.body || {};
    const dingtalkToken = req.dingtalkAccessToken!;

    try {
      switch (method) {
        case 'initialize':
          res.json(jsonRpcResult(id, {
            protocolVersion: '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: `dingtalk-mcp-${group.key}`,
              version: '1.0.0',
              // 部分客户端会展示 instructions，用于提示用户/agent
              ...(group.mode === 'danger' ? { instructions: group.description } : {}),
            },
          }));
          return;

        case 'notifications/initialized':
        case 'initialized':
          res.status(202).end();
          return;

        case 'ping':
          res.json(jsonRpcResult(id, {}));
          return;

        case 'tools/list': {
          const tools = await getGroupTools(group, dingtalkToken);
          res.json(jsonRpcResult(id, { tools }));
          return;
        }

        case 'tools/call': {
          const prefixedName = params?.name;
          if (!prefixedName) { res.json(jsonRpcError(id, -32602, '缺少 tool name')); return; }
          const parsed = splitPrefixedName(prefixedName);
          if (!parsed) {
            res.json(jsonRpcError(id, -32602, `无效的工具名: ${prefixedName}（应为 <server>__<tool>）`));
            return;
          }
          // 校验该工具确实属于本分组（防止跨组调用绕过危险隔离）
          const belongsToGroup = group.servers.includes(parsed.server)
            && (group.mode === 'danger' ? isDangerTool(parsed.tool) : !isDangerTool(parsed.tool));
          if (!belongsToGroup) {
            res.json(jsonRpcError(id, -32602,
              `工具 ${prefixedName} 不属于分组 ${group.key}`));
            return;
          }

          const upstreamParams = { ...params, name: parsed.tool };
          console.log(`[aggregator:${group.key}] tools/call → ${parsed.server}.${parsed.tool} (user=${req.tokenRecord?.userId})`);
          const upstream = await callUpstream(
            parsed.server, 'tools/call', dingtalkToken, upstreamParams, id ?? `call-${Date.now()}`
          );
          res.status(200).json(upstream.body);
          return;
        }

        default:
          res.json(jsonRpcError(id, -32601, `未知方法: ${method}`));
          return;
      }
    } catch (error) {
      console.error(`[aggregator:${group.key}] 处理失败:`, error);
      res.json(jsonRpcError(id ?? null, -32603,
        `聚合网关处理失败: ${error instanceof Error ? error.message : '未知错误'}`));
    }
  });

  return router;
}
