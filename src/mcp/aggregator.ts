import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
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

// 工具全名（<server>__<tool>）长度上限。
// 实测 Amazon Quick 拒绝过长工具名：comm-a 最长 38 成功，comm-b（teambition）最长 44 失败。
// 取 38 为安全阈值，超过则缩短工具名部分并维护反向映射。
const MAX_TOOL_NAME_LEN = 38;

// 缩短名 → { server, tool } 的全局反向映射（tools/list 时填充，tools/call 时查询路由）
const shortNameMap = new Map<string, { server: string; tool: string }>();

/**
 * 生成符合 Amazon Quick / MCP 规范的工具全名：
 * 1) 字符消毒：工具名只允许 [a-zA-Z0-9_-]，其它字符（中文、点号等）替换为下划线，
 *    避免 Quick 校验拒绝（实测 teambition 的中文名/点号名导致整组 Creation failed）。
 * 2) 长度控制：全名 <server>__<tool> 不超过 MAX_TOOL_NAME_LEN，超出则截断 + 哈希后缀。
 * 两种变换都登记反向映射（缩短/消毒名 → 原始 server+tool），tools/call 用原始名调用上游。
 */
function buildToolName(server: string, tool: string): string {
  // 1) 消毒非法字符：非 [a-zA-Z0-9_-] 一律转下划线，再折叠/去首尾下划线
  let safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');

  const prefix = `${server}${PREFIX_SEP}`;
  const hash = createHash('sha1').update(`${server}/${tool}`).digest('hex').slice(0, 4);

  // 消毒后若为空（如纯中文名），或仍含非 ASCII（保险），用哈希兜底保证唯一非空
  const asciiSafe = /^[a-zA-Z0-9_-]+$/.test(safeTool) && safeTool.length > 0;

  let finalName: string;
  if (asciiSafe && `${prefix}${safeTool}`.length <= MAX_TOOL_NAME_LEN) {
    finalName = `${prefix}${safeTool}`;
  } else {
    const suffixLen = 1 + hash.length;
    const keep = Math.max(1, MAX_TOOL_NAME_LEN - prefix.length - suffixLen);
    const base = asciiSafe ? safeTool.slice(0, keep) : 'tool';
    finalName = `${prefix}${base}_${hash}`;
  }

  shortNameMap.set(finalName, { server, tool });
  return finalName;
}

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

/**
 * Schema 消毒：修正钉钉上游返回的不合规 inputSchema，确保符合 JSON Schema Draft 7，
 * 否则 Amazon Quick 的 publish 校验会拒绝整个 connector（实测 teambition 的
 * create_task / update_project_info 的 required 引用了 properties 中不存在的字段）。
 *
 * 处理规则（递归）：
 * - required 数组中剔除 properties 里不存在的字段名（保留合法项）；剔空则删除 required
 * - 递归处理 properties 子 schema 与 items
 * 只修正有问题的部分，合规 schema 原样返回；不改变工具的实际可用参数。
 */
function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const node: any = Array.isArray(schema) ? [...schema] : { ...schema };

  // 修正 required：仅保留确实存在于 properties 的字段
  if (Array.isArray(node.required)) {
    const props = node.properties && typeof node.properties === 'object'
      ? Object.keys(node.properties)
      : [];
    const filtered = node.required.filter((r: unknown) => typeof r === 'string' && props.includes(r));
    if (filtered.length > 0) node.required = filtered;
    else delete node.required;
  }

  // 递归 properties
  if (node.properties && typeof node.properties === 'object') {
    const newProps: Record<string, unknown> = {};
    for (const k of Object.keys(node.properties)) {
      newProps[k] = sanitizeSchema(node.properties[k]);
    }
    node.properties = newProps;
  }
  // 递归 items
  if (node.items) node.items = sanitizeSchema(node.items);

  return node;
}

// 按分组缓存聚合工具
interface ToolsCache { fetchedAt: number; tools: McpTool[]; }
const groupCache: Record<string, ToolsCache> = {};
const inflight: Record<string, Promise<McpTool[]> | undefined> = {};

/** 拉取并聚合某分组的工具（带缓存 + 单飞 + 安全/危险过滤 + 前缀）
 *  serverSubset: 仅用于调试二分，传入则只聚合子集且不走缓存 */
async function getGroupTools(
  group: GroupDef,
  dingtalkToken: string,
  serverSubset?: string[]
): Promise<McpTool[]> {
  const useServers = serverSubset && serverSubset.length > 0
    ? group.servers.filter((s) => serverSubset.includes(s))
    : group.servers;
  const isSubset = serverSubset && serverSubset.length > 0;

  const now = Date.now();
  if (!isSubset) {
    const cached = groupCache[group.key];
    if (cached && now - cached.fetchedAt < TOOLS_CACHE_TTL_MS) return cached.tools;
    if (inflight[group.key]) return inflight[group.key]!;
  }

  const build = (async () => {
    const results = await Promise.allSettled(
      useServers.map((s) => callUpstream(s, 'tools/list', dingtalkToken, {}, `list-${s}`))
    );
    const aggregated: McpTool[] = [];
    results.forEach((r, idx) => {
      const server = useServers[idx];
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
          name: buildToolName(server, t.name),
          title: t.title,
          description,
          inputSchema: sanitizeSchema(t.inputSchema),
        });
      }
    });
    if (!isSubset) {
      groupCache[group.key] = { fetchedAt: Date.now(), tools: aggregated };
    }
    console.log(`[aggregator:${group.key}] 刷新完成: ${aggregated.length} 个工具${isSubset ? ` (子集: ${useServers.join(',')})` : ''}`);
    return aggregated;
  })();

  if (isSubset) {
    // 子集模式：不缓存、不单飞，直接返回
    return await build;
  }

  inflight[group.key] = build;
  try {
    return await inflight[group.key]!;
  } finally {
    inflight[group.key] = undefined;
  }
}

function splitPrefixedName(prefixed: string): { server: string; tool: string } | null {
  // 优先查缩短名映射（被缩短的工具名无法靠 __ 还原原始 tool）
  const mapped = shortNameMap.get(prefixed);
  if (mapped) return mapped;

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
          // 调试用：?servers=oa,mail 仅聚合子集（二分排查 Quick 创建失败）
          const subsetRaw = (req.query.servers as string) || '';
          const subset = subsetRaw.split(',').map((s) => s.trim()).filter(Boolean);
          const tools = await getGroupTools(group, dingtalkToken, subset);
          res.json(jsonRpcResult(id, { tools }));
          return;
        }

        case 'tools/call': {
          const prefixedName = params?.name;
          if (!prefixedName) { res.json(jsonRpcError(id, -32602, '缺少 tool name')); return; }
          let parsed = splitPrefixedName(prefixedName);
          // 兜底：缩短名映射可能因实例重启/未调用过 tools/list 而缺失，
          // 先触发本组 tools/list 填充 shortNameMap 后重试一次。
          if (!parsed) {
            await getGroupTools(group, dingtalkToken);
            parsed = splitPrefixedName(prefixedName);
          }
          if (!parsed) {
            res.json(jsonRpcError(id, -32602, `无效的工具名: ${prefixedName}`));
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
