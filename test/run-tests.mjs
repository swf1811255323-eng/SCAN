// Offline test suite (no network). Run: node test/run-tests.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { decodeEntities, stripTags } from '../src/lib/http.js';
import { beijingDateString, beijingStamp } from '../src/lib/time.js';
import { parseSearchPage as parseZhaopin, parseDetailPage as parseZhaopinDetail, buildSearchUrl as zhaopinUrl } from '../src/collect/zhaopin.js';
import { parseSearchPage as parseShixiseng, parseDetailPage as parseShixisengDetail } from '../src/collect/shixiseng.js';
import {
  buildIndexSearchUrl,
  isChallengePage,
  parseIndexedDetailPage,
  parseIndexedRss,
  parseIndexedSearchHtml,
  parse51JobListPage,
  parseLiepinListPage,
} from '../src/collect/indexed-platforms.js';
import { scoreJob, dedupeJobs, rankJobs, selectForReport, hardExcluded, jobIdentity } from '../src/filter/score.js';
import { loadLedger, saveLedger, splitNewSeen, markSeen, isSeen } from '../src/dedupe/ledger.js';
import { buildEmail, buildSubject } from '../src/mail/compose.js';
import { buildRawMessage, normalizeMailbox } from '../src/mail/smtp.js';
import { chooseEnrichmentCandidates, normalizeJob, preFilter, parseArgs, runScan } from '../src/main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'profile.json'), 'utf8'));
const keywords = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'keywords.json'), 'utf8'));

const ZHAOPIN_LIST = `
<div class="joblist-box__item clearfix joblist-box__item-unlogin"><div class="joblist-box__iteminfo"><div class="jobinfo">
<div class="jobinfo__top"><div class="jobinfo__name-row"><a href="http://www.zhaopin.com/jobdetail/CC151294010J40882897414.htm" target="_blank" class="jobinfo__name">C++开发实习生</a></div>
<p class="jobinfo__salary"> 150-200元/天 </p></div><div class="jobinfo__tag"><div class="joblist-box__item-tag"> C语言 </div><div class="joblist-box__item-tag"> Socket </div></div>
<div class="jobinfo__other-info"><div class="jobinfo__other-info-item"><img src="x.png"> <span>武汉·洪山·关山</span></div><div class="jobinfo__other-info-item"> 经验不限 </div><div class="jobinfo__other-info-item"> 本科 </div></div></div>
<div class="companyinfo"><div class="companyinfo__top"><a title="中望软件" href="https://www.zhaopin.com/companydetail/CZ151294010.htm" target="_blank" class="companyinfo__name companyinfo__name-short"> 中望软件 </a></div>
<div class="companyinfo__tag"><div class="joblist-box__item-tag"> 民营 </div><div class="joblist-box__item-tag"> 1000-9999人 </div><div class="joblist-box__item-tag"> 软件/IT服务 </div></div></div></div></div>
<div class="joblist-box__item clearfix joblist-box__item-unlogin"><div class="joblist-box__iteminfo"><div class="jobinfo">
<div class="jobinfo__top"><div class="jobinfo__name-row"><a href="https://www.zhaopin.com/jobdetail/CC999999999J00000000001.htm" target="_blank" class="jobinfo__name">Web前端开发实习生</a></div>
<p class="jobinfo__salary"> 120元/天 </p></div>
<div class="jobinfo__other-info"><div class="jobinfo__other-info-item"><span>武汉·武昌</span></div><div class="jobinfo__other-info-item"> 本科 </div></div></div>
<div class="companyinfo"><div class="companyinfo__top"><a title="某某网络" href="https://www.zhaopin.com/companydetail/CZ1.htm" class="companyinfo__name"> 某某网络 </a></div>
<div class="companyinfo__tag"><div class="joblist-box__item-tag"> 民营 </div></div></div></div></div>`;

