// BOSS直聘、前程无忧、猎聘的公开职位发现器。
//
// 这些站点的搜索页会随地区、登录状态和风控策略切换为动态渲染或验证页，
// GitHub Actions 的机房 IP 直接请求并不稳定。这里不绕过验证码，而是使用搜狗
// 的公开搜索索引发现官网链接，再尽力读取官网详情页中的 JobPosting JSON-LD。
// 详情页被拦截时仍保留搜索摘要，让本轮扫描可以继续而不是整批失败。
import { absoluteUrl, decodeEntities, fetchText, sleep, stripTags } from '../lib/http.js';

const SOGOU = 'https://www.sogou.com/web';
const CHALLENGE_RE = /安全验证|访问过于频繁|异常访问|请完成验证|滑动验证|验证码|captcha|verify you are human|登录后查看/i;

export function buildIndexSearchUrl(query, count = 12) {
  const url = new URL(SOGOU);
  url.searchParams.set('query', query);
  url.searchParams.set('num', String(Math.min(20, Math.max(1, count))));
  return url.toString();
}

function xmlValue(block, tag) {
  const match = String(block).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return '';
  return decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

function cleanTitle(value, label = '') {
  let title = stripTags(value || '').replace(/[「」【】]/g, '').trim();
  if (label) title = title.replace(new RegExp(`(?:[-_|｜—]\\s*)?${escapeRegExp(label)}(?:招聘网)?$`, 'i'), '').trim();
  return title;
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|from|source|track|spm|u_asig|u_atoken|t$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().replace(/\?$/, '');
  } catch {
    return raw;
  }
}

function hostAllowed(raw, domain) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function urlAllowed(raw, platform) {
  if (!hostAllowed(raw, platform.domain)) return false;
  return (platform.requiredUrlParts || []).every((part) => String(raw).includes(part));
}

function guessCity(text, fallback = '') {
  const match = String(text).match(/武汉|北京|上海|深圳|广州|杭州|南京|成都|重庆|西安|苏州|长沙|合肥|厦门|远程/);
  return match?.[0] || fallback;
}

function guessSalary(text) {
  return (String(text).match(/(?:\d+(?:\.\d+)?\s*[-–—~至]\s*)?\d+(?:\.\d+)?\s*(?:元\/天|元／天|K|k|千|万)(?:·\d+薪|\/月|\/年)?/) || [])[0] || '';
}

/** Parse Bing RSS and retain only links that really belong to the requested platform. */
export function parseIndexedRss(xml, platform, meta = {}) {
  const items = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items
    .map((block) => {
      const url = canonicalUrl(xmlValue(block, 'link'));
      const summary = stripTags(xmlValue(block, 'description'));
      const title = cleanTitle(xmlValue(block, 'title'), platform.label);
      const haystack = `${title} ${summary}`;
      return {
        source: platform.id,
        sourceLabel: platform.label,
        title,
        url,
        company: `${platform.label}公开职位`,
        city: guessCity(haystack, meta.city || ''),
        salary: guessSalary(haystack),
        description: summary.slice(0, 1200),
        tags: [meta.keyword || '', meta.city || '', '搜索索引'].filter(Boolean),
        query: meta.keyword || '',
        queryCity: meta.city || '',
        publishOrUpdateDate: xmlValue(block, 'pubDate'),
        collectedAt: meta.collectedAt || new Date().toISOString(),
        indexedDiscovery: true,
      };
    })
    .filter((item) => item.title && item.url && urlAllowed(item.url, platform));
}

