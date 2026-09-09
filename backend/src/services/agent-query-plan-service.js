import { extractQueryBusinessIds, hasUnsupportedQueryTimeFilter } from './agent-query-service.js';

const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const iso = (time) => new Date(time).toISOString();
const parseDay = (year, month, day) => {
  const value = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(value);
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day) ? value - OFFSET : NaN;
};
const instantPattern = /^(20\d{2})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
export function validQueryInstant(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(instantPattern);
  return Boolean(match && Number.isFinite(parseDay(match[1], match[2], match[3])) && Number.isFinite(Date.parse(value)));
}

// A bounded query language, never LLM-generated SQL. As-of requires a
// separately attested valid-time contract from the source connector.
// occurredAt means event occurrence; it never means validity at that instant.
export function buildAgentQueryPlan(input, nowAt = Date.now()) {
  let prose = String(input).replace(/\b[A-Z][A-Z0-9_]*(?:-[A-Z0-9_]+)+\b/giu, '');
  const plan = { schemaVersion: 'agent-query-plan.v1', businessIds: extractQueryBusinessIds(input), timeZone: 'Asia/Shanghai', timeRange: null, version: null, asOf: null, status: 'ready', semantics: 'event_occurrence_not_historical_snapshot' };
  const reject = (reason) => ({ ...plan, status: 'needs_input', reason });
  const snapshot = prose.match(/(?:截至|历史快照|\bas\s+of)\s*(20\d{2}-\d{2}-\d{2}T[^\s，。；？?\u4e00-\u9fff]+)/iu);
  if (snapshot) {
    if (!validQueryInstant(snapshot[1]) || Date.parse(snapshot[1]) > nowAt) return reject('历史快照需要有效且不晚于现在的 ISO 时间，必须包含时区。');
    plan.asOf = iso(Date.parse(snapshot[1]));
    plan.semantics = 'source_attested_valid_time_snapshot';
    prose = prose.replace(snapshot[0], '');
  }
  if (/截至|当时|历史快照|之前|之后|以前|以后|最新|最近(?!\s*\d)|\bas\s+of\b|\blatest\b/iu.test(prose)) return reject('历史快照请提供含时区的完整 ISO 时点；尚不支持跨来源最新版本判断。也可指定事件日期或明确版本。');
  const versions = [...prose.matchAll(/(?:版本\s*[:：]?\s*|\bversion\s*[:：]?\s+)([A-Za-z0-9][A-Za-z0-9._-]{0,63})/giu)];
  if (versions.length > 1) return reject('一次只能筛选一个明确版本。');
  if (versions.length) { plan.version = versions[0][1]; prose = prose.replace(versions[0][0], ''); }
  if (/版本|\bversion\b/iu.test(prose)) return reject('请提供明确的来源版本号，例如“版本 v2”。');
  const dates = [...prose.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g)];
  const relative = prose.match(/(?:今天|昨天|前天|today|yesterday|(?:最近|过去|近|last)\s*(\d+)\s*(?:天|days))/iu);
  if (dates.length && relative || dates.length > 2) return reject('时间条件有歧义，请保留一个日期或一个连续日期区间。');
  if (dates.length) {
    const days = dates.map((match) => parseDay(match[1], match[2], match[3]));
    if (days.some((value) => !Number.isFinite(value)) || days[days.length - 1] < days[0]) return reject('日期无效或区间起止顺序错误。');
    if (dates.length === 2 && !/^(?:\s*(?:至|到|~|～|—|–|to)\s*)$/iu.test(prose.slice(dates[0].index + dates[0][0].length, dates[1].index))) return reject('多个日期请用“至”连接，明确是否为连续区间。');
    plan.timeRange = { field: 'occurredAt', from: iso(days[0]), toExclusive: iso(days[days.length - 1] + DAY) };
    for (const match of dates) prose = prose.replace(match[0], '');
  } else if (relative) {
    const today = Math.floor((nowAt + OFFSET) / DAY) * DAY - OFFSET;
    const days = relative[1] ? Number(relative[1]) : 1;
    if (days < 1 || days > 366) return reject('相对日期范围必须为 1 至 366 天。');
    const offset = /前天/.test(relative[0]) ? 2 : /昨天|yesterday/i.test(relative[0]) ? 1 : 0;
    plan.timeRange = { field: 'occurredAt', from: iso(today - (offset + days - 1) * DAY), toExclusive: iso(today + (1 - offset) * DAY) };
    prose = prose.replace(relative[0], '');
  }
  if (hasUnsupportedQueryTimeFilter(prose) || /明天|本年|去年|上季度|本季度|\d{1,2}月\d{1,2}日/.test(prose)) return reject('无法可靠解析这个时间条件，请使用 YYYY-MM-DD 或 YYYY-MM-DD 至 YYYY-MM-DD。');
  if (plan.timeRange && /状态|\bstatus\b/iu.test(prose) && !/事件|记录|发生|\bevents?\b/iu.test(prose)) return reject('日期筛选只能返回该日发生的事件，不等于当日对象状态。请明确查询事件记录，或用“截至”加含时区的完整 ISO 时点查询历史快照。');
  if (plan.asOf && (plan.timeRange || plan.version)) return reject('历史快照不能同时指定事件日期或来源版本，请分开查询。');
  return plan;
}

export function matchesQueryPlan(record, plan) {
  if (!plan || plan.status !== 'ready') return !plan;
  if (plan.version && String(record.provenance?.objectVersion || record.version || record.objectVersion || '') !== plan.version) return false;
  if (plan.asOf) {
    const period = record.validTime;
    if (!period || !validQueryInstant(period.from) || !Object.hasOwn(period, 'toExclusive') || (period.toExclusive !== null && !validQueryInstant(period.toExclusive))) return false;
    const instant = Date.parse(plan.asOf);
    if (Date.parse(period.from) > instant || (period.toExclusive !== null && instant >= Date.parse(period.toExclusive))) return false;
  }
  if (plan.timeRange) {
    const occurredAt = Date.parse(record.occurredAt || record.provenance?.occurredAt || '');
    if (!Number.isFinite(occurredAt) || occurredAt < Date.parse(plan.timeRange.from) || occurredAt >= Date.parse(plan.timeRange.toExclusive)) return false;
  }
  return true;
}

export function detectQueryEvidenceConflicts(evidence, plan = null) {
  const versions = new Map();
  for (const item of evidence) {
    const version = item.provenance?.objectVersion || item.version;
    if (!item.id || !item.source || !version || version === 'unknown') continue;
    const key = JSON.stringify([item.source, item.id, plan?.asOf ? 'snapshot' : version]);
    if (!versions.has(key)) versions.set(key, { source: item.source, id: item.id, version, statements: new Set() });
    versions.get(key).statements.add(JSON.stringify([plan?.asOf ? version : null, String(item.statement || '')]));
  }
  return [...versions.values()].filter((item) => item.statements.size > 1).map(({ statements, ...item }) => ({ ...item, variants: statements.size, reason: plan?.asOf ? 'overlapping_valid_time_versions' : 'same_source_object_version_conflict' }));
}
