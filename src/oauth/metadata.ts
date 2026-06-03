import { Router, Request, Response } from 'express';
import { config } from '../config';

const router = Router();

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 * 供 MCP 客户端（Amazon Quick）发现授权端点、注册端点、PKCE 与 DCR 能力。
 */
function authServerMetadata() {
  return {
    issuer: config.baseUrl,
    authorization_endpoint: `${config.baseUrl}/authorize`,
    token_endpoint: `${config.baseUrl}/token`,
    registration_endpoint: `${config.baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: ['openid', 'dingtalk:contact:read', 'dingtalk:message:send'],
  };
}

router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  res.json(authServerMetadata());
});

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 *
 * MCP 客户端先访问 MCP endpoint，收到 401 + WWW-Authenticate（指向本端点），
 * 再来此发现「该受保护资源由哪个授权服务器签发 token」。
 *
 * 由于本网关有多个分组 endpoint（/mcp/office 等），每个都是独立受保护资源，
 * 因此支持带路径后缀的发现：
 *   /.well-known/oauth-protected-resource            （根，resource=baseUrl/mcp）
 *   /.well-known/oauth-protected-resource/mcp/office  （具体分组）
 */
function protectedResourceMetadata(resource: string) {
  return {
    resource,
    authorization_servers: [config.baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'dingtalk:contact:read', 'dingtalk:message:send'],
    resource_documentation: `${config.baseUrl}/`,
  };
}

// 带路径后缀：/.well-known/oauth-protected-resource/<resourcePath>
// Express 5 通配符需命名（*splat）
router.get('/.well-known/oauth-protected-resource/*splat', (req: Request, res: Response) => {
  // req.path 形如 /.well-known/oauth-protected-resource/mcp/office
  const prefix = '/.well-known/oauth-protected-resource';
  const resourcePath = req.path.substring(prefix.length); // 如 /mcp/office
  const resource = `${config.baseUrl}${resourcePath}`;
  res.json(protectedResourceMetadata(resource));
});

// 根路径
router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
  res.json(protectedResourceMetadata(`${config.baseUrl}/mcp`));
});

export default router;
