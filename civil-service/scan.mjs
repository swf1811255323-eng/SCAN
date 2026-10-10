#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_STATE = path.join(HERE, 'state', 'seen.json');
const DEFAULT_OUTPUT = path.join(HERE, 'output');

const CIVIL_TERMS = ['公务员', '国考', '省考', '考试录用', '招录', '招考职位', '职位表', '主任科员'];
const CS_TERMS = [
  '计算机科学与技术', '计算机类', '计算机', '软件工程', '网络工程', '信息安全', '网络安全',
  '网络空间安全', '数据科学', '大数据', '人工智能', '信息化', '信息技术', '电子政务', '数据库'
];
export const PROVINCIAL_REGIONS = [
  '北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
  '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南',
  '湖北', '湖南', '广东', '广西', '海南', '重庆', '四川', '贵州',
  '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆'
];
const REGION_NAMES = [
  '北京', '上海', '天津', '重庆', '湖北', '武汉', '广东', '深圳', '广州', '江苏', '南京', '苏州',
  '浙江', '杭州', '福建', '福州', '厦门', '山东', '济南', '青岛', '河南', '郑州', '湖南', '长沙',
  '四川', '成都', '陕西', '西安', '安徽', '合肥', '江西', '南昌', '河北', '石家庄', '山西', '太原',
  '辽宁', '沈阳', '大连', '吉林', '长春', '黑龙江', '哈尔滨', '广西', '南宁', '云南', '昆明',
  '贵州', '贵阳', '海南', '海口', '甘肃', '兰州', '青海', '宁夏', '银川', '新疆', '西藏',
  '内蒙古', '中央', '全国'
];
const DEFAULT_EXCLUDED_AREA_PATTERNS = [
  '艰苦边远地区', '艰苦边远', '艰苦地区', '边境地区', '边境县', '边境乡镇',
  '边境一线', '边疆地区', '高海拔地区', '高原艰苦地区', '南疆四地州', '三州三区'
];

function parseArgs(argv = process.argv.slice(2)) {
  const out = { dryRun: false, noMail: false, forceMail: false, limit: 80, years: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--no-mail') out.noMail = true;
    else if (argv[i] === '--force-mail') out.forceMail = true;
    else if (argv[i] === '--limit') out.limit = Number(argv[++i]);
    else if (argv[i] === '--years') out.years = argv[++i].split(',').map(Number).filter(Number.isFinite);
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanText(value = '') {
  return decodeXml(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? cleanText(m[1]) : '';
}

export function parseRss(xml, query = '') {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map((block) => ({
    title: xmlTag(block, 'title'),
    url: xmlTag(block, 'link'),
    summary: xmlTag(block, 'description'),
    publishedAt: xmlTag(block, 'pubDate'),
    query,
  })).filter((item) => item.title && item.url);
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm|from|source|track|ref)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().replace(/\?$/, '');
  } catch {
    return raw.trim();
  }
}

function fingerprint(item) {
  return crypto.createHash('sha256').update(canonicalUrl(item.url) || `${item.title}|${item.summary}`).digest('hex');
}

function domainOf(raw) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return ''; }
}

export function extractYear(text, fallback = null) {
  const years = [...String(text).matchAll(/20(?:2[0-9])/g)].map((m) => Number(m[0]));
  return years.find((year) => year >= 2020 && year <= 2035) || fallback;
}

export function extractRegions(text) {
  const hits = REGION_NAMES.filter((name) => String(text).includes(name));
  return [...new Set(hits)].slice(0, 4);
}

export function extractProvincialRegions(text) {
  return PROVINCIAL_REGIONS.filter((name) => String(text).includes(name));
}

export function detectExcludedArea(text, config = {}) {
  const value = String(text);
  const patterns = config.excludedAreaPatterns || DEFAULT_EXCLUDED_AREA_PATTERNS;
  const explicit = patterns.find((term) => value.includes(term));
  if (explicit) return explicit;
  const altitude = value.match(/(?:海拔|平均海拔)[^0-9]{0,6}([2-9][0-9]{3,4})\s*米/);
  if (altitude && Number(altitude[1]) >= Number(config.excludeAltitudeMeters || 2500)) {
    return `海拔${altitude[1]}米`;
  }
  return '';
}

