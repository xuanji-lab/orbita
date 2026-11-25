/**
 * 最小的 LRU：Map 本身按插入序迭代，`get` 命中时删了再插到队尾，超出上限从队首（最久没用）淘汰。
 * 消费者：主进程的网页缩略图缓存、renderer 的缩略图跨挂载缓存。
 */
export class LruCache<V> {
  private readonly items = new Map<string, V>();
  private readonly max: number;

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  get size(): number {
    return this.items.size;
  }

  get(key: string): V | undefined {
    const value = this.items.get(key);
    if (value === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  delete(key: string): void {
    this.items.delete(key);
  }
}
