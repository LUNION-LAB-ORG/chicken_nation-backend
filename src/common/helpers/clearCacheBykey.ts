import { Cache } from '@nestjs/cache-manager';

export async function clearCacheBykey(cacheManager: Cache, key: string) {
  // const client = cacheManager.store.getClient(); 
  // const keys = await client.keys(`${key}/*`);
  // if (keys.length > 0) {
  //   await client.del(keys);
  // }
}