// 从游戏发布清单下载并验证配置与地图，不需要微信资源缓存或账号登录。
import { createResourceUpdater } from '../src/resource-updater.mjs';
const updater = createResourceUpdater({ onEvent: ({ message }) => console.log(message) });
try {
  const result = await updater.check();
  if (result.status === 'error') process.exitCode = 1;
  else if (result.status === 'current') console.log('配置表和地图已与客户端发布清单一致：' + result.version + '（不包含协议下载）');
  if (result.status === 'current' || result.status === 'updated') {
    const view = updater.view();
    console.log('版本来源：' + view.versionSource + (view.sourcePackageVersion ? '，微信游戏包 ' + view.sourcePackageVersion : ''));
  }
  else if (result.status === 'disabled') console.log('未执行资源更新：' + result.reason);
} finally { await updater.stop(); }
