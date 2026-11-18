// Synthetic local client packages and CDN responses only. No account/game traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WECHAT_RESOURCE_SERVER as server, discoverResourceVersion, readWechatResourceBootstrap,
  resolveResourceVersion, resourceAppConfigUrl, parseResourceAppVersion } from '../src/resource-version.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resource-version-'));
const env = { APPDATA: directory };
const applet = path.join(directory, 'Tencent/xwechat/radium/users/fixture/applet');
const packages = path.join(applet, 'packages/wx2ea52a972ea18e5e');
const cache = path.join(applet, 'local/wx2ea52a972ea18e5e/usr/gamecaches');
const uuid = 'd2f7743d-f0aa-4d41-b5b1-f888fe23d3fd';
const index = { uuids: [uuid], types: ['cc.JsonAsset'], paths: { 0: ['appConfig', 0] }, versions: { import: [0, 'asset'] } };
const raw = version => [[0, 'appConfig', { config: { version }, bundle: { server } }]];
const assetUrl = resourceAppConfigUrl(index);
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
function archive(entries) {
  const files = entries.map(([name, text]) => ({ name: Buffer.from(name), data: Buffer.from(text) }));
  const indexLength = 4 + files.reduce((sum, row) => sum + 12 + row.name.length, 0);
  const bodyLength = files.reduce((sum, row) => sum + row.data.length, 0);
  const data = Buffer.alloc(14 + indexLength + bodyLength);
  data[0] = 0xbe; data[13] = 0xed;
  data.writeUInt32BE(indexLength, 5); data.writeUInt32BE(bodyLength, 9); data.writeUInt32BE(files.length, 14);
  let p = 18, body = 14 + indexLength;
  for (const row of files) {
    data.writeUInt32BE(row.name.length, p); p += 4; row.name.copy(data, p); p += row.name.length;
    data.writeUInt32BE(body, p); p += 4; data.writeUInt32BE(row.data.length, p); p += 4;
    row.data.copy(data, body); body += row.data.length;
  }
  return data;
}
function packageFile(version, resources, resourceServer = server) {
  const file = path.join(packages, String(version), '__APP__.wxapkg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, archive([['/src/settings.fixture.json', JSON.stringify({ assets: { server: resourceServer,
    bundleVers: { resources, config_cn: 'base-package-config-is-not-the-latest' } } })]]));
  return file;
}
function cacheFiles(resources, version, asset = 'app-config.json') {
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(cache, asset), JSON.stringify(raw(version)));
  fs.writeFileSync(path.join(cache, 'cacheList.json'), JSON.stringify({ files: {
    [server + 'remote/resources/config.' + resources + '.json']: { url: 'wxfile://usr/gamecaches/index.json' },
    [assetUrl]: { url: 'wxfile://usr/gamecaches/' + asset },
  } }));
}
try {
  await test('无微信客户端时不猜版本、不发网络请求', async () => {
    assert.equal(discoverResourceVersion({ env }), null);
    assert.equal(await resolveResourceVersion({ env, fetchJson: () => assert.fail('no request') }), null);
  });
  await test('跟随最新主包对应的 appConfig，不把出厂配置表哈希当热更新版本', async () => {
    packageFile(76, 'r76'); cacheFiles('r76', '1.14.5');
    const found = discoverResourceVersion({ env });
    assert.deepEqual(found, { appVersion: '1.14.5', source: 'wechat-cache', packageVersion: 76, resourcesVersion: 'r76' });
    assert.equal(await resolveResourceVersion({ env, fetchJson: () => assert.fail('already cached') }).then(row => row.appVersion), '1.14.5');
    assert.equal(readWechatResourceBootstrap({ env }).cacheDirectory, cache);
  });
  await test('新主包缺少对应缓存时，按官方资源索引下载版本而不是回退旧缓存', async () => {
    packageFile(77, 'r77');
    assert.equal(discoverResourceVersion({ env }), null);
    const requested = [];
    const found = await resolveResourceVersion({ env, fetchJson: async url => {
      requested.push(url);
      if (url === server + 'remote/resources/config.r77.json') return index;
      assert.equal(url, assetUrl); return raw('1.15.0');
    } });
    assert.equal(found.appVersion, '1.15.0'); assert.equal(found.source, 'wechat-package-cdn');
    assert.deepEqual(requested, [server + 'remote/resources/config.r77.json', assetUrl]);
    await assert.rejects(resolveResourceVersion({ env, fetchJson: async () => { throw Error('offline'); } }), /offline/);
  });
  await test('缓存随后补齐或被更新时能重新发现，不长期缓存失败和旧值', () => {
    cacheFiles('r77', '1.15.0');
    assert.equal(discoverResourceVersion({ env }).appVersion, '1.15.0');
    cacheFiles('r77', '1.16.20');
    assert.equal(discoverResourceVersion({ env }).appVersion, '1.16.20');
  });
  await test('损坏或不可信的最新包拒绝使用，不退回旧版本或陌生服务器', async () => {
    const file = packageFile(78, 'r78', 'https://invalid.invalid/');
    assert.throws(() => discoverResourceVersion({ env }), /资源服务器/);
    fs.writeFileSync(file, 'broken');
    await assert.rejects(resolveResourceVersion({ env, fetchJson: () => assert.fail('invalid package') }));
    packageFile(78, 'r78');
  });
  await test('拒绝缓存路径越界与 malformed appConfig', async () => {
    cacheFiles('r78', '1.16.20');
    const file = path.join(cache, 'cacheList.json');
    const list = JSON.parse(fs.readFileSync(file));
    list.files[assetUrl].url = 'wxfile://usr/gamecaches/../outside.json';
    fs.writeFileSync(file, JSON.stringify(list));
    assert.throws(() => discoverResourceVersion({ env }), /缓存路径无效/);
    for (const value of ['1.2', '../other', '1.2.3/else']) assert.throws(() => parseResourceAppVersion(raw(value)), /客户端版本/);
    const wrong = raw('1.2.3'); wrong[0][2].bundle.server = 'https://invalid.invalid/';
    assert.throws(() => parseResourceAppVersion(wrong), /资源服务器/);
    assert.throws(() => parseResourceAppVersion([...raw('1.2.3'), ...raw('1.2.4')]), /客户端版本/);
    assert.throws(() => resourceAppConfigUrl({ ...index, versions: { import: [0, '../escape'] } }), /导入路径/);
  });
  await test('支持 appConfig 合包以及压缩 UUID，仍只解析唯一命名资产', () => {
    const packed = { ...index, versions: { import: ['pack123', 'hash'] }, packs: { pack123: [0] } };
    assert.equal(resourceAppConfigUrl(packed), server + 'remote/resources/import/pa/pack123.hash.json');
    const compressed = { ...index, uuids: ['d293Q98KpNQbWx+Ij+I9P9'] };
    assert.equal(resourceAppConfigUrl(compressed), assetUrl);
    assert.equal(parseResourceAppVersion([['unrelated'], raw('1.17.0')]), '1.17.0');
  });
  await test('本地版本缓存损坏时按当前包的官方 URL 恢复，远程失败仍拒绝旧版', async () => {
    for (const broken of ['cacheList.json', 'index.json', 'app-config.json']) {
      cacheFiles('r78', '1.16.20');
      fs.writeFileSync(path.join(cache, broken), '{broken');
      assert.throws(() => discoverResourceVersion({ env }));
      const requested = [];
      const found = await resolveResourceVersion({ env, fetchJson: async url => {
        requested.push(url);
        if (url === server + 'remote/resources/config.r78.json') return index;
        assert.equal(url, assetUrl);
        return raw('1.17.0');
      } });
      assert.equal(found.appVersion, '1.17.0');
      assert.equal(found.packageVersion, 78);
      assert.equal(found.source, 'wechat-package-cdn');
      assert.deepEqual(requested, [server + 'remote/resources/config.r78.json', assetUrl]);
      await assert.rejects(resolveResourceVersion({ env, fetchJson: async () => { throw Error('remote unavailable'); } }), /remote unavailable/);
    }
  });
  console.log('客户端资源版本发现通过 ' + passed + ' 项。');
} finally {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('cw-resource-version-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