function decodeUrlComponent(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Parse Sogou's public result cards. data-url is the target canonical URL, not a redirect. */
export function parseIndexedSearchHtml(html, platform, meta = {}) {
  const source = String(html);
  const items = [];
  const seen = new Set();
  const pattern = /data-url=["'](https?:\/\/[^"']+)["'][^>]{0,1200}?data-title=["']([^"']*)["']/gi;
  for (const match of source.matchAll(pattern)) {
    const url = canonicalUrl(decodeEntities(match[1]));
    if (!urlAllowed(url, platform) || seen.has(url)) continue;
    seen.add(url);
    const before = source.slice(Math.max(0, match.index - 5000), match.index);
    const summaries = [...before.matchAll(/class=["'][^"']*(?:fz-mid|text-layout)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)];
    const summary = stripTags(summaries.at(-1)?.[1] || '');
    const title = cleanTitle(decodeUrlComponent(decodeEntities(match[2])), platform.label);
    const haystack = `${title} ${summary}`;
    items.push({
      source: platform.id,
      sourceLabel: platform.label,
      title,
      url,
      company: `${platform.label}公开职位`,
      city: guessCity(haystack, meta.city || ''),
      salary: guessSalary(haystack),
      description: summary.slice(0, 1200),
      tags: [meta.keyword || '', meta.city || '', '搜索索引'].filter(Boolean),
      query: meta.keyword || '',
      queryCity: meta.city || '',
      collectedAt: meta.collectedAt || new Date().toISOString(),
      indexedDiscovery: true,
    });
  }
  return items;
}

function classValue(chunk, className, tag = '[a-z0-9]+') {
  const match = String(chunk).match(new RegExp(`<${tag}[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return stripTags(match?.[1] || '');
}

/** Parse the public 前程无忧职场文库 list (it links to canonical jobs.51job.com details). */
export function parse51JobListPage(html, meta = {}) {
  const chunks = String(html).split(/<div[^>]*class=["'][^"']*\be\s+on\b[^"']*["'][^>]*name=["']check_div["'][^>]*>/i).slice(1);
  const out = [];
  for (const chunk of chunks) {
    const jobLink = (chunk.match(/<a[^>]*class=["'][^"']*\bel\b[^"']*["'][^>]*href=["']([^"']+)["']/i)
      || chunk.match(/<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bel\b/i) || [])[1];
    const title = classValue(chunk, 'jname', 'span');
    if (!jobLink || !title) continue;
    const info = classValue(chunk, 'd', 'span');
    const infoParts = info.split('|').map((value) => value.trim());
    const company = classValue(chunk, 'cname', 'a');
    const companyMeta = [classValue(chunk, 'dc', 'p'), classValue(chunk, 'int', 'p')].filter(Boolean);
    const tagsBlock = (chunk.match(/<p[^>]*class=["'][^"']*\btags\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    const tags = [...tagsBlock.matchAll(/<i[^>]*>([\s\S]*?)<\/i>/gi)].map((match) => stripTags(match[1])).filter(Boolean);
    out.push({
      source: 'job51',
      sourceLabel: '前程无忧',
      title,
      url: canonicalUrl(absoluteUrl(jobLink, meta.url || 'https://wenku.51job.com/')),
      company,
      city: infoParts[0] || meta.city || '',
      experience: infoParts[1] || '',
      education: infoParts[2] || '',
      salary: classValue(chunk, 'sal', 'span'),
      tags,
      companyMeta,
      publishOrUpdateDate: classValue(chunk, 'time', 'span'),
      query: meta.keyword || '',
      queryCity: meta.city || '',
      collectedAt: meta.collectedAt || new Date().toISOString(),
      indexedDiscovery: false,
      publicLandingPage: true,
    });
  }
  return out;
}

/** Parse 猎聘's public SEO landing-page cards. */
export function parseLiepinListPage(html, meta = {}) {
  const chunks = String(html).split(/<div[^>]*class=["'][^"']*\bjob-list-item\b[^"']*["'][^>]*>/i).slice(1);
  const out = [];
  for (const chunk of chunks) {
    const jobLink = (chunk.match(/href=["'](https?:\/\/www\.liepin\.com\/job\/\d+\.shtml[^"']*)["']/i) || [])[1];
    const title = decodeEntities((chunk.match(/<div[^>]*title=["']([^"']+)["'][^>]*class=["'][^"']*ellipsis-1[^"']*["']/i) || [])[1] || '');
    if (!jobLink || !title) continue;
    const cityBlock = (chunk.match(/class=["'][^"']*job-dq-box[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
    const labelBlock = (chunk.match(/class=["'][^"']*job-labels-box[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
    const labels = [...labelBlock.matchAll(/class=["'][^"']*labels-tag[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map((match) => stripTags(match[1])).filter(Boolean);
    const company = classValue(chunk, 'company-name', 'span');
    const companyBlock = (chunk.match(/class=["'][^"']*company-tags-box[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
    const companyMeta = [...companyBlock.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((match) => stripTags(match[1])).filter(Boolean);
    out.push({
      source: 'liepin',
      sourceLabel: '猎聘',
      title: stripTags(title),
      url: canonicalUrl(jobLink),
      company,
      city: stripTags(cityBlock).replace(/[【】]/g, '').trim(),
      experience: labels.find((label) => /经验|年/.test(label)) || '',
      education: labels.find((label) => /本科|硕士|博士|大专|学历不限/.test(label)) || '',
      salary: classValue(chunk, 'job-salary', 'span'),
      tags: labels,
      companyMeta,
      query: meta.keyword || '',
      queryCity: meta.city || '',
      collectedAt: meta.collectedAt || new Date().toISOString(),
      indexedDiscovery: false,
      publicLandingPage: true,
    });
  }
  return out;
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== 'object') return [];
  return [value, ...flattenJsonLd(value['@graph'] || [])];
}

function jsonLdBlocks(html) {
  const values = [];
  for (const match of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      values.push(...flattenJsonLd(JSON.parse(decodeEntities(match[1]).trim())));
    } catch {
      // A malformed optional JSON-LD block must not discard the usable page metadata.
    }
  }
  return values;
}

function hasType(value, expected) {
  const types = Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']];
  return types.some((type) => String(type).toLowerCase() === expected.toLowerCase());
}

function addressText(location) {
  const locations = Array.isArray(location) ? location : [location];
  return locations
    .map((entry) => {
      const address = entry?.address || entry;
      if (typeof address === 'string') return address;
      return [address?.addressRegion, address?.addressLocality, address?.streetAddress].filter(Boolean).join('·');
    })
    .filter(Boolean)
    .join(' / ');
}

function salaryText(baseSalary) {
  if (!baseSalary) return '';
  if (typeof baseSalary === 'string') return baseSalary;
  const value = baseSalary.value || baseSalary;
  const min = value.minValue ?? value.value;
  const max = value.maxValue;
  const amount = min == null ? '' : max == null || max === min ? String(min) : `${min}-${max}`;
  const unit = value.unitText || baseSalary.unitText || '';
  const currency = baseSalary.currency || '';
  return [amount, currency, unit].filter(Boolean).join(' ');
}

function metaContent(html, key, attr = 'name') {
  const escaped = escapeRegExp(key);
  const a = String(html).match(new RegExp(`<meta[^>]+${attr}=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'));
  const b = String(html).match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${escaped}["'][^>]*>`, 'i'));
  return decodeEntities((a || b || [])[1] || '');
}

export function isChallengePage(html) {
  const preview = stripTags(String(html)).slice(0, 2500);
  return CHALLENGE_RE.test(preview);
}

/** Extract schema.org JobPosting when present, with OpenGraph/meta fallbacks. */
export function parseIndexedDetailPage(html, item = {}) {
  const postings = jsonLdBlocks(html).filter((value) => hasType(value, 'JobPosting'));
  const job = postings[0] || {};
  const htmlTitle = decodeEntities((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const metaDescription = metaContent(html, 'description') || metaContent(html, 'og:description', 'property');
  const description = stripTags(job.description || metaDescription || item.description || '').slice(0, 5000);
  const organisation = job.hiringOrganization || {};
  const education = typeof job.educationRequirements === 'string'
    ? job.educationRequirements
    : job.educationRequirements?.credentialCategory || '';
  const location = addressText(job.jobLocation);
  return {
    title: cleanTitle(job.title || metaContent(html, 'og:title', 'property') || htmlTitle || item.title, item.sourceLabel),
    company: stripTags(organisation.name || item.company || ''),
    companyUrl: organisation.sameAs ? absoluteUrl(organisation.sameAs, item.url) : item.companyUrl || '',
    city: location || guessCity(`${description} ${htmlTitle}`, item.city || ''),
    location: location || item.location || '',
    salary: salaryText(job.baseSalary) || item.salary || '',
    education: stripTags(education || item.education || ''),
    description,
    publishOrUpdateDate: job.datePosted || item.publishOrUpdateDate || '',
    deadline: job.validThrough || item.deadline || '',
    employmentType: Array.isArray(job.employmentType) ? job.employmentType.join('/') : job.employmentType || '',
    detailFetched: true,
    structuredDetail: postings.length > 0,
  };
}

export async function collectIndexedPlatforms(config, options = {}) {
  if (!config?.enabled) return [];
  const {
    fetchImpl,
    log = () => {},
    timeoutMs = 20000,
    delayMs = config.delayMs ?? 900,
    maxResultsPerQuery = config.maxResultsPerQuery ?? 12,
  } = options;
  const out = [];
  for (const platform of config.platforms || []) {
    if (platform.enabled === false) continue;
    for (const landing of platform.landingPages || []) {
      try {
        const { text } = await fetchText(landing.url, {
          fetchImpl,
          timeoutMs,
          retries: 1,
          label: `landing:${platform.id}:${landing.city || '全国'}`,
        });
        const meta = { ...landing, collectedAt: new Date().toISOString() };
        const items = landing.parser === '51job'
          ? parse51JobListPage(text, meta)
          : landing.parser === 'liepin'
            ? parseLiepinListPage(text, meta)
            : [];
        log(`  [${platform.label}·公开列表] ${landing.keyword || '职位'} @ ${landing.city || '全国'} → ${items.length} 条`);
        out.push(...items);
      } catch (error) {
        log(`  [${platform.label}·公开列表] ${landing.city || '全国'} 采集失败：${error.message}`);
      }
      if (delayMs) await sleep(delayMs);
    }
    for (const query of platform.queries || []) {
      const keyword = typeof query === 'string' ? query : query.keyword;
      const city = typeof query === 'string' ? '' : query.city || '';
      const siteQuery = platform.siteQuery || `site:${platform.domain}`;
      const searchQuery = `${siteQuery} "${keyword}" ${city}`.trim();
      try {
        const { text } = await fetchText(buildIndexSearchUrl(searchQuery, maxResultsPerQuery), {
          fetchImpl,
          timeoutMs,
          retries: 1,
          label: `index:${platform.id}:${keyword}/${city || '全国'}`,
        });
        const items = parseIndexedSearchHtml(text, platform, { keyword, city, collectedAt: new Date().toISOString() });
        log(`  [${platform.label}·索引] ${keyword} @ ${city || '全国'} → ${items.length} 条`);
        out.push(...items);
      } catch (error) {
        log(`  [${platform.label}·索引] ${keyword} @ ${city || '全国'} 发现失败：${error.message}`);
      }
      if (delayMs) await sleep(delayMs);
    }
  }
  return out;
}

export async function enrichIndexedPlatformDetail(item, options = {}) {
  const { fetchImpl, timeoutMs = 20000 } = options;
  if (!item.url) return item;
  try {
    const { text, url } = await fetchText(item.url, {
      fetchImpl,
      timeoutMs,
      retries: 0,
      label: `${item.source}-detail:${item.title}`,
    });
    if (isChallengePage(text)) {
      return { ...item, detailFetched: false, detailBlocked: true, detailError: '官网返回登录或安全验证页，已保留搜索索引摘要' };
    }
    return { ...item, ...parseIndexedDetailPage(text, item), url: canonicalUrl(url || item.url) };
  } catch (error) {
    return { ...item, detailFetched: false, detailError: error.message };
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

