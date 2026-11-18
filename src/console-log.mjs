import { stripVTControlCharacters } from 'node:util';
import { redactText } from './trace-log.mjs';
import { LOG_CATEGORIES, classifyLog } from './log-categories.mjs';

const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const levels = new Map([
  ['info', '信息'], ['warn', '警告'], ['error', '错误'], ['state', '状态'],
]);

function plainText(value) {
  const withoutOsc = redactText(String(value ?? '')).replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, '');
  return stripVTControlCharacters(withoutOsc)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

// 只输出业务正文和公开的账号名称、分类、等级；原始详情与 extra 不进入终端。
export function formatConsoleLog(entry) {
  const date = new Date(entry?.t ?? Date.now());
  const time = Number.isNaN(date.getTime()) ? '--:--:--' : clock.format(date);
  const account = entry?.account
    ? plainText(entry.accountName).replace(/\n/g, '') || plainText(entry.account).replace(/\n/g, '').slice(0, 8) || '未命名账号'
    : '系统';
  const category = Object.hasOwn(LOG_CATEGORIES, entry?.category) ? entry.category : classifyLog(entry?.message);
  const operation = entry?.operationId ? ` [操作 ${plainText(entry.operationId).replace(/\n/g, '')}]` : '';
  const prefix = `[${time}] [${account}] [${LOG_CATEGORIES[category]}] [${levels.get(entry?.level) ?? '信息'}]${operation} `;
  return plainText(entry?.message).split('\n').map(line => prefix + line).join('\n');
}
