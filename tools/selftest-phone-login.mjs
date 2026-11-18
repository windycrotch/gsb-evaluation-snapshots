import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cw-phone-profile-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_EWAN_DEVICE = path.join(directory, 'device.json');
process.once('exit', () => {
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
});
const {
  createPhoneLogin, decryptBody, encryptForm, PHONE_LOGIN, PhoneLoginError, DEVICE_PRESETS,
  ensureDeviceProfile, loadDeviceProfile, saveDeviceProfile, md5,
} = await import('../src/phone-login.mjs');
const execFileAsync = promisify(execFile);

assert.equal(PHONE_LOGIN.appId, '56000002');
assert.equal(PHONE_LOGIN.superAppId, '14021102');
assert.equal(PHONE_LOGIN.packetId, '259237');
assert.equal(PHONE_LOGIN.clientVersion, '1.9.4.434');
assert.equal(PHONE_LOGIN.gatewayClientVersion, '1.12.11');
assert.equal(PHONE_LOGIN.business.appId, '14021102');
assert.equal(PHONE_LOGIN.business.packetId, '50001883');
assert.equal(PHONE_LOGIN.business.sdkVersion, '100800');

assert.equal(encryptForm('abc'), '8d9fd81439f9a6935a8f1c15c08b1f9b');
assert.equal(decryptBody(encryptForm('abc')), 'abc');
const emptyOaidCiphertext = '2b49ab855c2ca3a2d90356a6125e9c48';
assert.equal(encryptForm(''), emptyOaidCiphertext);
assert.equal(decryptBody(emptyOaidCiphertext), '');

const fixedNow = 1794061114000;
const testDevice = {
  di: encryptForm('07'.repeat(8)),
  oi: emptyOaidCiphertext,
  deviceCode: '07'.repeat(8),
  businessDid: '0A'.repeat(16),
  businessDeviceCode: '07'.repeat(8),
  model: 'Test',
  sysVersion: '12',
};
const account = '13800138000';
const password = 'testpass123';
const ewanPayload = {
  status: 200,
  openId: 'ewan-open-id',
  token: 'ewan-token',
  sign: 'ewan-sign',
  timestamp: fixedNow,
  username: 'tester',
  birthday: '20001013',
  auth: '1',
  areaId: '2',
};
const businessData = {
  openId: 'game-open-id',
  token: 'raw-session-token',
  signToken: 'game-sign-token',
  sign: 'game-sign',
  ts: fixedNow,
  realName: { birthday: '2000-10-13', gender: 1 },
};

