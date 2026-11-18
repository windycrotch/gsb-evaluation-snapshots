import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './accounts.mjs';
import { atomicJson, withFileLock } from './json-store.mjs';

// 手机号/账号密码登录实际走益世界 ewan 账号 SDK：
//   http://loginsdk.ewan.cn/login      账号密码
//   http://duoaccountsdk.ewan.cn/account 短信验证码等账号动作
// 请求体是 URL 编码表单，再做 AES-128-ECB/PKCS7，密钥来自 SDK 字符串。
// 响应同样是 AES 密文，解密后是 JSON。
export const PHONE_LOGIN = {
  initUrl: 'https://duoinitsdk.ewan.cn/weplay',
  loginUrl: 'http://loginsdk.ewan.cn/login',
  accountUrl: 'http://duoaccountsdk.ewan.cn/account',
  gateway: 'wss://dhyaoj-gate.khlgamen.com:443/ws',
  businessBase: 'https://api.gzxianc.com',
  business: {
    appId: '14021102',
    packetId: '50001883',
    channelId: '17001784',
    signKey: '38F569705009ac46',
    bai: 14021102,
    bci: 17001784,
    sst: 1,
    appVersion: '1.9.5',
    clientVersion: '1.9.4.434',
    packageName: 'com.gx.sw.qa.fkssj003.esj',
    appName: '疯狂水世界',
    sdkVersion: '100800',
  },
  aesKey: 'cwQ52wanEJkW56Xc',
  appId: '56000002',
  superAppId: '14021102',
  channel: '17001784',
  packetId: '259237',
  appVersion: '1.9.5',
  appVersionCode: '444',
  clientVersion: '1.9.4.434',
  packageName: 'com.gx.sw.qa.fkssj003.esj',
  appName: '疯狂水世界',
  deviceModel: 'vivo V2284A',
  sdkVersion: '6620',
  pluginVersion: '354',
  gatewayPlatform: '1',
  gatewayClientVersion: '1.12.11',
};

export const DEVICE_PROFILE_PATH = path.join(DATA_DIR, 'ewan-device.json');

// model 使用 Android 型号标识，系统版本与机型成对选择；仅用于新设备。
// 型号来源：https://storage.googleapis.com/play_public/supported_devices.html
export const DEVICE_PRESETS = Object.freeze([
  { model: 'V2144', sysVersion: '12' }, // vivo X80
  { model: 'V2218', sysVersion: '13' }, // vivo X90
  { model: '2211133G', sysVersion: '13' }, // Xiaomi 13
  { model: 'CPH2307', sysVersion: '12' }, // OPPO Find X5
  { model: 'CPH2305', sysVersion: '12' }, // OPPO Find X5 Pro
  { model: 'SM-S911B', sysVersion: '13' }, // Samsung Galaxy S23
  { model: 'Pixel 6', sysVersion: '12' },
  { model: 'Pixel 7', sysVersion: '13' },
].map(preset => Object.freeze(preset)));

