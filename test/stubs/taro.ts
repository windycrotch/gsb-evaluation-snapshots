// 测试环境下的 Taro 桩：仅提供 storage 服务会用到的同步/异步存储接口，
// 数据落在 jsdom 的 localStorage 上。
const Taro = {
  getStorageSync(key: string) {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage.getItem(key);
  },
  setStorageSync(key: string, data: unknown) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      key,
      typeof data === 'string' ? data : JSON.stringify(data)
    );
  },
  removeStorageSync(key: string) {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  }
};

export default Taro;