const { publicKey: fixturePublicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const fixturePublicKeyBase64 = fixturePublicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const fixtureAppKey = 'fixture-channel-app-key';

function businessResponse(call) {
  if (call.url.pathname === '/api/public/info') return { code: 0, data: { publicKey: fixturePublicKeyBase64 } };
  if (call.url.pathname === '/api/init') return {
    code: 0, data: { initId: 'fixture-init', channel: { appKey: fixtureAppKey } },
  };
  assert.equal(call.url.pathname, '/api/user/login');
  return { code: 0, data: businessData };
}

function fakeFetch({ business = businessResponse, ewan = () => ewanPayload, init = null } = {}) {
  const calls = [];
  const businessCalls = [];
  const initCalls = [];
  const authCalls = [];
  let appKey;
  let authKey = PHONE_LOGIN.aesKey;
  const impl = async (url, options = {}) => {
    const isBusiness = String(url).startsWith(PHONE_LOGIN.businessBase);
    if (isBusiness) {
      const parsed = new URL(url);
      const body = options.body ? JSON.parse(options.body) : null;
      const call = { url: parsed, method: options.method ?? 'GET', body, headers: options.headers };
      calls.push(call);
      businessCalls.push(call);
      const payload = await business(call);
      if (parsed.pathname === '/api/init') appKey = payload.data?.channel?.appKey;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const isInit = new URL(url).hostname === 'duoinitsdk.ewan.cn';
    const key = isInit ? md5(appKey).slice(8, 24) : authKey;
    const plain = decryptBody(options.body, key);
    const call = { url, options, plain, fields: new URLSearchParams(plain) };
    calls.push(call);
    if (isInit) {
      initCalls.push(call);
      const config = PHONE_LOGIN;
      assert.equal(options.headers.ai, config.appId);
      assert.equal(url, `${config.initUrl}?requestid=${config.appId}`);
      assert.equal(call.fields.get('protocol'), '400008');
      assert.equal(call.fields.get('sign'), md5(`${config.appId}|${appKey}`));
      assert.equal(call.fields.has('appserverid'), false);
      assert.equal(call.fields.has('userpoint'), false);
      assert.equal(decryptBody(options.headers.di, key), call.fields.get('devicecode'));
      assert.equal(options.headers.rdt, '');
      const payload = init ? await init(call) : {
        status: 200, k: config.aesKey, loginurl: config.loginUrl, accounturl: config.accountUrl,
      };
      if (payload.status === 200 && typeof payload.k === 'string' && Buffer.byteLength(payload.k) === 16) authKey = payload.k;
      return new Response(encryptForm(JSON.stringify(payload), key), { status: 200 });
    }
    authCalls.push(call);
    const payload = await ewan(call);
    return new Response(encryptForm(JSON.stringify(payload), key), { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  return { impl, calls, businessCalls, initCalls, authCalls };
}

{
  // 已与 MuMu 内 CW6620 SDK 的 AES.Encrypt 返回值交叉核对这组人工输入。
  // Android ID 为 UTF-8 的 16 位十六进制文本，整块输入仍添加 PKCS7 填充块。
  const deviceCode = '0123456789abcdef';
  const expectedDi = '0f173c7e608812b9c299b04d890cc5322b49ab855c2ca3a2d90356a6125e9c48';
  const randomSizes = [];
  const vector = ensureDeviceProfile({
    file: path.join(directory, 'known-vector.json'),
    randomBytes(size) {
      randomSizes.push(size);
      return size === 8 ? Buffer.from(deviceCode, 'hex') : Buffer.alloc(size, 0xa5);
    },
  });
  assert.deepEqual(randomSizes, [8, 1, 16]);
  assert.equal(vector.deviceCode, deviceCode);
  assert.equal(vector.di, expectedDi);
  assert.equal(vector.oi, emptyOaidCiphertext);
  assert.equal(decryptBody(vector.di), deviceCode);
  assert.equal(decryptBody(vector.oi), '');
}

{
  // 每种预设都能生成并落盘；登录请求和 User-Agent 使用同一组机型与系统版本。
  assert.equal(new Set(DEVICE_PRESETS.map(preset => preset.model)).size, DEVICE_PRESETS.length);
  const cases = DEVICE_PRESETS.map((preset, sample) => ({ preset, sample }));
  cases.push({ preset: DEVICE_PRESETS.at(-1), sample: 255 });
  for (const { preset, sample } of cases) {
    const file = path.join(directory, `preset-${sample}.json`);
    const generated = ensureDeviceProfile({
      file,
      randomBytes: size => Buffer.alloc(size, size === 1 ? sample : 0x5a),
    });
    assert.equal(generated.model, preset.model);
    assert.equal(generated.sysVersion, preset.sysVersion);
    assert.deepEqual(loadDeviceProfile(file), generated);
    const saved = fs.readFileSync(file, 'utf8');
    assert.deepEqual(ensureDeviceProfile({ file, randomBytes: () => assert.fail('已有档案不能重新选择机型') }), generated);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);

    const fetch = fakeFetch();
    const client = createPhoneLogin({ device: loadDeviceProfile(file), fetchImpl: fetch.impl, now: () => fixedNow });
    await client.loginWithPassword(account, password);
    const businessInit = fetch.businessCalls.find(call => call.url.pathname === '/api/init');
    assert.equal(businessInit.body.pm, preset.model);
    assert.equal(businessInit.body.sv, preset.sysVersion);
    for (const call of [...fetch.initCalls, ...fetch.authCalls]) {
      assert.equal(call.fields.get('model'), preset.model);
      assert.equal(call.fields.get('sysversion'), preset.sysVersion);
      assert.ok(call.options.headers['User-Agent'].includes(`Android ${preset.sysVersion}; ${preset.model}`));
    }
  }
}

{
  // 默认入口在发送短信前落盘，后续验证和新的进程复用同一组设备字段。
  assert.equal(loadDeviceProfile(), null);
  const fetch = fakeFetch({ ewan: ({ fields }) => {
    if (fields.get('protocol') === '100015') return { status: 200 };
    if (fields.get('protocol') === '420012') return {
      status: 200, userAccount: [{ userName: 'tester', multiAccountToken: 'multi-token' }],
    };
    return ewanPayload;
  } });
  const first = createPhoneLogin({ fetchImpl: fetch.impl });
  await first.requestSmsCode(account);
  const generated = loadDeviceProfile();
  assert.equal(generated.source, 'generated');
  assert.ok(DEVICE_PRESETS.some(preset => preset.model === generated.model && preset.sysVersion === generated.sysVersion));
  assert.match(generated.di, /^[0-9a-f]{64}$/);
  assert.equal(generated.di, encryptForm(generated.deviceCode));
  assert.equal(generated.oi, emptyOaidCiphertext);
  assert.equal(decryptBody(generated.di), generated.deviceCode);
  assert.equal(decryptBody(generated.oi), '');
  assert.match(generated.deviceCode, /^[0-9a-f]{16}$/);
  assert.match(generated.businessDid, /^[0-9A-F]{32}$/);
  assert.equal(generated.businessDeviceCode, generated.deviceCode);
  const second = createPhoneLogin({ fetchImpl: fetch.impl, randomBytes: size => {
    assert.equal(size, 4, '已保存档案只为业务请求生成随机 nonce');
    return Buffer.alloc(size, 7);
  } });
  await second.loginWithSms(account, '123456');
  for (const call of fetch.authCalls) {
    assert.equal(call.options.headers.di, generated.di);
    assert.equal(call.options.headers.oi, generated.oi);
    assert.equal(call.fields.get('devicecode'), generated.deviceCode);
  }
  for (const key of ['di', 'oi', 'deviceCode', 'businessDid', 'businessDeviceCode', 'model', 'sysVersion']) {
    assert.equal(first.device[key], generated[key]);
    assert.equal(second.device[key], generated[key]);
  }
  const moduleUrl = new URL('../src/phone-login.mjs', import.meta.url).href;
  const program = `const { ensureDeviceProfile } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(ensureDeviceProfile()));`;
  const restarted = await execFileAsync(process.execPath, ['--input-type=module', '--eval', program]);
  assert.deepEqual(JSON.parse(restarted.stdout), generated);

  const concurrentFile = path.join(directory, 'concurrent-device.json');
  const children = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(
    process.execPath, ['--input-type=module', '--eval', program],
    { env: { ...process.env, CW_EWAN_DEVICE: concurrentFile } },
  )));
  const concurrent = loadDeviceProfile(concurrentFile);
  for (const child of children) {
    const childProfile = JSON.parse(child.stdout);
    assert.deepEqual(childProfile, concurrent);
    assert.equal(decryptBody(childProfile.di), childProfile.deviceCode);
    assert.equal(decryptBody(childProfile.oi), '');
  }
}

{
  // 早期自动生成的随机密文迁移为 AES 派生值，原设备码和业务身份继续使用。
  const previous = { ...testDevice, di: '07'.repeat(32), oi: '07'.repeat(16), source: 'generated', traceId: 'fixture-trace' };
  fs.writeFileSync(process.env.CW_EWAN_DEVICE, JSON.stringify(previous));
  const randomBytes = () => assert.fail('修复密文不应更换已有设备身份');
  const migrated = ensureDeviceProfile({ randomBytes });
  assert.deepEqual(migrated, {
    ...previous, di: encryptForm(previous.deviceCode), oi: emptyOaidCiphertext,
  });
  assert.equal(decryptBody(migrated.di), previous.deviceCode);
  assert.equal(decryptBody(migrated.oi), '');
  assert.deepEqual(loadDeviceProfile(), migrated);
  const saved = fs.readFileSync(process.env.CW_EWAN_DEVICE, 'utf8');
  assert.deepEqual(ensureDeviceProfile({ randomBytes }), migrated);
  assert.equal(fs.readFileSync(process.env.CW_EWAN_DEVICE, 'utf8'), saved);
}

{
  // 旧档案补全一次业务身份，重读与多客户端都保留原来的账号设备字段。
  const legacy = { di: 'a1'.repeat(32), deviceCode: 'b2'.repeat(8) };
  fs.writeFileSync(process.env.CW_EWAN_DEVICE, JSON.stringify(legacy));
  const migrated = ensureDeviceProfile();
  assert.equal(migrated.source, 'imported');
  assert.equal(migrated.di, legacy.di);
  assert.equal(migrated.oi, emptyOaidCiphertext);
  assert.equal(migrated.deviceCode, legacy.deviceCode);
  assert.equal(migrated.model, PHONE_LOGIN.deviceModel);
  assert.equal(migrated.sysVersion, '12');
  assert.match(migrated.businessDid, /^[0-9A-F]{32}$/);
  assert.equal(migrated.businessDeviceCode, legacy.deviceCode);
  assert.deepEqual(loadDeviceProfile(), migrated);
  assert.deepEqual(ensureDeviceProfile({ randomBytes: () => assert.fail('旧档案的业务身份必须持久化') }), migrated);
  const client = createPhoneLogin({ fetchImpl: async () => assert.fail('本段不应访问网络') });
  assert.equal(client.device.businessDid, migrated.businessDid);

  for (const byteCount of [16, 32, 48]) {
    const explicitOi = 'f0'.repeat(byteCount);
    const imported = saveDeviceProfile({ ...testDevice, oi: explicitOi, source: 'generated' });
    assert.equal(imported.source, 'imported');
    assert.equal(imported.di, testDevice.di);
    assert.equal(imported.oi, explicitOi);
    assert.deepEqual(ensureDeviceProfile(), imported);
    assert.equal(imported.businessDid, testDevice.businessDid);
    assert.equal(imported.businessDeviceCode, testDevice.businessDeviceCode);
    assert.equal(imported.model, testDevice.model);
    assert.equal(imported.sysVersion, testDevice.sysVersion);
  }

  const saved = fs.readFileSync(process.env.CW_EWAN_DEVICE, 'utf8');
  assert.throws(() => saveDeviceProfile({ di: testDevice.di }), /deviceCode/);
  assert.equal(fs.readFileSync(process.env.CW_EWAN_DEVICE, 'utf8'), saved);
  for (const invalid of ['{broken', 'null', JSON.stringify({ di: testDevice.di })]) {
    fs.writeFileSync(process.env.CW_EWAN_DEVICE, invalid);
    assert.equal(loadDeviceProfile(), null);
    assert.throws(() => ensureDeviceProfile(), /设备档案/);
    assert.throws(() => createPhoneLogin({ fetchImpl: async () => assert.fail('损坏档案不应访问网络') }), /设备档案/);
    assert.equal(fs.readFileSync(process.env.CW_EWAN_DEVICE, 'utf8'), invalid);
  }
}

{
  const fetch = fakeFetch();
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const result = await client.loginWithPassword(account, password);
  assert.equal(fetch.authCalls[0].url, PHONE_LOGIN.loginUrl);
  assert.equal(fetch.authCalls[0].fields.get('protocol'), '100003');
  assert.equal(fetch.authCalls[0].fields.get('username'), account);
  assert.equal(fetch.authCalls[0].fields.get('password'), password);
  assert.equal(fetch.authCalls[0].fields.get('appid'), PHONE_LOGIN.appId);
  assert.equal(fetch.authCalls[0].fields.get('packetid'), PHONE_LOGIN.packetId);
  assert.equal(fetch.authCalls[0].options.headers.ai, PHONE_LOGIN.appId);
  assert.equal(fetch.authCalls[0].options.headers.pi, PHONE_LOGIN.packetId);
  assert.equal(fetch.authCalls[0].options.headers.di.length, 64);
  assert.equal(fetch.authCalls[0].options.headers.oi, fetch.authCalls[0].options.headers.di.slice(32));
  assert.equal(result.direct, true);
  assert.equal(result.ewan.openId, 'ewan-open-id');
  assert.equal(result.ewan.token, 'ewan-token');
  assert.equal(result.ewan.sign, 'ewan-sign');
  assert.equal(result.ewan.timestamp, fixedNow);
  assert.deepEqual(client.candidateUids(result), ['ewan-open-id', 'tester', account]);
  assert.equal(JSON.stringify(result).includes(password), false);
}

{
  const fetch = fakeFetch({ ewan: ({ url, fields }) => {
    assert.equal(url, PHONE_LOGIN.loginUrl);
    if (fields.get('protocol') === '420012') {
      assert.equal(fields.get('phone'), account);
      assert.equal(fields.get('querytype'), '1');
      assert.equal(fields.get('queryvalue'), '123456');
      assert.equal(fields.get('resolution'), '720*1280');
      return {
        status: 200,
        userAccountStatus: 1,
        userAccount: [{ userId: 0, userName: 'tester', multiAccountToken: 'multi-token' }],
        phone: account,
      };
    }
    assert.equal(fields.get('protocol'), '420007');
    assert.equal(fields.get('phone'), account);
    assert.equal(fields.get('multiAccountToken'), 'multi-token');
    assert.equal(fields.get('validatecode'), '123456');
    return ewanPayload;
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const result = await client.loginWithSms(account, '123456');
  assert.equal(fetch.authCalls.length, 2);
  assert.equal(result.direct, true);
  assert.equal(result.ewan.openId, 'ewan-open-id');
  assert.equal(result.selectedAccount.userName, 'tester');
}

{
  const linkedAccounts = [
    { userName: 'first-player', multiAccountToken: 'first-multi-token' },
    { userName: 'second-player', multiAccountToken: 'second-multi-token' },
  ];
  const fetch = fakeFetch({ ewan: ({ fields }) => {
    if (fields.get('protocol') === '420012') return { status: 200, userAccount: linkedAccounts };
    assert.equal(fields.get('protocol'), '420007');
    assert.equal(fields.get('phone'), account);
    assert.equal(fields.get('validatecode'), '123456');
    const selected = linkedAccounts.find(entry => entry.multiAccountToken === fields.get('multiAccountToken'));
    assert.ok(selected);
    return { ...ewanPayload, openId: selected.userName + '-id', username: selected.userName };
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const verified = await client.verifySmsAccounts(' ' + account + ' ', ' 123456 ');
  assert.equal(verified.account, account);
  assert.equal(verified.code, '123456');
  assert.deepEqual(verified.accounts, linkedAccounts);
  assert.equal(fetch.authCalls.length, 1);
  const second = await client.loginSmsAccount(verified, verified.accounts[1]);
  const first = await client.loginSmsAccount(verified, verified.accounts[0]);
  assert.equal(second.ewan.openId, 'second-player-id');
  assert.equal(second.selectedAccount.userName, 'second-player');
  assert.equal(first.ewan.openId, 'first-player-id');
  assert.equal(second.account, account);
  assert.equal(second.accounts, verified.accounts);
  assert.equal(second.code, undefined);
  assert.deepEqual(fetch.authCalls.map(call => call.fields.get('protocol')), ['420012', '420007', '420007']);
  await assert.rejects(() => client.loginSmsAccount(verified, { ...verified.accounts[1] }), /本次短信验证/);
  await assert.rejects(() => client.loginSmsAccount(null, verified.accounts[1]), /本次短信验证/);
  assert.equal(fetch.authCalls.length, 3);
}

{
  const fetch = fakeFetch({ ewan: ({ fields }) => {
    if (fields.get('protocol') === '420012') return {
      status: 200,
      userAccount: [
        { userName: 'missing-token' },
        { userName: 'expired-token', multiAccountToken: 'expired' },
        { userName: 'available-player', multiAccountToken: 'available' },
      ],
    };
    if (fields.get('multiAccountToken') === 'expired') return { status: -100, error: 1004, errorMsg: '此账号登录凭证已过期' };
    assert.equal(fields.get('multiAccountToken'), 'available');
    return ewanPayload;
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const verified = await client.verifySmsAccounts(account, '123456');
  await assert.rejects(() => client.loginSmsAccount(verified, verified.accounts[0]), /缺少短信登录凭证/);
  assert.equal(fetch.authCalls.length, 1);
  await assert.rejects(() => client.loginSmsAccount(verified, verified.accounts[1]), error => error.code === 1004 && /已过期/.test(error.message));
  assert.equal((await client.loginSmsAccount(verified, verified.accounts[2])).ewan.openId, ewanPayload.openId);
  assert.equal(fetch.authCalls.length, 3);
}

{
  const fetch = fakeFetch({ ewan: ({ url, fields }) => {
    assert.equal(url, PHONE_LOGIN.accountUrl);
    assert.equal(fields.get('protocol'), '100015');
    assert.equal(fields.get('phone'), account);
    assert.equal(fields.get('type'), '7');
    return { status: 200, validatecode: '' };
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const result = await client.requestSmsCode(account);
  assert.equal(result.status, 200);
  assert.equal(result.validatecode, '');
}

{
  const fetch = fakeFetch({ ewan: () => ({ status: -100, error: 1002, errorMsg: '亲,用户名或密码错误哦' }) });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  await assert.rejects(
    () => client.loginWithPassword(account, password),
    (error) => error instanceof PhoneLoginError && error.code === 1002 && error.status === -100 && /用户名或密码错误/.test(error.message),
  );
}

{
  const fetch = fakeFetch({ ewan: () => ({ status: -100, error: 1004, errorMsg: '亲,动态验证码错误哦' }) });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  await assert.rejects(
    () => client.loginWithSms(account, '123456'),
    (error) => error instanceof PhoneLoginError && error.code === 1004 && /动态验证码错误/.test(error.message),
  );
}

{
  const fetch = fakeFetch({ ewan: () => ({ status: -100, error: 1068, errorMsg: '用户名或密码错误' }) });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  await assert.rejects(
    () => client.loginWithPassword(account, password),
    error => error.code === 1068 && /用户名或密码错误/.test(error.message) && /游戏 APP/.test(error.message),
  );
}

{
  const config = PHONE_LOGIN;
  const fixturePassword = 'fixture+&% Password!';
  const fetch = fakeFetch({ ewan: ({ fields, options, plain }) => {
    assert.equal(fields.get('appid'), '56000002');
    assert.equal(fields.get('superappid'), '14021102');
    assert.equal(fields.get('packetid'), '259237');
    assert.equal(fields.get('channel'), '17001784');
    assert.equal(fields.get('packagename'), 'com.gx.sw.qa.fkssj003.esj');
    assert.equal(fields.get('appversion'), '1.9.5');
    assert.equal(fields.get('appversioncode'), '444');
    for (const field of ['curvc', 'hostvc', 'sdkversionid']) assert.equal(fields.get(field), '6620');
    for (const field of ['pluginvc', 'cursubvc', 'hostsubvc']) assert.equal(fields.get(field), '354');
    for (const field of ['traceId', 'tt_channel_id', 'tt_channel_sdk_v']) assert.equal(fields.has(field), false);
    assert.equal(options.headers.ai, config.appId);
    assert.equal(options.headers.pi, config.packetId);
    assert.equal(options.headers.cv, config.sdkVersion);
    assert.equal(options.headers.rdt, '');
    if (fields.get('protocol') === '100003') {
      assert.equal(fields.get('password'), fixturePassword);
      assert.ok(plain.includes('password=fixture%2B%26%25+Password%21'));
    }
    if (fields.get('protocol') === '100015') return { status: 200 };
    if (fields.get('protocol') === '420012') return {
      status: 200, userAccount: [{ userName: 'tester', multiAccountToken: 'fixture-multi-token' }],
    };
    return ewanPayload;
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  assert.equal(Object.hasOwn(client, 'channel'), false);
  await client.loginWithPassword(account, fixturePassword);
  await client.requestSmsCode(account);
  const verified = await client.verifySmsAccounts(account, '123456');
  await client.loginSmsAccount(verified, verified.accounts[0]);
  assert.deepEqual(fetch.authCalls.map(call => call.fields.get('protocol')), ['100003', '100015', '420012', '420007']);
}

{
  // 旧调用方遗留的参数由统一配置兼容处理。
  const fetch = fakeFetch();
  const client = createPhoneLogin({ channel: 'xiaomi', fetchImpl: fetch.impl, device: testDevice });
  await client.loginWithPassword(account, password);
  assert.equal(fetch.authCalls[0].fields.get('appid'), PHONE_LOGIN.appId);
  assert.equal(fetch.authCalls[0].fields.get('packagename'), PHONE_LOGIN.packageName);
  assert.equal(Object.hasOwn(client, 'channel'), false);
}

{
  const fetch = fakeFetch({ ewan: () => ({ status: 200, userAccountStatus: 1, userAccount: [], phone: account }) });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  await assert.rejects(() => client.loginWithSms(account, '123456'), /没有关联账号/);
}

{
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKeyBase64 = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const fetch = fakeFetch({
    ewan: () => ewanPayload,
    business: (call) => {
      if (call.url.pathname === '/api/public/info') {
        assert.equal(call.method, 'GET');
        assert.equal(call.url.searchParams.get('ai'), PHONE_LOGIN.business.appId);
        return { code: 0, data: { publicKey: publicKeyBase64, timestamp: fixedNow } };
      }
      if (call.url.pathname === '/api/init') {
        assert.equal(call.body.pn, PHONE_LOGIN.business.packageName);
        assert.equal(call.body.did, testDevice.businessDid);
        assert.equal(call.body.dc, testDevice.businessDeviceCode);
        assert.equal(typeof call.body.key, 'string');
        assert.ok(call.body.key.length > 40);
        return { code: 0, data: { initId: 'init-1', channel: { appKey: 'channel-key' } } };
      }
      if (call.url.pathname === '/api/user/login') {
        assert.equal(call.body.channel.uid, 'ewan-open-id');
        const ext = JSON.parse(call.body.channel.extJson);
        assert.equal(ext.username, 'tester');
        assert.equal(ext.token, 'ewan-token');
        assert.equal(ext.birthday, '20001013');
        return { code: 0, data: businessData };
      }
      throw new Error(`unexpected business request ${call.url}`);
    },
  });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const result = await client.loginWithPassword(account, password);
  const game = await client.gameLogin(result);
  assert.equal(game.business, true);
  assert.equal(game.uid, 'game-open-id');
  assert.equal(game.data.token, 'game-sign-token');
  const credential = client.credential(game, { account });
  assert.equal(credential.url, PHONE_LOGIN.gateway);
  assert.equal(credential.source, 'phone');
  assert.equal(credential.login.eworldParams.openId, 'game-open-id');
  assert.equal(credential.login.eworldParams.token, 'game-sign-token');
  assert.equal(credential.login.eworldParams.sign, 'game-sign');
  assert.deepEqual(credential.login.eworldParams.timestamp, {
    low: Number(BigInt(fixedNow) & 0xffffffffn) | 0,
    high: Number((BigInt(fixedNow) >> 32n) & 0xffffffffn) | 0,
    unsigned: false,
  });
  assert.equal(credential.login.language, 'zh_CN');
  assert.equal(credential.login.systemLanguage, 'zh_cn_#hans');
  assert.equal(credential.login.eworldClientInfo.appId, PHONE_LOGIN.business.appId);
  assert.equal(credential.login.eworldClientInfo.channelId, PHONE_LOGIN.business.channelId);
  assert.equal(credential.login.eworldClientInfo.did, testDevice.businessDid);
  assert.equal(credential.login.eworldClientInfo.clientVersion, '1.12.11');
  assert.equal(credential.login.eworldClientInfo.networkType, 'Wifi');
  assert.equal(credential.login.eworldClientInfo.sc, PHONE_LOGIN.packetId);
  assert.equal(credential.login.eworldClientInfo.extc, PHONE_LOGIN.packetId);
  assert.equal(credential.login.eworldClientInfo.biz, '102');
  assert.equal(credential.login.eworldClientInfo.birthday, '2000-10-13');
  assert.equal(credential.login.eworldClientInfo.originVersion, PHONE_LOGIN.clientVersion);
  assert.equal(JSON.stringify(credential).includes(password), false);
}

{
  const client = createPhoneLogin({ fetchImpl: async () => { throw new Error('offline'); }, now: () => fixedNow, device: testDevice });
  await assert.rejects(() => client.loginWithPassword(account, password), /登录服务连接失败/);
  await assert.rejects(() => client.loginWithSms(account, '123456'), /登录服务连接失败/);
}

{
  const config = PHONE_LOGIN;
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const publicKeyBase64 = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const clientKey = crypto.createHash('md5').update(testDevice.businessDid + fixedNow).digest('hex');
  const sorted = values => Object.keys(values).sort()
    .filter(key => typeof values[key] === 'number' || values[key])
    .map(key => `${key}=${encodeURIComponent(values[key])}`).join('&');
  const fetch = fakeFetch({ business: call => {
    assert.equal(call.headers.ai, config.business.appId);
    assert.equal(call.headers.pi, config.business.packetId);
    assert.equal(call.headers.ci, config.business.channelId);
    assert.equal(call.headers.cv, '100800');
    assert.equal(call.url.searchParams.get('bai'), String(config.business.bai));
    assert.equal(call.url.searchParams.get('bci'), String(config.business.bci));
    const query = Object.fromEntries(call.url.searchParams);
    const actualSign = query.sign;
    delete query.sign;
    const headers = Object.fromEntries(['ai', 'pi', 'ci', 'cv', 'pf'].map(key => [key, call.headers[key]]));
    const body = call.body ? JSON.stringify(call.body) : '';
    const signInput = `lyxpj^${sorted(headers)}@@${sorted(query)}@${body}&${clientKey}${config.business.signKey}`;
    assert.equal(actualSign, crypto.createHash('md5').update(signInput).digest('hex'));
    assert.equal(query.rpf, undefined);
    assert.equal(query.openId, undefined);
    assert.equal(query.initId, call.url.pathname === '/api/user/login' ? 'fixture-init' : undefined);
    if (call.url.pathname === '/api/public/info') return { code: 0, data: { publicKey: publicKeyBase64 } };
    if (call.url.pathname === '/api/init') {
      assert.equal(call.body.pn, config.packageName);
      assert.equal(call.body.appVersion, config.appVersion);
      return { code: 0, data: { initId: 'fixture-init', channel: { appId: config.appId, appKey: fixtureAppKey } } };
    }
    assert.equal(call.url.pathname, '/api/user/login');
    assert.equal(call.body.appVersion, config.appVersion);
    return { code: 0, data: businessData };
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const result = await client.loginWithPassword(account, password);
  const game = await client.gameLogin(result);
  const credential = client.credential(game, { account });
  assert.equal(credential.login.eworldClientInfo.appId, config.superAppId);
  assert.equal(credential.login.eworldClientInfo.channelId, config.channel);
  assert.equal(credential.login.eworldClientInfo.sc, config.packetId);
  assert.equal(credential.login.eworldClientInfo.extc, config.packetId);
  assert.equal(credential.login.eworldClientInfo.originVersion, config.clientVersion);
  assert.equal(credential.login.eworldClientInfo.clientVersion, config.gatewayClientVersion);
  assert.deepEqual(fetch.businessCalls.map(call => call.url.pathname), [
    '/api/public/info', '/api/init', '/api/user/login',
  ]);
  assert.deepEqual(fetch.calls.map(call => call.fields?.get('protocol') ?? call.url.pathname), [
    '/api/public/info', '/api/init', '400008', '100003', '/api/user/login',
  ]);
  const initCall = fetch.initCalls[0];
  assert.equal(initCall.options.headers.pi, config.packetId);
  assert.equal(initCall.options.headers.cv, config.sdkVersion);
  assert.equal(initCall.fields.get('appid'), config.appId);
  assert.equal(initCall.fields.get('superappid'), config.superAppId);
  assert.equal(initCall.fields.get('packetid'), config.packetId);
  assert.equal(initCall.fields.get('packagename'), config.packageName);
  for (const field of ['traceId', 'tt_channel_id', 'tt_channel_sdk_v']) assert.equal(initCall.fields.has(field), false);
  assert.equal(decryptBody(initCall.options.headers.oi, md5(fixtureAppKey).slice(8, 24)), '');
}

{
  const fetch = fakeFetch();
  const client = createPhoneLogin({ fetchImpl: fetch.impl, device: testDevice });
  const selected = { userName: 'tester', multiAccountToken: 'fixture-token' };
  await assert.rejects(() => client.loginWithPassword('', password), /不能为空/);
  await assert.rejects(() => client.loginWithPassword(account, ''), /不能为空/);
  await assert.rejects(() => client.requestSmsCode('invalid'), /手机号格式/);
  await assert.rejects(() => client.verifySmsAccounts(account, 'invalid'), /短信验证码/);
  await assert.rejects(() => client.verifySmsAccounts('invalid', '123456'), /手机号格式/);
  await assert.rejects(() => client.loginSmsAccount({ accounts: [] }, selected), /本次短信验证/);
  const missingToken = {};
  await assert.rejects(() => client.loginSmsAccount({ accounts: [missingToken] }, missingToken), /缺少短信登录凭证/);
  assert.equal(fetch.calls.length, 0, '输入校验失败不应发起初始化');
}

{
  // 四个入口并发共享首次初始化，游戏登录复用已经成功的业务初始化。
  const selected = { userName: 'tester', multiAccountToken: 'fixture-token' };
  const verified = { account, code: '123456', accounts: [selected] };
  const oaid = 'fixture-oaid-with-more-than-16-bytes';
  const fetch = fakeFetch({ ewan: ({ fields }) => (
    fields.get('protocol') === '420012' ? { status: 200, userAccount: [selected] } : ewanPayload
  ) });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, device: { ...testDevice, oi: encryptForm(oaid) } });
  const [passwordResult] = await Promise.all([
    client.loginWithPassword(account, password),
    client.requestSmsCode(account),
    client.verifySmsAccounts(account, '123456'),
    client.loginSmsAccount(verified, selected),
  ]);
  assert.equal(fetch.initCalls.length, 1);
  assert.equal(fetch.businessCalls.length, 2);
  assert.deepEqual(fetch.authCalls.map(call => call.fields.get('protocol')), ['100003', '100015', '420012', '420007']);
  assert.equal(decryptBody(fetch.initCalls[0].options.headers.oi, md5(fixtureAppKey).slice(8, 24)), oaid);
  assert.equal(fetch.calls[2], fetch.initCalls[0]);
  await Promise.all([client.gameLogin(passwordResult), client.gameLogin(passwordResult)]);
  assert.equal(fetch.initCalls.length, 1);
  assert.equal(fetch.businessCalls.filter(call => call.url.pathname === '/api/init').length, 1);
}

{
  let failInitialization = true;
  const selected = { userName: 'tester', multiAccountToken: 'fixture-token' };
  const verified = { account, code: '123456', accounts: [selected] };
  const fetch = fakeFetch({ init: () => failInitialization
    ? { status: -100, error: 9001, errorMsg: 'SDK 初始化暂不可用' }
    : { status: 200 } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, device: testDevice });
  const failures = await Promise.allSettled([
    client.loginWithPassword(account, password),
    client.requestSmsCode(account),
    client.verifySmsAccounts(account, '123456'),
    client.loginSmsAccount(verified, selected),
  ]);
  for (const failure of failures) {
    assert.equal(failure.status, 'rejected');
    assert.equal(failure.reason.code, 9001);
  }
  assert.equal(fetch.initCalls.length, 1);
  assert.equal(fetch.authCalls.length, 0, 'SDK 初始化失败不得发送账号或短信请求');
  failInitialization = false;
  await Promise.all([client.loginWithPassword(account, password), client.requestSmsCode(account)]);
  assert.equal(fetch.initCalls.length, 2, '失败的 SDK 初始化可以重试并合并并发');
  assert.equal(fetch.businessCalls.length, 2, 'SDK 重试沿用成功的业务初始化');
  assert.equal(fetch.authCalls.length, 2);
}

for (const failureStage of ['public-info', 'business-init', 'missing-app-key']) {
  let firstAttempt = true;
  const fetch = fakeFetch({ business: call => {
    const targetPath = failureStage === 'public-info' ? '/api/public/info' : '/api/init';
    if (firstAttempt && call.url.pathname === targetPath) {
      firstAttempt = false;
      return failureStage === 'missing-app-key'
        ? { code: 0, data: { initId: 'incomplete-init' } }
        : { code: 503, msg: '业务初始化暂不可用' };
    }
    return businessResponse(call);
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, device: testDevice });
  await assert.rejects(() => client.requestSmsCode(account), /初始化/);
  assert.equal(fetch.initCalls.length, 0);
  assert.equal(fetch.authCalls.length, 0);
  await client.requestSmsCode(account);
  assert.equal(fetch.initCalls.length, 1);
  assert.equal(fetch.authCalls.length, 1);
  assert.equal(fetch.businessCalls.filter(call => call.url.pathname === '/api/public/info').length, 2);
}

{
  const fetch = fakeFetch({ business: call => {
    const response = businessResponse(call);
    if (call.url.pathname === '/api/init') delete response.data.initId;
    return response;
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, device: testDevice });
  const result = await client.loginWithPassword(account, password);
  await client.gameLogin(result);
  assert.equal(fetch.businessCalls.filter(call => call.url.pathname === '/api/init').length, 1);
}

{
  const dynamicKey = '0123456789ABCDEF';
  const loginUrl = 'https://loginsdk.ewan.cn/updated-login';
  const accountUrl = 'https://duoaccountsdk.ewan.cn/updated-account';
  const oaid = 'fixture-imported-oaid';
  const fetch = fakeFetch({
    init: () => ({ status: 200, k: dynamicKey, loginurl: loginUrl, accounturl: accountUrl }),
    ewan: ({ url, fields, options }) => {
      assert.equal(url, fields.get('protocol') === '100015' ? accountUrl : loginUrl);
      assert.equal(decryptBody(options.headers.di, dynamicKey), testDevice.deviceCode);
      assert.equal(decryptBody(options.headers.oi, dynamicKey), oaid);
      return ewanPayload;
    },
  });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, device: { ...testDevice, oi: encryptForm(oaid) } });
  await client.loginWithPassword(account, password);
  await client.requestSmsCode(account);
  assert.equal(fetch.initCalls.length, 1);
}

for (const loginurl of ['https://ewan.cn.example.com/login', 'file:///login', 'https://user:password@loginsdk.ewan.cn/login', 'invalid']) {
  const fetch = fakeFetch({
    init: () => ({ status: 200, k: 'short-key', loginurl, accounturl: loginurl }),
    ewan: ({ url, fields }) => {
      assert.equal(url, fields.get('protocol') === '100015' ? PHONE_LOGIN.accountUrl : PHONE_LOGIN.loginUrl);
      return ewanPayload;
    },
  });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, device: testDevice });
  await client.loginWithPassword(account, password);
  await client.requestSmsCode(account);
}

{
  const explicitDi = encryptForm('fedcba9876543210');
  const fetch = fakeFetch();
  const client = createPhoneLogin({ fetchImpl: fetch.impl, device: { ...testDevice, di: explicitDi } });
  await client.loginWithPassword(account, password);
  assert.equal(fetch.authCalls[0].options.headers.di, explicitDi, 'SDK 密钥不变时保留显式导入的 di');
  const invalidOaidClient = createPhoneLogin({ fetchImpl: fetch.impl, device: { ...testDevice, oi: 'f0'.repeat(16) } });
  const requestCount = fetch.calls.length;
  await assert.rejects(() => invalidOaidClient.requestSmsCode(account), /oi 无法解密/);
  assert.equal(fetch.calls.length, requestCount);
}

for (const stage of ['sdk-init', 'auth']) {
  for (const duringBody of [false, true]) {
    const timeout = new DOMException('fixture SDK timed out', 'TimeoutError');
    const fetch = fakeFetch();
    const client = createPhoneLogin({ device: testDevice, fetchImpl: async (url, options) => {
      const target = stage === 'sdk-init' ? PHONE_LOGIN.initUrl : PHONE_LOGIN.loginUrl;
      if (!url.startsWith(target)) return fetch.impl(url, options);
      assert.ok(options.signal instanceof AbortSignal);
      if (!duringBody) throw timeout;
      return { status: 200, text: async () => { throw timeout; } };
    } });
    await assert.rejects(() => client.loginWithPassword(account, password), error => (
      error instanceof PhoneLoginError && error.cause === timeout && error.message === '登录服务响应超时，请稍后重试'
    ));
    assert.equal(fetch.authCalls.length, 0);
  }
}

for (const duringBody of [false, true]) {
  const timeout = new DOMException('fixture response timed out', 'TimeoutError');
  const client = createPhoneLogin({
    device: testDevice,
    fetchImpl: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      if (!duringBody) throw timeout;
      return {
        status: 200,
        text: async () => { throw timeout; },
        json: async () => { throw timeout; },
      };
    },
  });
  await assert.rejects(
    () => client.loginWithPassword(account, password),
    error => error instanceof PhoneLoginError && error.cause === timeout && error.message === '游戏登录服务响应超时，请稍后重试',
  );
  await assert.rejects(
    () => client.requestSmsCode(account),
    error => error instanceof PhoneLoginError && error.cause === timeout && /响应超时.*重试/.test(error.message),
  );
  await assert.rejects(
    () => client.gameLogin({ ewan: { openId: 'fixture-sdk-id', token: 'fixture-sdk-token' } }),
    error => error instanceof PhoneLoginError && error.cause === timeout && error.message === '游戏登录服务响应超时，请稍后重试',
  );
}

{
  const timeout = AbortSignal.timeout;
  let timedRequests = 0;
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 15000);
    timedRequests++;
    return timeout(1);
  };
  try {
    const client = createPhoneLogin({
      device: testDevice,
      fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('request did not abort')), 1000);
        signal.addEventListener('abort', () => {
          clearTimeout(deadline);
          reject(signal.reason);
        }, { once: true });
      }),
    });
    await assert.rejects(() => client.loginWithPassword(account, password), /登录服务响应超时，请稍后重试/);
    await assert.rejects(() => client.gameLogin({ ewan: { openId: 'fixture-sdk-id', token: 'fixture-sdk-token' } }), /游戏登录服务响应超时，请稍后重试/);
    assert.equal(timedRequests, 2);
  } finally {
    AbortSignal.timeout = timeout;
  }
}

{
  // 页面脚本是模板字符串；正则里的 \d 必须写成 [0-9]，否则运行时变成 d{9}。
  const { PAGE } = await import('../src/page.mjs');
  assert.equal(PAGE.includes('/^1[3-9][0-9]{9}$/'), true);
  assert.equal(PAGE.includes('/^1[3-9]d{9}$/'), false);
}

console.log('selftest-phone-login: ok');
