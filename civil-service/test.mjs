import assert from 'node:assert/strict';
import {
  PROVINCIAL_REGIONS, analyseItem, buildCoverageStats, buildQueries, classifyRole,
  detectExcludedArea, extractRegions, extractTreatment, extractYear, parseRss,
  renderEmailHtml, shouldSendToday
} from './scan.mjs';

const config = {
  roleCategories: {
    '信息化/电子政务': ['信息化', '电子政务'],
    '网络安全/网信': ['网络安全', '网信', '信息安全'],
    '专业监管/技术监管': ['证监', '税务'],
  },
};

const xml = `<?xml version="1.0"?><rss><channel><item>
  <title><![CDATA[2026年度某机关计算机类公务员招录]]></title>
  <link>https://example.gov.cn/jobs?id=1&amp;utm_source=test</link>
  <description>北京网络安全岗位，待遇 8000元/月</description>
  <pubDate>Wed, 01 Oct 2025 01:00:00 GMT</pubDate>
</item></channel></rss>`;

const parsed = parseRss(xml, '2026 计算机类 公务员');
assert.equal(parsed.length, 1);
assert.match(parsed[0].url, /example\.gov\.cn/);
assert.equal(extractYear(parsed[0].title), 2026);
assert.deepEqual(extractRegions('北京和武汉均有岗位'), ['北京', '武汉']);
assert.deepEqual(extractTreatment('待遇：8000元/月，另有补贴'), ['待遇：8000元/月']);
assert.equal(classifyRole('网络安全和信息安全', config.roleCategories), '网络安全/网信');

const analysed = analyseItem(parsed[0], config);
assert.equal(analysed.relevant, true);
assert.equal(analysed.official, true);
assert.equal(analysed.roleCategory, '网络安全/网信');
assert.deepEqual(analysed.regions, ['北京']);
assert.equal(analysed.url.includes('utm_source'), false);

const unrelated = analyseItem({ title: '某公司软件工程师招聘', summary: 'Java 开发', url: 'https://example.com/job' }, config);
assert.equal(unrelated.relevant, false);

const chuanYu = analyseItem({ title: '重庆市公务员计算机类职位', summary: '信息技术管理', url: 'https://cq.gov.cn/job' }, config);
assert.equal(chuanYu.isChuanYu, true);
assert.deepEqual(chuanYu.regions, ['重庆']);

const hubei = analyseItem({ title: '湖北省公务员网络安全职位', summary: '工作地点武汉', url: 'https://rst.hubei.gov.cn/job' }, config);
assert.equal(hubei.isHubei, true);
assert.deepEqual(hubei.regions, ['湖北', '武汉']);

assert.equal(PROVINCIAL_REGIONS.length, 31);
assert.equal(new Set(PROVINCIAL_REGIONS).size, 31);
const nationwideQueries = buildQueries({ queries: [] }, [2026]);
const queryCoverage = buildCoverageStats([], nationwideQueries, []);
assert.equal(nationwideQueries.length, 32);
assert.equal(queryCoverage.queryProvinceCount, 31);
assert.equal(queryCoverage.nationalExamQueried, true);
assert.deepEqual(queryCoverage.missingQueryRegions, []);

const borderPost = analyseItem({
  title: '2026年度云南省某边境县公务员招录',
  summary: '计算机类信息化岗位，工作地点属于艰苦边远地区',
  url: 'https://yn.gov.cn/job',
  forceInclude: true,
}, config);
assert.equal(borderPost.relevant, false);
assert.equal(borderPost.excludedAreaReason, '艰苦边远地区');
assert.equal(detectExcludedArea('工作地点平均海拔 3200 米'), '海拔3200米');

const normalWesternPost = analyseItem({
  title: '2026年度西藏拉萨市公务员招录',
  summary: '市直机关计算机类信息化岗位',
  url: 'https://lasa.gov.cn/job',
}, config);
assert.equal(normalWesternPost.relevant, true);
assert.equal(normalWesternPost.excludedAreaReason, '');

const nationalExam = analyseItem({
  title: '国家公务员局2026年度中央机关及其直属机构考试录用公务员',
  summary: '国考计算机类职位表',
  url: 'https://www.gov.cn/job',
}, config);
assert.equal(nationalExam.isNationalExam, true);
const fullCoverageItems = PROVINCIAL_REGIONS.map((name) => analyseItem({
  title: `2026年度${name}公务员计算机类岗位`,
  summary: '信息化职位表',
  url: `https://${encodeURIComponent(name)}.gov.cn/job`,
  forceInclude: true,
}, config));
const resultCoverage = buildCoverageStats([...fullCoverageItems, nationalExam], nationwideQueries, [borderPost]);
assert.equal(resultCoverage.hitProvinceCount, 31);
assert.equal(resultCoverage.nationalExamHits, 1);
assert.equal(resultCoverage.excludedAreaCount, 1);

assert.deepEqual(shouldSendToday({ emailSuccess: {} }, '2026-10-04'), { send: true, reason: 'daily-send-due' });
assert.deepEqual(shouldSendToday({ emailSuccess: { '2026-10-04': 'ok' } }, '2026-10-04'), { send: false, reason: 'already-sent-today' });
assert.deepEqual(shouldSendToday({ emailSuccess: { '2026-10-04': 'ok' } }, '2026-10-04', false, true), { send: true, reason: 'forced-send' });
assert.deepEqual(shouldSendToday({ emailSuccess: { '2026-10-04': 'ok' } }, '2026-10-04', true, true), { send: false, reason: 'manual-no-mail' });
const emailPreview = renderEmailHtml({ items: [analysed, chuanYu, hubei], fresh: [analysed], years: [2026, 2025, 2024], generatedAt: '2026-10-04 08:23:00' });
assert.match(emailPreview, /每天最多成功发送 1 封/);
assert.match(emailPreview, /湖北 1 条 · 川渝 1 条/);

console.log('civil-service radar tests: OK');

