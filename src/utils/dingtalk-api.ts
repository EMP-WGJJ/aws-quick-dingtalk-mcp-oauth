import { config } from '../config';

/**
 * 钉钉 API 调用封装
 */

export interface DingtalkTokenResponse {
  accessToken: string;
  refreshToken: string;
  expireIn: number;
  corpId?: string;
}

export interface DingtalkUserInfo {
  nick: string;
  avatarUrl: string;
  mobile: string;
  openId: string;
  unionId: string;
  email: string;
  stateCode: string;
}

/**
 * 用 authCode 换取钉钉用户 token
 */
export async function exchangeDingtalkToken(authCode: string): Promise<DingtalkTokenResponse> {
  const response = await fetch(config.dingtalk.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: config.dingtalk.appKey,
      clientSecret: config.dingtalk.appSecret,
      code: authCode,
      grantType: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`钉钉 token 交换失败: ${response.status} ${error}`);
  }

  return response.json() as Promise<DingtalkTokenResponse>;
}

/**
 * 刷新钉钉用户 token
 */
export async function refreshDingtalkToken(refreshToken: string): Promise<DingtalkTokenResponse> {
  const response = await fetch(config.dingtalk.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: config.dingtalk.appKey,
      clientSecret: config.dingtalk.appSecret,
      refreshToken: refreshToken,
      grantType: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`钉钉 token 刷新失败: ${response.status} ${error}`);
  }

  return response.json() as Promise<DingtalkTokenResponse>;
}

/**
 * 获取钉钉用户信息
 */
export async function getDingtalkUserInfo(accessToken: string): Promise<DingtalkUserInfo> {
  const response = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
    method: 'GET',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`获取钉钉用户信息失败: ${response.status} ${error}`);
  }

  return response.json() as Promise<DingtalkUserInfo>;
}

/**
 * 通用钉钉 API 调用
 */
export async function callDingtalkApi(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  accessToken: string,
  body?: unknown
): Promise<unknown> {
  const url = `https://api.dingtalk.com${path}`;
  const headers: Record<string, string> = {
    'x-acs-dingtalk-access-token': accessToken,
    'Content-Type': 'application/json',
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`钉钉 API 调用失败: ${method} ${path} → ${response.status} ${error}`);
  }

  return response.json();
}