// SDK 把 Android ID 和 OAID 分别用当前 API 的 AES 密钥加密，得到 di / oi。
// 登录接口使用 PHONE_LOGIN.aesKey。模拟 Android ID 必须持久化并跨请求复用。
export function loadDeviceProfile(file = process.env.CW_EWAN_DEVICE || DEVICE_PROFILE_PATH) {
  try {
    return normalizeDeviceProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function normalizeDeviceProfile(profile) {
  if (typeof profile?.di !== 'string' || !/^[0-9a-f]{64}$/i.test(profile.di)) {
    throw new Error('设备档案 di 必须是 64 位十六进制');
  }
  const di = profile.di.toLowerCase();
  const oi = profile.oi ?? encryptForm('');
  if (typeof oi !== 'string' || !/^(?:[0-9a-f]{32})+$/i.test(oi)) {
    throw new Error('设备档案 oi 必须是长度为 32 倍数的十六进制密文，也可以省略以使用空 OAID');
  }
  if (typeof profile.deviceCode !== 'string' || !/^[0-9a-f]{16}$/i.test(profile.deviceCode)) {
    throw new Error('设备档案 deviceCode 必须是 16 位十六进制');
  }
  return {
    di,
    oi: oi.toLowerCase(),
    deviceCode: profile.deviceCode.toLowerCase(),
    businessDid: String(profile.businessDid ?? profile.business_did ?? ''),
    businessDeviceCode: String(profile.businessDeviceCode ?? profile.business_devicecode ?? ''),
    model: String(profile.model || PHONE_LOGIN.deviceModel),
    sysVersion: String(profile.sysVersion || '12'),
    traceId: profile.traceId ? String(profile.traceId) : null,
    source: profile.source === 'generated' ? 'generated' : 'imported',
  };
}

function completeDeviceProfile(profile, randomBytes = crypto.randomBytes) {
  return {
    ...profile,
    businessDid: profile.businessDid || randomBytes(16).toString('hex').toUpperCase(),
    businessDeviceCode: profile.businessDeviceCode || profile.deviceCode,
  };
}

function generateDeviceProfile(randomBytes) {
  const deviceCode = randomBytes(8).toString('hex');
  const preset = DEVICE_PRESETS[randomBytes(1)[0] % DEVICE_PRESETS.length];
  return completeDeviceProfile(normalizeDeviceProfile({
    ...preset,
    di: encryptForm(deviceCode),
    deviceCode,
    source: 'generated',
  }), randomBytes);
}

export function ensureDeviceProfile({
  file = process.env.CW_EWAN_DEVICE || DEVICE_PROFILE_PATH,
  randomBytes = crypto.randomBytes,
} = {}) {
  return withFileLock(file, () => {
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error('设备档案无法读取，请修复文件或在登录页重新导入', { cause: error });
      }
      const generated = generateDeviceProfile(randomBytes);
      atomicJson(file, generated);
      return generated;
    }
    let profile;
    try {
      profile = completeDeviceProfile(normalizeDeviceProfile(stored), randomBytes);
    } catch (error) {
      throw new Error('设备档案格式无效，请修复文件或在登录页重新导入', { cause: error });
    }
    if (profile.source === 'generated') {
      // 修复旧版本随机填充的密文，同时沿用已经保存的 Android ID 和业务身份。
      profile.di = encryptForm(profile.deviceCode);
      profile.oi = encryptForm('');
    }
    if (!stored.businessDid || !stored.businessDeviceCode || stored.source !== profile.source
      || stored.di !== profile.di || stored.oi !== profile.oi) {
      atomicJson(file, profile);
    }
    return profile;
  });
}

export function saveDeviceProfile(profile, file = process.env.CW_EWAN_DEVICE || DEVICE_PROFILE_PATH) {
  const normalized = normalizeDeviceProfile(profile);
  return withFileLock(file, () => {
    const data = completeDeviceProfile({ ...normalized, source: 'imported' });
    atomicJson(file, data);
    return data;
  });
}

export class PhoneLoginError extends Error {
  constructor(message, { code = null, status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PhoneLoginError';
    this.code = code;
    this.status = status;
  }
}

const md5 = (text) => crypto.createHash('md5').update(text, 'utf8').digest('hex');

function sortedQuery(values) {
  return Object.keys(values).sort()
    .filter((key) => typeof values[key] === 'number' || values[key])
    .map((key) => `${key}=${encodeURIComponent(values[key])}`)
    .join('&');
}

function businessSign(initKey, clientKey, body, query, header) {
  const bodyText = body === '{}' ? '' : body;
  return md5(`lyxpj^${sortedQuery(header)}@@${sortedQuery(query)}@${bodyText}&${clientKey}${initKey}`);
}

function assertBusinessOk(payload, fallback) {
  if (payload && typeof payload === 'object' && payload.code === 0) return payload.data;
  const suffix = payload?.meta?.tid ? `（${payload.meta.tid}）` : '';
  throw new PhoneLoginError(`${payload?.msg || fallback}${suffix}`, { code: payload?.code ?? null });
}

function toLong(value) {
  const number = BigInt(value);
  return {
    low: Number(number & 0xffffffffn) | 0,
    high: Number((number >> 32n) & 0xffffffffn) | 0,
    unsigned: false,
  };
}

function birthdayText(value) {
  const text = String(value ?? '').trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function pick(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

export function encryptForm(text, key = PHONE_LOGIN.aesKey) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]).toString('hex');
}

export function decryptBody(hex, key = PHONE_LOGIN.aesKey) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8');
}

