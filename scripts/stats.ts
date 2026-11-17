/**
 * Funnel and breakdowns from Workers Analytics Engine.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run stats -- [hours=24] [dev]
 *
 * The token needs the Account → Account Analytics → Read permission.
 * Field layout: see worker/index.ts.
 */
export {};

const [hoursArg = '24', envArg] = process.argv.slice(2);
const hours = Number(hoursArg);
const dataset = envArg === 'dev' ? 'pjt_events_dev' : 'pjt_events';
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
if (!account || !token) {
  console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
  process.exit(1);
}

type Row = Record<string, string | number>;

async function sql(query: string): Promise<Row[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: `${query} FORMAT JSON`,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return ((await res.json()) as { data: Row[] }).data;
}

const where = `timestamp > NOW() - INTERVAL '${hours}' HOUR`;
// _sample_interval: Analytics Engine may sample under heavy load; weighting by it keeps counts accurate.
const count = 'SUM(_sample_interval)';

const byEvent = await sql(`SELECT blob1 AS event, ${count} AS n FROM ${dataset} WHERE ${where} GROUP BY event`);
const n = (e: string) => Number(byEvent.find((r) => r.event === e)?.n ?? 0);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

console.log(`\n${dataset}, last ${hours} h\n`);
console.log('Funnel');
const steps: [string, string][] = [
  ['view', 'visited'],
  ['render_start', 'tapped “Make the video”'],
  ['render_done', 'got a video'],
  ['share_click', 'tapped “Send”'],
];
steps.forEach(([e, label], i) => {
  const prev = i ? n(steps[i - 1]![0]) : 0;
  console.log(`  ${label.padEnd(26)} ${String(n(e)).padStart(7)}  ${i ? pct(n(e), prev) : ''}`);
});
console.log(`  render errors ${String(n('render_fail')).padStart(19)}`);
console.log(`  hit grandpa limit ${String(n('limit_hit')).padStart(15)}`);
console.log(`  tapped “Why?” ${String(n('why_click')).padStart(19)}`);

const table = async (title: string, q: string) => {
  const rows = await sql(q);
  console.log(`\n${title}`);
  for (const r of rows) console.log('  ' + Object.values(r).map((v) => String(v).padEnd(12)).join(''));
  if (!rows.length) console.log('  —');
};

await table(
  'Modes: videos / shares',
  `SELECT blob2 AS mode, SUM(IF(blob1 = 'render_done', _sample_interval, 0)) AS videos,
          SUM(IF(blob1 = 'share_click', _sample_interval, 0)) AS shares
   FROM ${dataset} WHERE ${where} AND blob1 IN ('render_done', 'share_click') GROUP BY mode ORDER BY videos DESC`,
);
await table(
  '“Send” result',
  `SELECT blob7 AS result, ${count} AS n FROM ${dataset} WHERE ${where} AND blob1 = 'share_result' GROUP BY result ORDER BY n DESC`,
);
await table(
  'Countries (visits), top 15',
  `SELECT blob4 AS country, ${count} AS n FROM ${dataset} WHERE ${where} AND blob1 = 'view' GROUP BY country ORDER BY n DESC LIMIT 15`,
);
await table(
  'Languages (visits)',
  `SELECT blob3 AS lang, ${count} AS n FROM ${dataset} WHERE ${where} AND blob1 = 'view' GROUP BY lang ORDER BY n DESC`,
);
await table(
  'Platform / browser: visits, videos, errors, median render (ms)',
  `SELECT blob5 AS platform, blob6 AS browser,
          SUM(IF(blob1 = 'view', _sample_interval, 0)) AS views,
          SUM(IF(blob1 = 'render_done', _sample_interval, 0)) AS videos,
          SUM(IF(blob1 = 'render_fail', _sample_interval, 0)) AS fails,
          quantileWeighted(0.5)(IF(blob1 = 'render_done', double2, NULL), _sample_interval) AS render_ms
   FROM ${dataset} WHERE ${where} GROUP BY platform, browser ORDER BY views DESC LIMIT 20`,
);