const ZHAOPIN_DETAIL = `<html><body><div>C++开发实习生招聘_中望软件招聘 - 智联招聘</div>
<div>实习职位特点 总实习月数 3个月 周实习天数 4天</div>
<div>职位描述 岗位职责 1、根据产品需求文档进行软件开发；2、熟悉C/C++编程语言以及面向对象编程设计。任职资格 1、计算机相关专业，本科及以上学历；2、熟悉数据结构与算法；3、熟悉Linux环境与Socket网络编程、多线程优先；4、能保证连续实习期三个月或以上。</div>
<div>工作地点 武汉</div><div>公司介绍 广州中望龙腾软件股份有限公司，A股上市工业软件企业。</div></body></html>`;

const SHIXISENG_LIST = `<div data-intern-id="inn_abc123xyz" searchType="intern" class="intern-wrap interns-point intern-item"><div class="clearfix intern-detail">
<div class="f-l intern-detail__job"><p><a href="https://www.shixiseng.com/intern/inn_abc123xyz?pcm=pc_SearchList" title="&amp;#xe9d4;++实习&amp;#xe5a3" target="_blank" class="title ellipsis font" data-v-1>&#xe9d4;++实习&#xe5a3</a> <span class="day font" data-v-1>&#xeb7e&#xebd6&#xebd6-&#xeb7e&#xe068&#xebd6/天</span></p>
<p class="tip" data-v-1><span class="city ellipsis" data-v-1>武汉</span> <span data-v-1>|</span> <span class="font" data-v-1>&#xe068天/周</span> <span data-v-1>|</span> <span class="font" data-v-1>&#xf65c个月</span></p></div>
<div class="f-r intern-detail__company" data-v-1><p data-v-1><a title="挚信资本" data-v-1>挚信资本</a></p><div><span>大厂实习</span><span>福利多多</span></div></div></div></div>`;

const SHIXISENG_DETAIL = `<html><head><title>C++实习生实习招聘-挚信资本实习生招聘-实习僧</title></head><body>
<div>2025-06-16 10:47:47 刷新 100-150/天 武汉 本科 5天／周 实习3个月</div>
<div>职位描述： 岗位描述 1．实现搜索服务自动化评测；2．大规模数据挖掘。任职要求 1．在校大三学生，计算机相关专业；2．有参与 C ++ 编程技能大赛或 GIS 平台软件开发经历为佳；3．数据库基础知识扎实。</div>
<div>投递要求： 简历要求： 中文 截止日期：2026-12-31 工作地点： 武汉市</div></body></html>`;

