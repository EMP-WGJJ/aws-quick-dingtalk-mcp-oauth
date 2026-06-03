import { config } from '../config';
import { IStorage } from './interface';
import { MemoryStorage } from './memory';
import { DynamoStorage } from './dynamo';

/**
 * 存储工厂
 * 根据 config.storageDriver 选择存储实现：
 * - 'memory'：内存存储，仅用于本地开发（进程重启数据丢失）
 * - 'dynamo'：DynamoDB 存储，生产环境使用
 */
export function createStorage(): IStorage {
  switch (config.storageDriver) {
    case 'dynamo':
      console.log(`[storage] 使用 DynamoDB 存储 (table=${config.dynamo.tableName}, region=${config.aws.region})`);
      return new DynamoStorage();
    case 'memory':
    default:
      console.log('[storage] 使用内存存储（仅限本地开发，进程重启数据丢失）');
      return new MemoryStorage();
  }
}