export function isNationalExamItem(text) {
  return /国考|国家公务员局|中央机关及其直属机构|中央国家行政机关|税务系统|海关系统|中国证监会|国家金融监督管理总局/.test(String(text));
}

export function classifyRole(text, categories) {
  const scored = Object.entries(categories).map(([name, terms]) => ({
    name,
    score: terms.reduce((sum, term) => sum + (String(text).includes(term) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].name : '其他计算机相关岗位';
}

export function extractTreatment(text) {
  const value = String(text);
  const hits = [];
  const patterns = [
    /(?:月薪|工资|待遇|薪酬)[：:\s]*(?:人民币)?\s*([0-9][0-9,.]*\s*(?:元|万元|万))(?:\s*[\/-]\s*月)?/gi,
    /([0-9]+(?:\.[0-9]+)?\s*(?:万|万元))\s*\/?\s*年/gi,
    /([0-9][0-9,.]*\s*元)\s*\/?\s*月/gi,
  ];
  for (const pattern of patterns) for (const match of value.matchAll(pattern)) hits.push(match[0].replace(/\s+/g, ''));
  const unique = [...new Set(hits)].sort((a, b) => b.length - a.length);
  return unique.filter((value, index) => !unique.slice(0, index).some((longer) => longer.includes(value))).slice(0, 3);
}

export function analyseItem(item, config) {
  // The search query is deliberately excluded from relevance scoring. Search engines can
  // occasionally return generic year pages; counting query words would make every result
  // look as if it mentioned both a civil-service exam and a computer major.
  const text = `${item.title} ${item.summary}`;
  const domain = domainOf(item.url);
  const civilHits = CIVIL_TERMS.filter((term) => text.includes(term));
  const csHits = CS_TERMS.filter((term) => text.includes(term));
  const official = domain.endsWith('.gov.cn') || domain === 'gov.cn';
  const year = item.year || extractYear(text);
  const regions = extractRegions(text);
  const treatment = extractTreatment(text);
  const provincialRegions = extractProvincialRegions(text);
  const excludedAreaReason = detectExcludedArea(text, config);
  const isNationalExam = isNationalExamItem(text);
  const isChuanYu = /四川|成都|重庆|川渝/.test(text);
  const isHubei = /湖北|武汉/.test(text);
  let score = civilHits.length * 4 + csHits.length * 3 + (official ? 10 : 0) + (year ? 2 : 0);
  if (/事业单位|国企|教师|选聘职员/.test(text) && !/公务员|考试录用/.test(text)) score -= 10;
  return {
    ...item,
    url: canonicalUrl(item.url),
    domain,
    official,
    year,
    regions,
    provincialRegions,
    roleCategory: item.treatmentBasis ? '待遇制度依据' : classifyRole(text, config.roleCategories),
    treatment,
    isChuanYu,
    isHubei,
    isNationalExam,
    excludedAreaReason,
    civilHits,
    csHits,
    score,
    relevant: Boolean(!excludedAreaReason && (item.forceInclude || item.treatmentBasis || (official && civilHits.length > 0 && csHits.length > 0 && score >= 12))),
  };
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function beijingParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, stamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` };
}

async function fetchText(url, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': process.env.HTTP_USER_AGENT || 'civil-service-radar/1.0 (+GitHub Actions)' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function searchBingRss(query, limit) {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'rss');
  url.searchParams.set('count', String(limit));
  return parseRss(await fetchText(url), query).slice(0, limit);
}

export function buildQueries(config, years) {
  const base = config.queries.flatMap((template) => years.map((year) => template.replaceAll('{year}', year)));
  const template = config.nationwideQueryTemplate || '"{year}年度" "{target}" 公务员 计算机 职位表 site:gov.cn';
  const nationwide = years.flatMap((year) => PROVINCIAL_REGIONS.map((target) => template.replaceAll('{year}', year).replaceAll('{target}', target)));
  const nationalTemplate = config.nationalExamQueryTemplate || '"{year}年度" 国考 "计算机类" 职位表 site:gov.cn';
  const national = years.map((year) => nationalTemplate.replaceAll('{year}', year));
  return [...new Set([...base, ...nationwide, ...national])];
}

export function buildCoverageStats(items, queries, excluded = []) {
  const queryTargets = PROVINCIAL_REGIONS.filter((name) => queries.some((query) => String(query).includes(name)));
  const itemCounts = new Map(PROVINCIAL_REGIONS.map((name) => [name, 0]));
  for (const item of items) {
    for (const name of (item.provincialRegions || extractProvincialRegions(`${item.title} ${item.summary}`))) {
      itemCounts.set(name, (itemCounts.get(name) || 0) + 1);
    }
  }
  const hitRegions = PROVINCIAL_REGIONS.filter((name) => (itemCounts.get(name) || 0) > 0);
  return {
    expectedProvinceCount: PROVINCIAL_REGIONS.length,
    queryProvinceCount: queryTargets.length,
    queriedRegions: queryTargets,
    missingQueryRegions: PROVINCIAL_REGIONS.filter((name) => !queryTargets.includes(name)),
    nationalExamQueried: queries.some((query) => /国考|中央机关及其直属机构/.test(String(query))),
    nationalExamHits: items.filter((item) => item.isNationalExam).length,
    hitProvinceCount: hitRegions.length,
    hitRegions,
    missingHitRegions: PROVINCIAL_REGIONS.filter((name) => !hitRegions.includes(name)),
    itemCounts: Object.fromEntries(itemCounts),
    excludedAreaCount: excluded.length,
  };
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const keys = keyFn(item);
    for (const key of (Array.isArray(keys) ? keys : [keys])) {
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function md(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

function html(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderReport({ items, fresh, errors, years, generatedAt, coverage, excluded }) {
  const roles = countBy(items.filter((x) => x.roleCategory !== '待遇制度依据'), (x) => x.roleCategory);
  const regions = countBy(items, (x) => x.regions);
  const yearCounts = countBy(items, (x) => x.year ? String(x.year) : '年份未识别');
  const explicitPay = items.filter((x) => x.treatment.length > 0);
  const hubei = items.filter((x) => x.isHubei);
  const chuanYu = items.filter((x) => x.isChuanYu);
  const lines = [
    '# 计算机专业公务员岗位雷达', '',
    `- 生成时间：${generatedAt}（Asia/Shanghai）`,
    `- 覆盖年份：${years.join('、')}`,
    `- 本轮有效资料：${items.length} 条；首次发现：${fresh.length} 条；抓取异常：${errors.length} 个`,
    `- 扫描范围：${coverage.queryProvinceCount}/${coverage.expectedProvinceCount} 个省级行政区；国考检索：${coverage.nationalExamQueried ? '已执行' : '缺失'}；共执行 ${coverage.queryCount} 个查询，并发 ${coverage.searchConcurrency}`,
    `- 联网发现：搜索返回 ${coverage.searchResultCount} 条原始结果；内置官方基准 ${coverage.seedSourceCount} 条；抓取失败 ${coverage.errorCount} 个`,
    `- 结果命中：${coverage.hitProvinceCount}/${coverage.expectedProvinceCount} 个省级行政区；国考有效资料：${coverage.nationalExamHits} 条；边境/艰苦地区过滤：${coverage.excludedAreaCount} 条`,
    '- 口径：优先政府官网；“岗位”是招录职位或专业目录线索，不把事业单位、国企岗位混作公务员。', '',
    '## 结论速览', '',
    `- 主要岗位方向：${roles.slice(0, 6).map(([k, v]) => `${k}（${v}）`).join('、') || '暂无足够结果'}`,
    `- 高频地区：${regions.slice(0, 12).map(([k, v]) => `${k}（${v}）`).join('、') || '职位页未明确地区'}`,
    `- 年份分布：${yearCounts.map(([k, v]) => `${k}（${v}）`).join('、')}`,
    `- 重点地区：湖北（含武汉）命中 ${hubei.length} 条；川渝（四川/成都/重庆）命中 ${chuanYu.length} 条，两组均优先展示。`,
    `- 全国覆盖：查询缺失 ${coverage.missingQueryRegions.join('、') || '无'}；本轮结果未命中 ${coverage.missingHitRegions.join('、') || '无'}。`,
    '- 待遇制度：依据《公务员法》，工资由基本工资、津贴、补贴和奖金构成，并依法享受住房、医疗等补贴补助及社会保险；实际金额随职级、地区、单位和特殊岗位变化。',
    '- 重要提醒：招录公告通常不披露实发工资。程序只摘录页面中明确出现的金额，不根据地区传闻推算。', '',
    '## 岗位、地区与待遇证据', '',
    '| 年份 | 岗位方向 | 地区 | 待遇信息 | 来源 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const item of items) {
    const pay = item.treatment.length ? item.treatment.join('；') : (item.roleCategory === '待遇制度依据' ? '基本工资＋津贴＋补贴＋奖金等法定构成' : '公告未公开金额');
    lines.push(`| ${item.year || '未识别'} | ${md(item.roleCategory)} | ${md(item.regions.join('、') || '未注明')} | ${md(pay)} | [${md(item.title)}](${item.url}) |`);
  }
  lines.push('', '## 全国 31 个省级行政区 + 国考覆盖', '',
    '| 省级行政区 | 已扫描 | 有效资料数 |',
    '| --- | --- | ---: |');
  for (const name of PROVINCIAL_REGIONS) {
    lines.push(`| ${name} | ${coverage.queriedRegions.includes(name) ? '是' : '否'} | ${coverage.itemCounts[name] || 0} |`);
  }
  lines.push('', `- 国考检索：${coverage.nationalExamQueried ? '已扫描' : '未扫描'}；有效资料 ${coverage.nationalExamHits} 条。`);
  lines.push('', '## 边境/艰苦地区过滤', '');
  if (excluded.length) {
    for (const item of excluded.slice(0, 40)) lines.push(`- 已排除｜${md(item.title)}｜原因：${md(item.excludedAreaReason)}｜${item.url}`);
  } else {
    lines.push('- 本轮没有发现带明确边境、艰苦边远或高海拔标记的结果。');
  }
  lines.push('', '## 湖北与川渝专项', '');
  const regional = items.filter((x) => x.isHubei || x.isChuanYu);
  if (regional.length) {
    for (const item of regional) {
      const group = item.isHubei ? '湖北' : '川渝';
      lines.push(`- **${group}**｜[${md(item.title)}](${item.url})｜${item.roleCategory}｜${item.regions.join('、') || '职位表待核对'}｜${item.treatment.join('；') || '公告未公开金额'}`);
    }
  } else {
    lines.push('- 本轮没有检出重点地区的新增有效资料，专项查询将在下一批次继续扫描。');
  }
  lines.push('', '## 可核验的明确待遇金额', '');
  if (explicitPay.length) {
    for (const item of explicitPay) lines.push(`- ${item.treatment.join('；')} — [${md(item.title)}](${item.url})`);
  } else {
    lines.push('- 本轮政府来源未检出可直接核验的具体金额；请以拟报地区、单位及录用后的工资核定为准。');
  }
  lines.push('', '## 本轮新发现', '');
  if (fresh.length) for (const item of fresh.slice(0, 30)) lines.push(`- [${md(item.title)}](${item.url})｜${item.roleCategory}｜${item.regions.join('、') || '地区未注明'}`);
  else lines.push('- 没有新的有效资料。');
  if (errors.length) {
    lines.push('', '## 抓取异常', '');
    for (const error of errors) lines.push(`- ${md(error)}`);
  }
  lines.push('', '> 自动归类仅用于缩小检索范围。报考资格、专业代码、学历、应届身份、政治面貌、基层经历、工作地点和待遇均以当年官方职位表及招录机关答复为准。', '');
  return lines.join('\n');
}

export function renderEmailHtml({ items, fresh, years, generatedAt, coverage = buildCoverageStats(items, [], []) }) {
  const roleCounts = countBy(items.filter((x) => x.roleCategory !== '待遇制度依据'), (x) => x.roleCategory);
  const regionCounts = countBy(items, (x) => x.regions);
  const mainRole = roleCounts[0]?.[0] || '等待更多资料';
  const topRegion = regionCounts[0]?.[0] || '职位表未注明';
  const hubeiCount = items.filter((x) => x.isHubei).length;
  const chuanYuCount = items.filter((x) => x.isChuanYu).length;
  const cards = items.filter((x) => x.roleCategory !== '待遇制度依据').slice(0, 12).map((item) => {
    const pay = item.treatment.length ? item.treatment.join('；') : '公告未公开具体金额';
    const location = item.regions.join(' · ') || '地区待职位表确认';
    return `
      <tr><td style="padding:0 24px 14px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e8eaf4;border-radius:14px;background:#fff">
          <tr><td style="padding:18px 18px 8px">
            <span style="display:inline-block;padding:4px 9px;border-radius:999px;background:#eef2ff;color:#4f46e5;font-size:12px;font-weight:700">${html(item.roleCategory)}</span>
            ${item.official ? '<span style="display:inline-block;margin-left:6px;padding:4px 9px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:12px;font-weight:700">政府官网</span>' : ''}
          </td></tr>
          <tr><td style="padding:2px 18px 8px;color:#111827;font-size:17px;line-height:1.55;font-weight:750">${html(item.title)}</td></tr>
          <tr><td style="padding:0 18px 13px;color:#667085;font-size:13px;line-height:1.7">📍 ${html(location)}　·　📅 ${html(item.year || '年份未识别')}<br>💼 待遇：${html(pay)}</td></tr>
          <tr><td style="padding:0 18px 18px"><a href="${html(item.url)}" style="display:inline-block;padding:9px 15px;border-radius:9px;background:#111827;color:#fff;text-decoration:none;font-size:13px;font-weight:700">查看官方来源 →</a></td></tr>
        </table>
      </td></tr>`;
  }).join('');

  const roleSummary = roleCounts.slice(0, 5).map(([name, count]) => `<li style="margin:0 0 8px"><b>${html(name)}</b>：${count} 条资料</li>`).join('');
  const regionSummary = regionCounts.slice(0, 8).map(([name, count]) => `${html(name)} ${count}`).join(' · ') || '地区待职位表确认';
  return `<!doctype html>
  <html><body style="margin:0;background:#f4f6fb;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6fb"><tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 10px 35px rgba(30,41,59,.09)">
        <tr><td style="padding:34px 30px;background:linear-gradient(135deg,#312e81 0%,#4f46e5 48%,#0891b2 100%);color:#fff">
          <div style="font-size:12px;letter-spacing:2px;font-weight:800;opacity:.85">CS · CIVIL SERVICE RADAR</div>
          <div style="margin-top:12px;font-size:28px;line-height:1.3;font-weight:850">计算机专业公务员<br>今日岗位情报</div>
          <div style="margin-top:12px;font-size:14px;opacity:.88">${html(generatedAt)} · 覆盖 ${html(years.join(' / '))}</div>
        </td></tr>

        <tr><td style="padding:24px 24px 10px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td width="32%" style="padding:15px 8px;text-align:center;background:#f8f7ff;border-radius:12px"><div style="font-size:25px;font-weight:850;color:#4338ca">${items.length}</div><div style="font-size:12px;color:#667085">有效资料</div></td>
            <td width="2%"></td>
            <td width="32%" style="padding:15px 8px;text-align:center;background:#f0fdfa;border-radius:12px"><div style="font-size:25px;font-weight:850;color:#0f766e">${fresh.length}</div><div style="font-size:12px;color:#667085">本轮新发现</div></td>
            <td width="2%"></td>
            <td width="32%" style="padding:15px 8px;text-align:center;background:#fff7ed;border-radius:12px"><div style="font-size:18px;font-weight:850;color:#c2410c">${html(topRegion)}</div><div style="font-size:12px;color:#667085">高频地区</div></td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:15px 30px 22px">
          <div style="font-size:18px;font-weight:800;color:#111827">今天先看这三点</div>
          <ul style="padding-left:20px;margin:13px 0 0;color:#475467;font-size:14px;line-height:1.7">
            <li style="margin:0 0 8px">当前最集中方向：<b style="color:#111827">${html(mainRole)}</b></li>
            <li style="margin:0 0 8px">地区热度：${regionSummary}</li>
            <li style="margin:0 0 8px"><b style="color:#111827">湖北 ${hubeiCount} 条 · 川渝 ${chuanYuCount} 条</b>，重点区域线索已优先排列。</li>
            <li style="margin:0 0 8px">全国扫描：<b style="color:#111827">${coverage.queryProvinceCount}/${coverage.expectedProvinceCount} 省级行政区 + 国考</b>；结果命中 ${coverage.hitProvinceCount} 个省级行政区。</li>
            <li style="margin:0 0 8px">已排除明确边境/艰苦地区结果：${coverage.excludedAreaCount} 条。</li>
            <li>公告通常不披露实发金额；未明示时不采用网传薪资。</li>
          </ul>
        </td></tr>

        <tr><td style="padding:0 30px 14px"><div style="padding:16px 18px;border-radius:14px;background:#fffbeb;border-left:4px solid #f59e0b;color:#78350f;font-size:13px;line-height:1.75"><b>待遇怎么读：</b>依据《公务员法》，工资由基本工资、津贴、补贴和奖金构成，并依法享受住房、医疗等补贴补助及社会保险。实际金额与职级、地区、单位和特殊岗位有关，最终以录用后的工资核定为准。</div></td></tr>

        <tr><td style="padding:18px 30px 8px"><div style="font-size:18px;font-weight:800;color:#111827">主要岗位方向</div><ul style="padding-left:20px;color:#475467;font-size:14px;line-height:1.65">${roleSummary}</ul></td></tr>
        <tr><td style="padding:8px 30px 18px"><div style="font-size:18px;font-weight:800;color:#111827">精选官方线索</div><div style="margin-top:5px;color:#98a2b3;font-size:12px">按相关度排序，报考前务必打开职位表核对专业代码与资格条件</div></td></tr>
        ${cards || '<tr><td style="padding:0 30px 24px;color:#667085">今天暂未检出新的岗位线索。</td></tr>'}
        <tr><td style="padding:22px 30px 30px;background:#f8fafc;color:#667085;font-size:12px;line-height:1.75;text-align:center">每天扫描 4 次 · 每天最多成功发送 1 封<br>自动归类用于发现线索，报考条件和待遇以官方职位表及招录机关答复为准。</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

function updateState(state, items, nowIso) {
  const entries = state.entries || {};
  for (const item of items) {
    const key = fingerprint(item);
    const old = entries[key] || {};
    entries[key] = { title: item.title, url: item.url, firstSeen: old.firstSeen || nowIso, lastSeen: nowIso };
  }
  const compact = Object.entries(entries).sort((a, b) => String(b[1].lastSeen).localeCompare(String(a[1].lastSeen))).slice(0, 2500);
  const emailSuccess = Object.fromEntries(Object.entries(state.emailSuccess || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 60));
  return { version: 2, updatedAt: nowIso, emailSuccess, entries: Object.fromEntries(compact) };
}

export function shouldSendToday(state, date, noMail = false, forceMail = false) {
  if (noMail) return { send: false, reason: 'manual-no-mail' };
  if (forceMail) return { send: true, reason: 'forced-send' };
  if (state.emailSuccess?.[date]) return { send: false, reason: 'already-sent-today' };
  return { send: true, reason: 'daily-send-due' };
}

async function maybeSendMail({ report, emailHtml, items, date, state, noMail, forceMail }) {
  const gate = shouldSendToday(state, date, noMail, forceMail);
  if (!gate.send) return { sent: false, skipped: true, reason: gate.reason };
  if (!process.env.GMAIL_APP_PASSWORD) return { sent: false, skipped: true, reason: 'missing-password' };
  try {
    const { sendMail, buildRawMessage } = await import('../src/mail/smtp.js');
    const user = process.env.GMAIL_USER;
    const to = process.env.MAIL_TO || user;
    if (!user || !to) return { sent: false, skipped: true, reason: 'missing-user' };
    const subject = `【公务员岗位雷达】${date}｜${items.length} 条计算机专业线索`;
    const text = report.length > 80_000 ? `${report.slice(0, 80_000)}\n\n（正文已截断，完整报告见 GitHub Actions artifact）` : report;
    const rawMessage = buildRawMessage({ from: user, fromName: '公务员岗位雷达', to, subject, text, html: emailHtml });
    const result = await sendMail({ user, password: process.env.GMAIL_APP_PASSWORD, to, rawMessage, log: console.log });
    return { sent: Boolean(result.ok), status: result.status || '', error: result.error || '' };
  } catch (error) {
    return { sent: false, error: error.message };
  }
}

export async function run(args = parseArgs(), deps = {}) {
  const config = loadJson(path.join(HERE, 'config.json'), null);
  if (!config) throw new Error('无法读取 civil-service/config.json');
  const years = args.years?.length ? args.years : config.years;
  const queries = buildQueries(config, years);
  if (args.dryRun) {
    console.log(`将执行 ${queries.length} 个政府站点检索：`);
    for (const query of queries) console.log(`- ${query}`);
    const coverage = buildCoverageStats([], queries, []);
    coverage.queryCount = queries.length;
    console.log(`覆盖校验：${coverage.queryProvinceCount}/${coverage.expectedProvinceCount} 个省级行政区，国考 ${coverage.nationalExamQueried ? '已包含' : '缺失'}`);
    return { dryRun: true, queries, coverage };
  }

  const search = deps.search || searchBingRss;
  const raw = [];
  const errors = [];
  const concurrency = Math.max(1, Math.min(12, Number(config.searchConcurrency) || 6));
  for (let i = 0; i < queries.length; i += concurrency) {
    const batch = queries.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((query) => search(query, config.maxResultsPerQuery)));
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') raw.push(...result.value);
      else errors.push(`${batch[index]}：${result.reason?.message || result.reason}`);
    });
  }
  const searchResultCount = raw.length;
  raw.push(...config.seedSources.map((item) => ({ ...item, query: '内置官方基准来源' })));

  const analysed = raw.map((x) => analyseItem(x, config));
  const excluded = analysed.filter((item) => item.excludedAreaReason);
  const byUrl = new Map();
  for (const item of analysed.filter((x) => x.relevant)) {
    const key = canonicalUrl(item.url);
    const old = byUrl.get(key);
    if (!old || item.score > old.score) byUrl.set(key, item);
  }
  const all = [...byUrl.values()].sort((a, b) => Number(b.isHubei || b.isChuanYu) - Number(a.isHubei || a.isChuanYu) || b.score - a.score || (b.year || 0) - (a.year || 0));
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : config.reportLimit;
  const items = all.slice(0, limit);
  const state = loadJson(DEFAULT_STATE, { version: 2, emailSuccess: {}, entries: {} });
  const fresh = items.filter((item) => !state.entries?.[fingerprint(item)]);
  const now = deps.now || new Date();
  const bj = beijingParts(now);
  const coverage = buildCoverageStats(items, queries, excluded);
  Object.assign(coverage, {
    queryCount: queries.length,
    searchResultCount,
    seedSourceCount: config.seedSources.length,
    searchConcurrency: concurrency,
    errorCount: errors.length,
  });
  const report = renderReport({ items, fresh, errors, years, generatedAt: bj.stamp, coverage, excluded });
  const emailHtml = renderEmailHtml({ items, fresh, years, generatedAt: bj.stamp, coverage });

  fs.mkdirSync(DEFAULT_OUTPUT, { recursive: true });
  fs.mkdirSync(path.join(DEFAULT_OUTPUT, 'history'), { recursive: true });
  fs.mkdirSync(path.dirname(DEFAULT_STATE), { recursive: true });
  fs.writeFileSync(path.join(DEFAULT_OUTPUT, 'latest.md'), report, 'utf8');
  fs.writeFileSync(path.join(DEFAULT_OUTPUT, 'latest.json'), JSON.stringify({ generatedAt: now.toISOString(), years, coverage, excluded, items, freshCount: fresh.length, errors }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(DEFAULT_OUTPUT, 'history', `${bj.date}.md`), report, 'utf8');
  const mail = await maybeSendMail({
    report,
    emailHtml,
    items,
    date: bj.date,
    state,
    noMail: args.noMail,
    forceMail: args.forceMail,
  });
  if (mail.sent) state.emailSuccess = { ...(state.emailSuccess || {}), [bj.date]: now.toISOString() };
  fs.writeFileSync(DEFAULT_STATE, JSON.stringify(updateState(state, items, now.toISOString()), null, 2) + '\n', 'utf8');
  console.log(`完成：扫描 ${coverage.queryProvinceCount}/${coverage.expectedProvinceCount} 省级行政区 + 国考，命中 ${coverage.hitProvinceCount} 省，排除边境/艰苦地区 ${coverage.excludedAreaCount} 条；有效资料 ${items.length} 条，新发现 ${fresh.length} 条，异常 ${errors.length} 个，邮件 ${mail.sent ? '已发送' : `未发送（${mail.reason || mail.error || '未知原因'}）`}`);
  if (mail.error) console.warn(`邮件警告：${mail.error}`);
  return { items, fresh, errors, excluded, coverage, report, mail };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('用法：node civil-service/scan.mjs [--dry-run] [--no-mail] [--force-mail] [--years 2026,2025,2024] [--limit 80]');
    return;
  }
  await run(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

