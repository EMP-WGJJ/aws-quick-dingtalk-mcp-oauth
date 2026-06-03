/**
 * 测试环境变量预设模块
 *
 * 必须在任何会加载 config.ts 的模块之前被 import。
 * 原因：ES module 的 import 会被提升并按出现顺序执行，config.ts 在模块
 * 加载时即读取 process.env。把环境变量设置单独放在本模块，并让它成为
 * test-dynamo.ts 的第一个 import，即可保证 config 读取到正确的值。
 */

process.env.STORAGE_DRIVER = 'dynamo';
process.env.DYNAMO_ENDPOINT = process.env.TEST_DYNAMO_ENDPOINT || 'http://localhost:8000';
process.env.DYNAMO_TABLE_NAME = process.env.TEST_DYNAMO_TABLE || 'dingtalk-mcp-gateway-itest';
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-southeast-1';
// DynamoDB Local 接受任意凭证，但 SDK 需要凭证存在。
// 强制覆盖为本地假凭证，避免误用机器上的真实 AWS 凭证连到线上。
process.env.AWS_ACCESS_KEY_ID = 'local';
process.env.AWS_SECRET_ACCESS_KEY = 'local';
process.env.AWS_SESSION_TOKEN = '';
// 默认关闭 KMS（加解密透传）；显式提供 TEST_KMS_KEY_ID 时测真实加密路径。
process.env.KMS_KEY_ID = process.env.TEST_KMS_KEY_ID || '';