export function createPhoneLogin({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  randomBytes = (size) => crypto.randomBytes(size),
  device: suppliedDevice = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 没有可用的 fetch');

  const profile = suppliedDevice ?? ensureDeviceProfile({ randomBytes });
  const deviceCode = profile.deviceCode || randomBytes(8).toString('hex');
  const di = profile.di || encryptForm(deviceCode, PHONE_LOGIN.aesKey);
  const device = {
    di,
    oi: profile.oi || encryptForm('', PHONE_LOGIN.aesKey),
    deviceCode,
    model: profile.model || PHONE_LOGIN.deviceModel,
    sysVersion: profile.sysVersion || '12',
    businessDid: profile.businessDid || randomBytes(16).toString('hex').toUpperCase(),
    businessDeviceCode: profile.businessDeviceCode || deviceCode,
  };
  device.clientSignKey = md5(device.businessDid + now());
  device.initId = '';
  device.channel = null;
  const sdk = {
    key: PHONE_LOGIN.aesKey,
    loginUrl: PHONE_LOGIN.loginUrl,
    accountUrl: PHONE_LOGIN.accountUrl,
    di: device.di,
    oi: device.oi,
  };
  let businessInitPromise = null;
  let sdkInitPromise = null;

  function baseFields() {
    return {
      appid: PHONE_LOGIN.appId,
      appname: PHONE_LOGIN.appName,
      appserverid: '0',
      appversion: PHONE_LOGIN.appVersion,
      appversioncode: PHONE_LOGIN.appVersionCode,
      apv: '2',
      channel: PHONE_LOGIN.channel,
      companyType: '0',
      cursubvc: PHONE_LOGIN.pluginVersion,
      curvc: PHONE_LOGIN.sdkVersion,
      devicecode: device.deviceCode,
      ewappdevicekey: '',
      fcm: '1',
      hostsubvc: PHONE_LOGIN.pluginVersion,
      hostvc: PHONE_LOGIN.sdkVersion,
      imei: '0',
      imsi: '',
      iosflag: '0',
      language: '2',
      linkid: '',
      mac: '',
      model: device.model,
      oaid: '',
      packagename: PHONE_LOGIN.packageName,
      packetid: PHONE_LOGIN.packetId,
      plat: '1',
      pluginvc: PHONE_LOGIN.pluginVersion,
      sdkflag: '0',
      sdkmode: '0',
      sdkversionid: PHONE_LOGIN.sdkVersion,
      superappid: PHONE_LOGIN.superAppId,
      sysversion: device.sysVersion,
      targetsdkversion: '30',
      userpoint: '0',
    };
  }

  function form(fields) {
    return new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, value ?? ''])).toString();
  }

  async function request(url, fields, { key = sdk.key, headers = {} } = {}) {
    const body = form(fields);
    const signal = AbortSignal.timeout(15000);
    let response;
    let text;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Charset: 'UTF-8',
          'User-Agent': `Dalvik/2.1.0 (Linux; U; Android ${device.sysVersion}; ${device.model} Build/282d228.0) CWAndroidSDK`,
          ai: PHONE_LOGIN.appId,
          pi: PHONE_LOGIN.packetId,
          cv: PHONE_LOGIN.sdkVersion,
          di: sdk.di,
          oi: sdk.oi,
          pf: '1',
          rdt: '',
          ...headers,
        },
        body: encryptForm(body, key),
      });
      text = await response.text();
    } catch (error) {
      if (signal.aborted || error.name === 'TimeoutError') {
        throw new PhoneLoginError('登录服务响应超时，请稍后重试', { cause: error });
      }
      throw new PhoneLoginError(`登录服务连接失败：${error.message}`, { cause: error });
    }
    let payload;
    try {
      payload = JSON.parse(decryptBody(text, key));
    } catch (error) {
      throw new PhoneLoginError(`登录响应无法解密（HTTP ${response.status}）`, { cause: error });
    }
    if (payload?.status !== 200 || payload?.error) {
      let message = payload?.errorMsg || payload?.msg || `登录失败（status=${payload?.status ?? '?'}）`;
      if (fields.protocol === '100003') {
        message += '。请核对账号信息，并确认游戏 APP 中可以正常登录。';
      }
      throw new PhoneLoginError(message, { code: payload?.error ?? null, status: payload?.status ?? null });
    }
    return payload;
  }

  function extract(payload) {
    const data = payload?.data && typeof payload.data === 'object'
      ? { ...payload.data, ...payload }
      : (payload ?? {});
    const openId = pick(data, ['openId', 'openid', 'open_id', 'channelUid', 'channeluid', 'userId', 'userid']);
    const token = pick(data, ['token', 'signToken', 'sign_token', 'sessiontoken', 'sessionId', 'sessionid', 'accessToken']);
    const sign = pick(data, ['sign', 'signature']);
    const timestamp = pick(data, ['timestamp', 'ts', 'time', 'signTime']);
    return {
      openId: openId === null ? null : String(openId),
      token: token === null ? null : String(token),
      sign: sign === null ? null : String(sign),
      timestamp: timestamp === null ? null : timestamp,
      userName: pick(data, ['username', 'userName', 'account']),
      areaId: pick(data, ['areaId', 'areaid', 'zoneId', 'zoneid']),
      raw: data,
    };
  }

  async function loginWithPassword(account, password) {
    if (!account || !password) throw new PhoneLoginError('手机号/账号和密码都不能为空');
    await ensureSdkInitialized();
    const payload = await request(sdk.loginUrl, {
      ...baseFields(),
      protocol: '100003',
      username: String(account),
      password: String(password),
    });
    const ewan = extract(payload);
    return {
      ucCode: 'ewan',
      account,
      accounts: [],
      session: payload,
      userInfo: payload,
      ewan,
      direct: Boolean(ewan.openId && ewan.token && ewan.sign && ewan.timestamp),
    };
  }

  async function requestSmsCode(phone) {
    const number = String(phone ?? '').trim();
    if (!/^1[3-9]\d{9}$/.test(number)) throw new PhoneLoginError('手机号格式不正确');
    await ensureSdkInitialized();
    const payload = await request(sdk.accountUrl, {
      ...baseFields(),
      protocol: '100015',
      phone: number,
      type: '7',
      userid: '0',
      username: '',
      sessionid: '',
    });
    return payload;
  }

  async function verifySmsAccounts(phone, code) {
    const number = String(phone ?? '').trim();
    const vcode = String(code ?? '').trim();
    if (!/^1[3-9]\d{9}$/.test(number)) throw new PhoneLoginError('手机号格式不正确');
    if (!/^\d{4,8}$/.test(vcode)) throw new PhoneLoginError('请输入短信验证码');
    await ensureSdkInitialized();

    // 420012 只校验验证码并返回手机号关联的账号列表，不是最终登录。
    const checked = await request(sdk.loginUrl, {
      ...baseFields(),
      protocol: '420012',
      phone: number,
      querytype: '1',
      queryvalue: vcode,
      resolution: '720*1280',
    });
    const accounts = Array.isArray(checked?.userAccount) ? checked.userAccount : [];
    if (!accounts.length) throw new PhoneLoginError('验证码校验成功，但这个手机号没有关联账号');
    return { account: number, code: vcode, accounts };
  }

  async function loginSmsAccount(verified, selected) {
    if (!Array.isArray(verified?.accounts) || !verified.accounts.includes(selected)) {
      throw new PhoneLoginError('请选择本次短信验证返回的 APP 账号');
    }
    const { account: number, code: vcode, accounts } = verified;
    const multiAccountToken = selected?.multiAccountToken;
    if (!multiAccountToken) throw new PhoneLoginError('此 APP 账号缺少短信登录凭证，请重新获取验证码后重试');
    await ensureSdkInitialized();

    // 420007 用 multiAccountToken 完成最终登录。
    const payload = await request(sdk.loginUrl, {
      ...baseFields(),
      protocol: '420007',
      phone: number,
      multiAccountToken,
      validatecode: vcode,
      resolution: '720*1280',
    });
    const ewan = extract(payload);
    return {
      ucCode: 'ewan',
      account: number,
      accounts,
      selectedAccount: selected,
      session: payload,
      userInfo: payload,
      ewan,
      direct: Boolean(ewan.openId && ewan.token && ewan.sign && ewan.timestamp),
    };
  }

  async function loginWithSms(phone, code) {
    const verified = await verifySmsAccounts(phone, code);
    return loginSmsAccount(verified, verified.accounts[0]);
  }

  function candidateUids(result) {
    const values = [result?.ewan?.openId, result?.ewan?.userName, result?.account];
    return [...new Set(values.filter(Boolean).map(String))];
  }

  async function businessRequest(path, { method = 'POST', body = {}, queryExtra = {} } = {}) {
    const config = PHONE_LOGIN.business;
    const nonce = `1${randomBytes(4).toString('hex')}`;
    const query = {
      sign: '',
      ts: now().toString(),
      nonce,
      reqId: nonce,
      apiVersion: 200,
      bai: config.bai,
      bci: config.bci,
      did: device.businessDid,
      dc: device.businessDeviceCode,
      sst: config.sst,
      ...queryExtra,
    };
    if (device.initId) query.initId = device.initId;
    const header = {
      ai: config.appId,
      pi: config.packetId,
      ci: config.channelId,
      cv: config.sdkVersion,
      fv: '',
      token: '',
      pf: '1',
    };
    for (const key of Object.keys(header)) if (!header[key]) delete header[key];
    const bodyText = JSON.stringify(body);
    query.sign = businessSign(config.signKey, device.clientSignKey, bodyText, query, header);
    const url = `${PHONE_LOGIN.businessBase}/api${path}?${sortedQuery(query)}`;
    const signal = AbortSignal.timeout(15000);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        signal,
        headers: { 'content-type': 'application/json;charset=utf-8', ...header },
        body: method === 'GET' ? undefined : bodyText,
      });
    } catch (error) {
      if (signal.aborted || error.name === 'TimeoutError') {
        throw new PhoneLoginError('游戏登录服务响应超时，请稍后重试', { cause: error });
      }
      throw new PhoneLoginError(`游戏登录服务连接失败：${error.message}`, { cause: error });
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal.aborted || error.name === 'TimeoutError') {
        throw new PhoneLoginError('游戏登录服务响应超时，请稍后重试', { cause: error });
      }
      throw new PhoneLoginError(`游戏登录服务返回了无法解析的内容（HTTP ${response.status}）`, { cause: error });
    }
    return assertBusinessOk(payload, `游戏登录服务请求失败（HTTP ${response.status}）`);
  }

  function businessInit() {
    if (!businessInitPromise) {
      businessInitPromise = initializeBusiness().catch((error) => {
        businessInitPromise = null;
        throw error;
      });
    }
    return businessInitPromise;
  }

  async function initializeBusiness() {
    const config = PHONE_LOGIN.business;
    const publicInfo = await businessRequest('/public/info', {
      method: 'GET',
      queryExtra: { did: device.businessDid, ai: config.appId, pi: config.packetId, ci: config.channelId, pf: '1' },
    });
    if (!publicInfo?.publicKey) throw new PhoneLoginError('游戏登录服务没有返回公钥');
    const key = crypto.publicEncrypt(
      {
        key: `-----BEGIN PUBLIC KEY-----\n${publicInfo.publicKey.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(device.clientSignKey, 'utf8'),
    ).toString('base64');
    const init = await businessRequest('/init', {
      body: {
        did: device.businessDid,
        dc: device.businessDeviceCode,
        nm: 'wifi',
        sv: device.sysVersion,
        svc: '',
        pm: device.model,
        lang: 'zh',
        tz: '+8',
        dn: '',
        sd: '320',
        sh: '1280',
        sw: '720',
        pn: config.packageName,
        appVersion: config.appVersion,
        privacyVersion: 100,
        key,
        activation: 1,
        appName: config.appName,
      },
    });
    if (typeof init?.channel?.appKey !== 'string' || !init.channel.appKey.trim()) {
      throw new PhoneLoginError('游戏初始化没有返回账号 SDK 密钥，请稍后重试');
    }
    device.initId = init?.initId ?? '';
    device.channel = init?.channel ?? null;
    return init;
  }

  function sdkUrl(value, fallback) {
    if (typeof value !== 'string') return fallback;
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol)
        && (url.hostname === 'ewan.cn' || url.hostname.endsWith('.ewan.cn'))
        && !url.username && !url.password) return url.href;
    } catch {}
    return fallback;
  }

  function ensureSdkInitialized() {
    if (!sdkInitPromise) {
      sdkInitPromise = initializeSdk().catch((error) => {
        sdkInitPromise = null;
        throw error;
      });
    }
    return sdkInitPromise;
  }

  async function initializeSdk() {
    let oaid;
    try {
      oaid = decryptBody(device.oi, PHONE_LOGIN.aesKey);
    } catch (error) {
      throw new PhoneLoginError('设备档案 oi 无法解密，请重新导入设备档案', { cause: error });
    }
    const init = await businessInit();
    const initKey = md5(init.channel.appKey).slice(8, 24);
    const fields = baseFields();
    delete fields.appserverid;
    delete fields.userpoint;
    fields.protocol = '400008';
    fields.sign = md5(`${PHONE_LOGIN.appId}|${init.channel.appKey}`);
    const initialized = await request(`${PHONE_LOGIN.initUrl}?requestid=${PHONE_LOGIN.appId}`, fields, {
      key: initKey,
      headers: {
        di: encryptForm(device.deviceCode, initKey),
        oi: encryptForm(oaid, initKey),
      },
    });
    if (typeof initialized.k === 'string' && Buffer.byteLength(initialized.k, 'utf8') === 16) {
      sdk.key = initialized.k;
    }
    sdk.loginUrl = sdkUrl(initialized.loginurl, PHONE_LOGIN.loginUrl);
    sdk.accountUrl = sdkUrl(initialized.accounturl, PHONE_LOGIN.accountUrl);
    if (sdk.key !== PHONE_LOGIN.aesKey) {
      sdk.di = encryptForm(device.deviceCode, sdk.key);
      sdk.oi = encryptForm(oaid, sdk.key);
    }
  }

  async function businessLogin(ewan) {
    const config = PHONE_LOGIN.business;
    const raw = ewan.raw ?? {};
    const extJson = JSON.stringify({
      username: ewan.userName ?? raw.username ?? '',
      timestamp: 0,
      token: String(ewan.token),
      isAuth: true,
      birthday: raw.birthday ?? null,
    });
    return businessRequest('/user/login', {
      body: {
        appVersion: config.appVersion,
        channel: { uid: String(ewan.openId), extJson },
        phoneModel: device.model,
        registrationId: '',
        sysVersion: device.sysVersion,
      },
    });
  }

  async function gameLogin(result) {
    const ewan = result?.ewan ?? extract(result?.session);
    if (!ewan.openId || !ewan.token) {
      const raw = ewan.raw ?? {};
      const keys = Object.keys(raw).sort().join(', ');
      const summary = {};
      for (const key of ['status', 'phone', 'userAccount', 'userAccountStatus', 'userId', 'username', 'error', 'errorMsg']) {
        if (raw[key] !== undefined) summary[key] = raw[key];
      }
      const detail = Object.keys(summary).length ? `；响应: ${JSON.stringify(summary).slice(0, 500)}` : '';
      throw new PhoneLoginError(`登录响应没有完整游戏凭证（字段: ${keys || '空'}${detail}）`);
    }
    await businessInit();
    const business = await businessLogin(ewan);
    const data = {
      openId: business?.openId,
      token: business?.signToken || business?.token,
      sign: business?.sign,
      ts: business?.ts,
    };
    if (!data.openId || !data.token || !data.sign || data.ts === undefined || data.ts === null) {
      throw new PhoneLoginError('游戏业务登录返回的凭证字段不完整');
    }
    return {
      direct: false,
      business: true,
      did: device.businessDid,
      uid: data.openId,
      data,
      realName: business?.realName ?? null,
      ewan,
      attempts: [],
    };
  }

  function credential(game, { account = null } = {}) {
    const data = game.data;
    if (!data?.openId || !data?.token || !data?.sign || data?.ts === undefined || data?.ts === null) {
      throw new PhoneLoginError('登录返回的游戏凭证字段不完整');
    }
    const timestamp = Number(data.ts) < 1e12 ? Number(data.ts) * 1000 : Number(data.ts);
    const birthday = birthdayText(game.realName?.birthday) ?? birthdayText(game.ewan?.raw?.birthday);
    return {
      url: PHONE_LOGIN.gateway,
      login: {
        language: 'zh_CN',
        eworldParams: {
          openId: data.openId,
          token: String(data.token),
          timestamp: toLong(timestamp),
          sign: data.sign,
        },
        eworldClientInfo: {
          appId: PHONE_LOGIN.superAppId,
          channelId: PHONE_LOGIN.channel,
          clientVersion: PHONE_LOGIN.gatewayClientVersion,
          networkType: 'Wifi',
          platform: PHONE_LOGIN.gatewayPlatform,
          did: game.did,
          sc: PHONE_LOGIN.packetId,
          extc: PHONE_LOGIN.packetId,
          biz: '102',
          isAuth: true,
          birthday,
          originVersion: PHONE_LOGIN.clientVersion,
        },
        worldId: toLong(0),
        systemLanguage: 'zh_cn_#hans',
      },
      source: 'phone',
      capturedAt: new Date(now()).toISOString(),
      phoneAccount: account,
    };
  }

  return {
    device,
    loginWithPassword,
    loginWithSms,
    verifySmsAccounts,
    loginSmsAccount,
    requestSmsCode,
    candidateUids,
    gameLogin,
    credential,
    mask(text) {
      const value = String(text ?? '');
      if (value.length <= 4) return '*'.repeat(value.length);
      return `${value.slice(0, 2)}${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
    },
  };
}

// 保留导出，便于单独验证密钥和密文。
export { md5 };
