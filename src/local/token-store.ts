/**
 * 本地 token 持久化存储
 * 将钉钉 user_access_token / refresh_token 存储在本地文件中，
 * 支持自动刷新（过期前主动刷新）。
 *
 * 存储路径: ~/.dingtalk-mcp/token.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const TOKEN_DIR = path.join(os.homedir(), '.dingtalk-mcp');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token.json');

/** 提前 5 分钟视为即将过期，触发刷新 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface LocalToken {
  accessToken: string;
  refreshToken: string;
  /** token 过期时间戳（毫秒） */
  expiresAt: number;
  /** 钉钉 corpId */
  corpId: string;
  /** 用户昵称（登录时获取，仅用于显示） */
  nick?: string;
}

/**
 * 从本地文件读取 token
 * @returns token 对象，若文件不存在或格式异常返回 null
 */
export function loadToken(): LocalToken | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
    const data = JSON.parse(raw) as LocalToken;
    if (!data.accessToken || !data.refreshToken || !data.expiresAt) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 将 token 写入本地文件
 */
export function saveToken(token: LocalToken): void {
  if (!fs.existsSync(TOKEN_DIR)) {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
  }
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), 'utf-8');
}

/**
 * 删除本地 token 文件（登出时使用）
 */
export function clearToken(): void {
  if (fs.existsSync(TOKEN_FILE)) {
    fs.unlinkSync(TOKEN_FILE);
  }
}

/**
 * 判断 token 是否需要刷新（已过期或即将过期）
 */
export function isTokenExpired(token: LocalToken): boolean {
  return Date.now() >= token.expiresAt - REFRESH_BUFFER_MS;
}

/**
 * 刷新钉钉 token 并持久化
 * 独立于远程版的 dingtalk-api.ts，避免引入远程版的 config 依赖
 */
export async function refreshAndSave(
  token: LocalToken,
  appKey: string,
  appSecret: string,
): Promise<LocalToken> {
  const tokenUrl = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: appKey,
      clientSecret: appSecret,
      refreshToken: token.refreshToken,
      grantType: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`钉钉 token 刷新失败: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    expireIn: number;
    corpId?: string;
  };

  const updated: LocalToken = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + data.expireIn * 1000,
    corpId: data.corpId || token.corpId,
    nick: token.nick,
  };

  saveToken(updated);
  return updated;
}