const INDEX_RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[武汉C++开发实习生招聘信息-BOSS直聘]]></title><link>https://www.zhipin.com/zhaopin/demo/?utm_source=bing</link><description><![CDATA[武汉 200-250元/天，本科，熟悉 C++、Linux 与网络编程。]]></description><pubDate>Sun, 04 Oct 2026 00:00:00 GMT</pubDate></item>
<item><title>伪造结果</title><link>https://evil.example.com/job</link><description>武汉 C++ 实习</description></item>
</channel></rss>`;

const INDEX_DETAIL = `<html><head><title>C++开发实习生-示例科技-BOSS直聘</title>
<script type="application/ld+json">{
  "@context":"https://schema.org","@type":"JobPosting","title":"C++开发实习生",
  "description":"职位描述：参与 Linux 网络服务研发。任职要求：本科在校生，熟悉 C++、Socket 与多线程。",
  "datePosted":"2026-10-03","validThrough":"2026-11-30",
  "hiringOrganization":{"@type":"Organization","name":"示例科技","sameAs":"https://example.com"},
  "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressRegion":"湖北","addressLocality":"武汉"}},
  "baseSalary":{"@type":"MonetaryAmount","currency":"CNY","value":{"@type":"QuantitativeValue","minValue":180,"maxValue":250,"unitText":"DAY"}},
  "educationRequirements":"本科"
}</script></head><body>公开职位详情</body></html>`;

const INDEX_SEARCH_HTML = `<div class="vrwrap"><div class="fz-mid space-txt">武汉 200-250元/天，本科，熟悉 C++ 与 Linux。</div>
<div data-url="https://www.zhipin.com/zhaopin/demo/?from=sogou" data-hint="sugg" data-title="%E3%80%8C%E6%AD%A6%E6%B1%89C%2B%2B%E5%AE%9E%E4%B9%A0%E6%8B%9B%E8%81%98%E4%BF%A1%E6%81%AF%E3%80%8D-BOSS%E7%9B%B4%E8%81%98"></div></div>
<div data-url="https://evil.example.com/job" data-hint="sugg" data-title="%E4%BC%AA%E9%80%A0%E7%BB%93%E6%9E%9C"></div>`;

const JOB51_LIST = `<div class="e on" name="check_div"><a class="el" href="https://jobs.51job.com/wuhan-cdq/166095617.html?t=0">
<span class="jname at">决策规划开发实习生</span><span class="time">09-21发布</span>
<span class="sal at">120元/天</span><span class="d at">武汉·蔡甸区 | 在校生/应届生 | 本科</span><p class="tags on"><span><i>ROS</i><i>C++</i></span></p></a>
<div class="er"><a class="cname at">东风悦享科技</a><p class="dc at">国企 | 150-500人</p><p class="int at">互联网/电子商务</p></div></div>`;

const LIEPIN_LIST = `<div class="job-list-item"><div class="job-card-pc-container"><a href="https://www.liepin.com/job/1985588249.shtml">
<div class="job-title-box"><div title="C++开发实习生" class="ellipsis-1">C++开发实习生</div><div class="job-dq-box"><span>【</span><span>武汉-流芳</span><span>】</span></div></div>
<span class="job-salary">3-4k</span><div class="job-labels-box"><span class="labels-tag">经验不限</span><span class="labels-tag">本科</span></div></a>
<span class="company-name ellipsis-1">示例科技</span><div class="company-tags-box"><span>计算机软件</span><span>B轮融资</span><span>100-499人</span></div></div></div>`;

test('decodeEntities 处理缺少分号的实体（实习僧字体混淆）', () => {
  assert.equal(stripTags('<a>&#xe9d4;++实习&#xe5a3</a>'), '++实习');
  assert.equal(decodeEntities('A&amp;B'), 'A&B');
});

test('智联列表页解析：标题/公司/城市/学历/公司标签', () => {
  const items = parseZhaopin(ZHAOPIN_LIST, { query: 'C++实习', city: '武汉' });
  assert.equal(items.length, 2);
  const [first, second] = items;
  assert.equal(first.title, 'C++开发实习生');
  assert.equal(first.company, '中望软件');
  assert.equal(first.city, '武汉·洪山·关山');
  assert.equal(first.education, '本科');
  assert.equal(first.url, 'https://www.zhaopin.com/jobdetail/CC151294010J40882897414.htm');
  assert.ok(first.companyMeta.includes('1000-9999人'));
  assert.equal(second.title, 'Web前端开发实习生');
});

test('智联详情页解析：时长 + 职位描述', () => {
  const d = parseZhaopinDetail(ZHAOPIN_DETAIL);
  assert.equal(d.months, '3个月');
  assert.equal(d.daysPerWeek, '4天');
  assert.match(d.description, /Socket 网络编程|Socket/);
});

test('智联搜索 URL 生成', () => {
  assert.equal(zhaopinUrl('C++实习', '736'), 'https://sou.zhaopin.com/?jl=736&kw=C%2B%2B%E5%AE%9E%E4%B9%A0');
});

test('实习僧列表页解析：卡片字段 + 实体解码', () => {
  const items = parseShixiseng(SHIXISENG_LIST, { keyword: 'C++', city: '武汉' });
  assert.equal(items.length, 1);
  assert.equal(items[0].company, '挚信资本');
  assert.equal(items[0].city, '武汉');
  assert.match(items[0].daysPerWeek, /天\/周/);
  assert.match(items[0].months, /个月/);
  assert.equal(items[0].url, 'https://www.shixiseng.com/intern/inn_abc123xyz');
});

test('实习僧详情页解析：截止日期/刷新时间/学历/描述', () => {
  const d = parseShixisengDetail(SHIXISENG_DETAIL);
  assert.equal(d.deadline, '2026-12-31');
  assert.match(d.refreshDate, /^2025-06-16/);
  assert.equal(d.degree, '本科');
  assert.match(d.description, /在校大三/);
});

test('受风控平台索引：RSS 只保留目标官网并清理追踪参数', () => {
  const platform = { id: 'boss', label: 'BOSS直聘', domain: 'zhipin.com' };
  const items = parseIndexedRss(INDEX_RSS, platform, { keyword: 'C++ 实习', city: '武汉' });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'boss');
  assert.equal(items[0].city, '武汉');
  assert.equal(items[0].salary, '200-250元/天');
  assert.equal(items[0].url, 'https://www.zhipin.com/zhaopin/demo/');
  assert.match(buildIndexSearchUrl('site:zhipin.com C++ 实习'), /sogou\.com\/web/);
});

test('受风控平台索引：搜狗结果提取官网规范链接和摘要', () => {
  const platform = { id: 'boss', label: 'BOSS直聘', domain: 'zhipin.com', requiredUrlParts: ['/zhaopin/'] };
  const items = parseIndexedSearchHtml(INDEX_SEARCH_HTML, platform, { keyword: 'C++ 实习', city: '武汉' });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '武汉C++实习招聘信息');
  assert.equal(items[0].url, 'https://www.zhipin.com/zhaopin/demo/');
  assert.equal(items[0].salary, '200-250元/天');
});

test('受风控平台索引：URL 质量门槛排除聚合页', () => {
  const platform = { id: 'boss', label: 'BOSS直聘', domain: 'zhipin.com', requiredUrlParts: ['zhipin.com/job_detail/'] };
  const items = parseIndexedSearchHtml(INDEX_SEARCH_HTML, platform, { keyword: 'C++ 实习', city: '武汉' });
  assert.equal(items.length, 0);
});

test('前程无忧公开列表：提取职位、公司、城市、学历和官网详情链接', () => {
  const [job] = parse51JobListPage(JOB51_LIST, { keyword: 'C/C++', city: '武汉' });
  assert.equal(job.title, '决策规划开发实习生');
  assert.equal(job.company, '东风悦享科技');
  assert.equal(job.city, '武汉·蔡甸区');
  assert.equal(job.education, '本科');
  assert.equal(job.url, 'https://jobs.51job.com/wuhan-cdq/166095617.html');
  assert.ok(job.tags.includes('C++'));
});

test('猎聘公开列表：提取职位卡和详情链接', () => {
  const [job] = parseLiepinListPage(LIEPIN_LIST, { keyword: '计算机开发实习生', city: '武汉' });
  assert.equal(job.title, 'C++开发实习生');
  assert.equal(job.company, '示例科技');
  assert.equal(job.city, '武汉-流芳');
  assert.equal(job.education, '本科');
  assert.equal(job.salary, '3-4k');
});

test('受风控平台详情：优先解析 JobPosting JSON-LD', () => {
  const detail = parseIndexedDetailPage(INDEX_DETAIL, { sourceLabel: 'BOSS直聘', city: '武汉' });
  assert.equal(detail.title, 'C++开发实习生');
  assert.equal(detail.company, '示例科技');
  assert.equal(detail.city, '湖北·武汉');
  assert.equal(detail.education, '本科');
  assert.match(detail.salary, /180-250 CNY DAY/);
  assert.match(detail.description, /Socket/);
  assert.equal(detail.structuredDetail, true);
});

test('受风控平台详情：识别安全验证页，不把验证码当职位内容', () => {
  assert.equal(isChallengePage('<html><title>安全验证</title><body>请完成滑动验证码</body></html>'), true);
  assert.equal(isChallengePage(INDEX_DETAIL), false);
});

test('详情富化预算在多个来源间轮询分配', () => {
  const jobs = [
    { source: 'zhaopin', id: 'z1', score: 10 }, { source: 'zhaopin', id: 'z2', score: 9 },
    { source: 'shixiseng', id: 's1', score: 8 }, { source: 'boss', id: 'b1', score: 7 },
    { source: 'job51', id: 'j1', score: 6 }, { source: 'liepin', id: 'l1', score: 5 },
  ];
  const selected = chooseEnrichmentCandidates(jobs, 5, (job) => job.score);
  assert.deepEqual(new Set(selected.map((job) => job.source)), new Set(['zhaopin', 'shixiseng', 'boss', 'job51', 'liepin']));
});

test('硬性排除：纯前端 / 销售 / 多年经验', () => {
  assert.match(hardExcluded({ title: 'Web前端开发实习生', description: '' }, keywords), /前端/);
  assert.match(hardExcluded({ title: '销售管培生', description: '' }, keywords), /销售/);
  assert.match(hardExcluded({ title: 'C++开发工程师', description: '要求5年以上工作经验' }, keywords), /年以上经验/);
  assert.match(hardExcluded({ title: 'C++开发工程师（要求1年以上工作经验）', description: '熟悉Linux C++' }, keywords), /1 年以上经验/);
  assert.equal(hardExcluded({ title: 'Python后端开发工程师', description: '熟悉C++和Linux' }, keywords), '');
  assert.match(
    hardExcluded({ title: 'C++开发实习生', description: '要求985/211或双一流院校，硕士及以上学历，熟悉Linux网络编程' }, keywords),
    /普通一本不匹配/
  );
  assert.equal(
    hardExcluded({ title: 'C++开发实习生', description: '不限制985/211，普通本科可投，熟悉Socket网络编程' }, keywords),
    ''
  );
  assert.equal(hardExcluded({ title: 'C++开发实习生', description: '熟悉Socket网络编程' }, keywords), '');
});

test('打分：标题非 C++ 时根据正文主体是否为 C++ 决定是否保留', () => {
  const weak = scoreJob(normalizeJob({
    source: 'zhaopin',
    title: 'Python后端开发工程师',
    company: '武汉某科技',
    city: '武汉',
    companyMeta: ['民营', '20-99人'],
    description: '职位描述 熟悉 Python Web 开发，了解 C++ 和 Linux 加分。',
    url: 'https://example.com/job/python-weak',
  }), profile, keywords);
  assert.equal(weak.tier, '观察');

  const mainCxxOnly = scoreJob(normalizeJob({
    source: 'zhaopin',
    title: 'Python后端开发工程师',
    company: '武汉某科技',
    city: '武汉',
    education: '本科及以上',
    companyMeta: ['民营', '20-99人'],
    description: '职位描述 核心业务使用 C++ 开发，参与工具模块研发，要求熟悉 C++ 语言和数据结构，本科及以上学历，2028届亦可。',
    url: 'https://example.com/job/python-main-cpp',
  }), profile, keywords);
  assert.equal(mainCxxOnly.tier, '长期备选');
  assert.match(mainCxxOnly.whyWorth, /标题主语言非 C\+\+，但 JD 主体是 C\+\+ 开发/);

  const strong = scoreJob(normalizeJob({
    source: 'zhaopin',
    title: 'Python后端开发工程师',
    company: '武汉某科技',
    city: '武汉',
    education: '本科及以上',
    companyMeta: ['民营', '20-99人'],
    description: '职位描述 核心模块使用 C++ 开发，负责 Linux 服务端开发，要求熟悉 Socket 网络编程、epoll、多线程、TCP/IP，本科及以上学历，2028届亦可。',
    url: 'https://example.com/job/python-strong-cpp',
  }), profile, keywords);
  assert.equal(strong.tier, '长期备选');
  assert.match(strong.whyWorth, /标题主语言非 C\+\+，但 JD 主体是 C\+\+ 开发/);
});

test('打分：武汉 + C++/Socket/epoll + 本科友好 → 优先投', () => {
  const job = normalizeJob({
    source: 'zhaopin',
    title: 'C++服务端开发实习生',
    company: '武汉某科技',
    city: '武汉·洪山',
    education: '本科及以上',
    months: '3个月',
    daysPerWeek: '3天',
    companyMeta: ['民营', '100-499人', '软件/IT服务'],
    description: '职位描述 负责Linux服务端开发，熟悉Socket网络编程、epoll、多线程、TCP/IP，本科及以上学历，2028届亦可，每周实习3天。',
    url: 'https://example.com/job/1',
  });
  const scored = scoreJob(job, profile, keywords);
  assert.equal(scored.locationTier, '武汉');
  assert.equal(scored.tier, '优先投');
  assert.ok(scored.score >= 22, `score=${scored.score}`);
  assert.ok(scored.matchPoints.includes('Socket 网络编程'));
  assert.ok(scored.gaps.length >= 1 && scored.gaps.length <= 3);
  assert.match(scored.whyWorth, /武汉/);
});

test('打分：985/211 + 硕士门槛 → 冲刺并标注门槛', () => {
  const job = normalizeJob({
    source: 'zhaopin',
    title: 'C++后端开发实习生',
    company: '某大厂',
    city: '北京',
    education: '硕士',
    description: '职位描述 负责网络编程与Linux服务端开发，epoll/多线程，要求985/211院校硕士及以上学历。',
    url: 'https://example.com/job/2',
  });
  const scored = scoreJob(job, profile, keywords);
  assert.equal(scored.tier, '冲刺');
  assert.match(scored.schoolGate, /门槛偏高/);
});

test('打分：6 个月 + 每周 3 天 → 标记与寒假计划冲突', () => {
  const job = normalizeJob({
    source: 'shixiseng',
    title: 'C++实习生',
    company: '武汉某公司',
    city: '武汉',
    degree: '本科',
    months: '6个月',
    daysPerWeek: '3天/周',
    description: 'Linux socket 多线程 网络编程',
    url: 'https://example.com/job/3',
  });
  const scored = scoreJob(job, profile, keywords);
  assert.equal(scored.durationConflict, true);
  assert.match(scored.durationNote, /长期/);
});

test('跨平台去重：同公司同岗位合并', () => {
  const a = scoreJob(normalizeJob({ source: 'zhaopin', title: 'C++开发实习生', company: '中望软件', city: '武汉', url: 'https://a/1', description: 'C++ Linux' }), profile, keywords);
  const b = scoreJob(normalizeJob({ source: 'shixiseng', title: 'C++开发实习生', company: '中望软件', city: '武汉', url: 'https://b/2', description: 'C++ Linux socket 多线程' }), profile, keywords);
  const merged = dedupeJobs([a, b]);
  assert.equal(merged.length, 1);
  assert.ok((merged[0].altSources || []).length === 1);
});

test('排序：武汉优先于同分其他城市', () => {
  const wh = scoreJob(normalizeJob({ source: 'zhaopin', title: 'C++开发实习生', company: 'A', city: '武汉', description: 'C++ socket', url: 'u1' }), profile, keywords);
  const bj = scoreJob(normalizeJob({ source: 'zhaopin', title: 'C++开发实习生', company: 'B', city: '北京', description: 'C++ socket', url: 'u2' }), profile, keywords);
  const ranked = rankJobs([bj, wh], profile);
  assert.equal(ranked[0].city, '武汉');
});

test('入选策略：优先投 + 长期备选补足到 6-10 且大厂不超过 1 个', () => {
  const mk = (tier, company, large = false) => ({ tier, company, companyType: large ? '偏大厂/大公司' : '中小/成长型', score: 20 });
  const jobs = [
    mk('优先投', '大厂P', true),
    mk('优先投', 'W1'),
    mk('优先投', 'W2'),
    mk('长期备选', 'L1'),
    mk('长期备选', 'L2'),
    mk('长期备选', 'L3'),
    mk('长期备选', '大厂L', true),
    mk('冲刺', '大厂X', true),
    mk('冲刺', 'S2'),
    mk('长期备选', 'L4'),
    mk('长期备选', 'L5'),
    mk('长期备选', 'L6'),
    mk('长期备选', 'L7'),
  ];
  const picked = selectForReport(jobs, { min: 6, target: 10 });
  assert.ok(picked.length >= 6 && picked.length <= 10);
  assert.equal(picked.filter((j) => /偏大厂/.test(j.companyType)).length, 1);
});

test('台账：标记已推送后可去重', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));
  const job = normalizeJob({ source: 'zhaopin', title: 'C++实习生', company: 'X公司', city: '武汉', url: 'https://x/1', description: 'C++' });
  const ledger = loadLedger(dir);
  assert.equal(isSeen(ledger, job), false);
  markSeen(ledger, job, { channel: 'smtp' });
  saveLedger(dir, ledger);
  const reloaded = loadLedger(dir);
  assert.equal(isSeen(reloaded, job), true);
  const { fresh, seen } = splitNewSeen([job], reloaded);
  assert.equal(fresh.length, 0);
  assert.equal(seen.length, 1);
});

test('邮件主题格式符合要求', () => {
  assert.equal(buildSubject('2026-10-02', 7), 'C++ 后端实习机会｜2026-10-02｜7 个重点岗位');
});

test('邮件正文包含全部必填字段', () => {
  const job = scoreJob(normalizeJob({
    source: 'zhaopin',
    title: 'C++开发实习生',
    company: '中望软件',
    city: '武汉·洪山',
    education: '本科',
    months: '3个月',
    daysPerWeek: '4天',
    description: 'C++ Socket Linux 多线程',
    url: 'https://example.com/zw',
  }), profile, keywords);
  const { subject, text, html, briefText } = buildEmail({ jobs: [job], dateStr: '2026-10-02', profile });
  assert.match(subject, /^C\+\+ 后端实习机会｜2026-10-02｜1 个重点岗位$/);
  for (const field of ['地点', '链接', '学历/届次', '实习时长/每周到岗', '核心技术要求', '匹配点', '需补强', '学校/学历门槛', '为什么值得关注']) {
    assert.ok(text.includes(field), `text 缺少字段 ${field}`);
    assert.ok(html.includes(field), `html 缺少字段 ${field}`);
  }
  assert.ok(briefText.includes('核心要求'));
  assert.ok(briefText.includes('https://example.com/zw'));
});

test('MIME 报文：中文主题编码 + 结构完整', () => {
  const raw = buildRawMessage({ from: 'a@gmail.com', fromName: '雷达', to: 'b@gmail.com', subject: 'C++ 后端实习机会｜2026-10-02｜1 个重点岗位', text: '纯文本', html: '<p>HTML</p>' });
  assert.match(raw, /^From: =\?UTF-8\?B\?/m);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary=/);
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(raw, /Content-Type: text\/html; charset=UTF-8/);
});

test('SMTP 邮箱规范化：Gmail 用户名补全，空白和尖括号被清理', () => {
  assert.equal(normalizeMailbox('  example  ', { gmailDefault: true }), 'example@gmail.com');
  assert.equal(normalizeMailbox('Example <example@gmail.com>'), 'example@gmail.com');
  assert.throws(() => normalizeMailbox('not-an-email'), /格式无效/);
  const raw = buildRawMessage({ from: ' example ', fromName: '雷达', to: ' target@example.com ', subject: '测试', text: '文本', html: '<p>HTML</p>' });
  assert.match(raw, /^From: =\?UTF-8\?B\?.* <example@gmail\.com>$/m);
  assert.match(raw, /^To: <target@example\.com>$/m);
});

test('北京时间换算（UTC 环境）', () => {
  const utcMidnight = new Date('2026-10-02T00:30:00Z');
  assert.equal(beijingDateString(utcMidnight), '2026-10-02');
  assert.match(beijingStamp(utcMidnight), /^2026-10-02-0830\d\d$/);
});

test('命令行参数解析', () => {
  const args = parseArgs(['--task', 'scan', '--limit', '8', '--min', '6', '--no-mail', '--dry-run']);
  assert.equal(args.task, 'scan');
  assert.equal(args.limit, 8);
  assert.equal(args.min, 6);
  assert.equal(args.mail, false);
  assert.equal(args.dryRun, true);
});

test('预筛选：无关岗位（如少儿编程老师）被挡在详情请求之前', () => {
  const jobs = [
    normalizeJob({ source: 'zhaopin', title: 'C++开发实习生', company: 'A', city: '武汉', description: '' }),
    normalizeJob({ source: 'zhaopin', title: '少儿编程老师（接受无经验/C++）', company: 'B', city: '武汉', description: '' }),
  ];
  const kept = preFilter(jobs, keywords);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'C++开发实习生');
});

test('岗位指纹稳定且区分公司', () => {
  const a = jobIdentity({ company: 'A公司', title: 'C++实习生', city: '武汉' });
  const b = jobIdentity({ company: 'A公司', title: 'C++实习生', city: '武汉' });
  const c = jobIdentity({ company: 'B公司', title: 'C++实习生', city: '武汉' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('命令行参数解析：--curated / --curated-only', () => {
  const args = parseArgs(['--task', 'scan', '--curated', 'data/round-2026-10-02.json', '--curated-only']);
  assert.equal(args.curatedOnly, true);
  assert.ok(args.curated.endsWith(path.join('data', 'round-2026-10-02.json')));
});

// Regression: the reply reader used to push every line into its queue *and* resolve a waiting
// reader, so each reply was handed out twice and every command read the previous response —
// Gmail answered EHLO with the stale "220 ... - gsmtp" greeting and no mail was ever sent.
test('SMTP：每行应答只投递给一个消费者，且读应答不写socket', async () => {
  const { EventEmitter } = await import('node:events');
  const { SmtpSession } = await import('../src/mail/smtp.js');
  class FakeSocket extends EventEmitter {
    setEncoding() {}
    write() {
      this.writes = (this.writes || 0) + 1;
    }
  }
  const sock = new FakeSocket();
  const session = new SmtpSession(sock, () => {});

  const greeting = session.nextLine(1000); // a reader is already waiting when data arrives
  sock.emit('data', '220 smtp.gmail.com ESMTP ready\r\n');
  assert.equal(await greeting, '220 smtp.gmail.com ESMTP ready');

  const writesBefore = sock.writes || 0;
  const ehlo = session.readReply([250], 1000);
  sock.emit('data', '250-smtp.gmail.com at your service\r\n250-SIZE 35882577\r\n250 SMTPUTF8\r\n');
  const reply = await ehlo;
  assert.equal(reply.code, 250, '第二条命令必须读到自己的应答，而不是重读问候语');
  assert.equal(reply.lines.length, 3, '多行应答应完整收集');
  assert.equal(sock.writes || 0, writesBefore, 'readReply 只读不写（DATA 后多发空行会造成错位）');
});

test('SMTP：数据行与应答在同一块里到达也不会错位', async () => {
  const { EventEmitter } = await import('node:events');
  const { SmtpSession } = await import('../src/mail/smtp.js');
  class FakeSocket extends EventEmitter {
    setEncoding() {}
    write() {}
  }
  const sock = new FakeSocket();
  const session = new SmtpSession(sock, () => {});
  // Both replies arrive in one TCP chunk before anyone has asked for the second one.
  sock.emit('data', '220 greeting\r\n250 first ok\r\n');
  assert.equal(await session.nextLine(1000), '220 greeting');
  assert.equal(await session.nextLine(1000), '250 first ok');
});

test('--curated-only：一次网络请求都不发，清单直接进入报告与邮件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-curated-'));
  let fetches = 0;
  const res = await runScan(
    {
      ...parseArgs([
        '--task', 'scan',
        '--curated', path.join(ROOT, 'data', 'round-2026-10-02.json'),
        '--curated-only',
        '--no-mail',
      ]),
      root: dir,
      outDir: path.join(dir, 'output'),
    },
    {
      log: () => {},
      fetchImpl: () => {
        fetches += 1;
        throw new Error('清单模式不应发起网络请求');
      },
    }
  );
  assert.equal(fetches, 0, '`--curated-only` 不得触碰网络');
  assert.ok(res.selected.length >= 6 && res.selected.length <= 10, `入选数量应在 6-10，实际 ${res.selected.length}`);
  const report = JSON.parse(fs.readFileSync(res.report.jsonPath, 'utf8'));
  assert.equal(report.selectedCount, res.selected.length);
  assert.equal(report.collectedCount, res.selected.length);
  assert.equal(report.errors.length, 0);
  assert.equal(report.mail, null);
  assert.match(res.composed.subject, /^C\+\+ 后端实习机会｜\d{4}-\d{2}-\d{2}｜\d+ 个重点岗位$/);
});

test('--curated-only 缺少 --curated 时明确报错', async () => {
  await assert.rejects(
    () => runScan({ ...parseArgs(['--task', 'scan', '--curated-only', '--no-mail']), root: os.tmpdir() }, { log: () => {} }),
    /--curated-only 必须与 --curated/
  );
});

