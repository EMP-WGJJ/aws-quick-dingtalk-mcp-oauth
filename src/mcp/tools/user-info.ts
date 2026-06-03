import { getDingtalkUserInfo } from '../../utils/dingtalk-api';

/**
 * MCP Tool: 获取当前用户信息
 * 用于验证整个 OAuth 流程是否正常工作
 */
export const userInfoTool = {
  name: 'get_current_user',
  description: '获取当前授权用户的钉钉个人信息，包括昵称、头像、手机号等',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },
};

export async function executeGetCurrentUser(dingtalkAccessToken: string): Promise<unknown> {
  const userInfo = await getDingtalkUserInfo(dingtalkAccessToken);
  return {
    nick: userInfo.nick,
    avatarUrl: userInfo.avatarUrl,
    mobile: userInfo.mobile,
    openId: userInfo.openId,
    unionId: userInfo.unionId,
    email: userInfo.email,
  };
}
