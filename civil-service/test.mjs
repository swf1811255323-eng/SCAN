import assert from 'node:assert/strict';
import {
  PROVINCIAL_REGIONS, analyseItem, buildCoverageStats, buildQueries, classifyAdministrativeLevel, classifyRole,
  detectExcludedArea, extractRegions, extractTreatment, extractYear, parseRss,
  prepareConcretePositions, regionalPriorityWeight, renderEmailHtml, sendMailWithRetry, shouldSendToday
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
assert.deepEqual(regionalPriorityWeight('湖北武汉公务员'), { label: '湖北优先', weight: 30 });
assert.deepEqual(regionalPriorityWeight('四川成都公务员'), { label: '四川优先', weight: 30 });
assert.deepEqual(regionalPriorityWeight('重庆公务员'), { label: '重庆优先', weight: 30 });
assert.deepEqual(regionalPriorityWeight('广东广州公务员'), { label: '', weight: 0 });
assert.equal(classifyAdministrativeLevel('重庆 渝中区 医疗保障事务中心'), '区县/县级市');
assert.equal(classifyAdministrativeLevel('湖北 荆州市直 审计局'), '市级');
assert.equal(classifyAdministrativeLevel('湖北省直机关'), '省级');
assert.equal(hubei.weightedScore, hubei.score + 30);
assert.equal(chuanYu.weightedScore, chuanYu.score + 30);

assert.equal(PROVINCIAL_REGIONS.length, 31);
assert.equal(new Set(PROVINCIAL_REGIONS).size, 31);
const nationwideQueries = buildQueries({ queries: [] }, [2026]);
const queryCoverage = buildCoverageStats([], nationwideQueries, []);
assert.equal(nationwideQueries.length, 63);
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
assert.equal(detectExcludedArea('普通县级机关，不属于艰苦边远地区'), '');

const normalWesternPost = analyseItem({
  title: '2026年度西藏拉萨市公务员招录',
  summary: '市直机关计算机类信息化岗位',
  url: 'https://lasa.gov.cn/job',
}, config);
assert.equal(normalWesternPost.relevant, true);
assert.equal(normalWesternPost.excludedAreaReason, '');

const normalCountyPost = analyseItem({
  title: '2026年度湖北省某县考试录用公务员职位表',
  summary: '县级机关信息技术岗，计算机类专业，不属于艰苦边远地区',
  url: 'https://hubei.gov.cn/county-job',
}, config);
assert.equal(normalCountyPost.administrativeLevel, '区县/县级市');
assert.equal(normalCountyPost.relevant, true);

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

const concretePositions = prepareConcretePositions([
  { grade: 'A+', score: 92, year: 2026, region: '广东 广州', agency: '广东某单位', position: '信息技术岗', headcount: 2, notes: ['历史职位模板'], url: 'https://example.gov.cn/guangdong.xlsx' },
  { grade: 'A+', score: 85, year: 2026, region: '湖北 荆州市直', agency: '荆州市审计局', position: '信息技术岗', headcount: 1, notes: ['历史职位模板'], url: 'https://example.gov.cn/jobs.xlsx' },
  { grade: 'A', score: 77, year: 2026, region: '重庆 某普通县', agency: '某县数据管理局', position: '信息管理职位', headcount: 1, notes: ['普通区县岗位'], url: 'https://example.gov.cn/county.xlsx' },
  { grade: 'A', score: 78, year: 2026, region: '某边境县', agency: '某单位', position: '信息岗', headcount: 1, notes: ['艰苦边远地区'], url: 'https://example.gov.cn/border.xlsx' },
], config, 2028);
assert.equal(concretePositions.length, 3);
assert.equal(concretePositions[0].agency, '荆州市审计局');
assert.equal(concretePositions[0].graduationYear, 2028);
assert.equal(concretePositions[0].regionalPriority, 30);
assert.equal(concretePositions[0].weightedScore, 115);
assert.equal(concretePositions[0].administrativeLevel, '市级');
assert.equal(concretePositions[1].agency, '某县数据管理局');
assert.equal(concretePositions[1].administrativeLevel, '区县/县级市');
assert.equal(concretePositions[2].agency, '广东某单位');

assert.deepEqual(shouldSendToday({ emailSuccess: {} }, '2026-10-04'), { send: true, reason: 'daily-send-due' });
assert.deepEqual(shouldSendToday({ emailSuccess: { '2026-10-04': 'ok' } }, '2026-10-04'), { send: false, reason: 'already-sent-today' });
assert.deepEqual(shouldSendToday({ emailSuccess: { '2026-10-04': 'ok' } }, '2026-10-04', false, true), { send: true, reason: 'forced-send' });
assert.deepEqual(shouldSendToday({ emailSuccess: { '2026-10-04': 'ok' } }, '2026-10-04', true, true), { send: false, reason: 'manual-no-mail' });
let smtpAttempts = 0;
const retryResult = await sendMailWithRetry(async () => {
  smtpAttempts += 1;
  return smtpAttempts < 3 ? { ok: false, error: 'temporary SMTP error' } : { ok: true, status: '250 accepted' };
}, { attempts: 3, wait: async () => {}, log: () => {} });
assert.equal(retryResult.ok, true);
assert.equal(retryResult.attemptsUsed, 3);
assert.equal(smtpAttempts, 3);

const failedRetry = await sendMailWithRetry(async () => ({ ok: false, error: 'still failing' }), { attempts: 3, wait: async () => {}, log: () => {} });
assert.equal(failedRetry.ok, false);
assert.equal(failedRetry.attemptsUsed, 3);
const emailPreview = renderEmailHtml({ items: [analysed, chuanYu, hubei], fresh: [analysed], years: [2026, 2025, 2024], generatedAt: '2026-10-04 08:23:00', concretePositions, graduationYear: 2028 });
assert.match(emailPreview, /每天最多成功发送 1 封/);
assert.match(emailPreview, /湖北 1 条 · 川渝 1 条/);
assert.match(emailPreview, /荆州市审计局/);
assert.match(emailPreview, /信息技术岗/);
assert.match(emailPreview, /具体岗位清单/);
assert.match(emailPreview, /不代表当前可报名/);
assert.match(emailPreview, /具体岗位清单｜湖北 · 川渝优先/);
assert.match(emailPreview, /湖北优先 \+30/);
assert.match(emailPreview, /加权 115 分/);
assert.match(emailPreview, /省会不是硬条件/);
assert.match(emailPreview, /区县\/县级市/);

console.log('civil-service radar tests: OK');

