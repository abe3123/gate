/**
 * VPNGate SSTP 节点检测与链式代理列表生成
 * 运行平台：Cloudflare Pages / Cloudflare Worker
 * 核心特性：
 *   1. ⚡ 默认免检测极速模式：动态北京时间戳 Token 防缓存，秒级聚合 80+ 节点。
 *   2. 🏡 智能启发式网络识别：支持自动识别家庭宽带（住宅 IP）与数据中心机房。
 *   3. 🌐 自动轮询绑定 Cloudflare Anycast 全球 CDN 优选入口池。
 *   4. 🎯 支持多参数定制导出：?type=residential、?country=JP、?limit=30 等。
 *   5. 🔍 支持按需切换严格检测源 (?mode=check)。
 */

// 默认配置
const DEFAULT_CHECK_WORKER = "https://check.socks5.cmliussss.net/check?sstp=vpn:vpn@";
const DEFAULT_VPNGATE_API = "http://www.vpngate.net/api/iphone/";
const DEFAULT_VPNGATE_MIRRORS = [
  "https://cdn.jsdelivr.net/gh/fdciabdul/Vpngate-Scraper-API@main/json/data.json",
  "https://raw.githubusercontent.com/fdciabdul/Vpngate-Scraper-API/main/json/data.json"
];
const DEFAULT_THIRD_PARTY_SSTP = "https://sub.cmliussss.net/vpngate";
const DEFAULT_OPTIMAL_APIS = [
  "https://cdn.jsdelivr.net/gh/cmliu/WorkerVless2sub@main/addressesapi.txt",
  "https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesapi.txt"
];
const CACHE_TTL_SECONDS = 1800; // 30 分钟缓存
const MAX_NODES_TO_CHECK = 20; // 限制并发检测节点数，避免超出 Cloudflare 免费版 50 次子请求上限

// 静态 Cloudflare Anycast 优选入口池
const DEFAULT_EDGE_HOSTS = [
  "saas.sin.fan:443", "cdn.204910.best:443", "www.mfyx.cn:443", "p.etime.vip:443",
  "cdn.ctn32.us.kg:443", "cf.877774.xyz:443", "spring.io:443", "cf.nyanya.moe:443",
  "www.sloomb.com:443", "op.chinwa.eu.cc:443", "www.leics.police.uk:443", "securecircle.com:443",
  "www.shopify.com:443", "www.carousell.sg:443", "www.dbs.com.sg:443", "openai.com:443",
  "linear.app:443", "www.bilibili.com:443", "uspto.gov:443", "www.vmware.com:443",
  "time.is:443", "download.visualstudio.microsoft.com:443", "images.unsplash.com:443"
];

const DATA_CENTER_KEYWORDS = [
  "GOOGLE", "AMAZON", "AWS", "MICROSOFT", "OVH", "HETZNER", "DIGITALOCEAN",
  "AKAMAI", "CLOUDFLARE", "FASTLY", "RACKSPACE", "EQUINIX", "LINODE", "VULTR",
  "HURRICANE", "TENCENT", "ALIBABA", "ALIYUN", "LEASWEB", "CHOOPA", "DATACAMP"
];

const RESIDENTIAL_KEYWORDS = [
  "NTT EAST", "NTT WEST", "NTT COMMUNICATIONS", "NTT BROADBAND", "KDDI", "DOCOMO",
  "SOFTBANK", "AU COMMUNICATIONS", "J:COM", "JCOM", "OCN", "BIGLOBE",
  "IIJ", "SEIKO", "CLEVER-NET", "AT&T", "COMCAST", "XFINITY", "VERIZON",
  "TELUS", "ROGERS", "BELL CANADA", "VODAFONE", "ORANGE", "DEUTSCHE TELEKOM",
  "BREEZE", "TIM S.P.A", "LIBERO", "FASTWEB", "FREE FRANCE", "BT OPEN"
];

const COUNTRY_ZH = {
  "JP": "日本", "KR": "韩国", "US": "美国", "CA": "加拿大", "RU": "俄罗斯",
  "RO": "罗马尼亚", "TH": "泰国", "VN": "越南", "DE": "德国", "FR": "法国",
  "GB": "英国", "UK": "英国", "SG": "新加坡", "TW": "台湾", "HK": "香港",
  "CN": "中国", "AU": "澳大利亚", "NL": "荷兰", "SE": "瑞典", "CH": "瑞士",
  "IT": "意大利", "ES": "西班牙", "PL": "波兰", "IN": "印度", "BR": "巴西",
  "MX": "墨西哥", "ID": "印尼", "MY": "马来西亚", "PH": "菲律宾"
};

// 内存缓存单例 (在同一个 Worker 边缘实例存活期间复用)
let MEMORY_CACHE_FAST = null;
let MEMORY_CACHE_CHECK = null;

function safeAtob(str) {
  try {
    return atob(str.replace(/[\r\n\s]/g, ''));
  } catch (e) {
    return "";
  }
}

function classifyHostNetwork(host) {
  if (!host) return "unknown";
  const h = host.toLowerCase();
  // 匹配 SoftEther 客户端动态 DDNS 特征 (如 vpn948322276.opengw.net, vpnv123, -res-)
  if (/^vpn\d{5,}/.test(h) || /^vpnv\d+/.test(h) || h.includes("-res-") || h.includes(".home.")) {
    return "residential";
  }
  // 匹配公开中继/服务器特征 (如 public-vpn-186.opengw.net, relay, server, vpngw)
  if (h.startsWith("public-vpn") || h.includes("relay") || h.includes("vpngw") || h.includes("server")) {
    return "datacenter";
  }
  return "unknown";
}

function detectCountryFromHost(host) {
  if (!host) return { country: "日本", code: "JP" };
  const h = host.toLowerCase();
  const rules = [
    { reg: /[-._](jp|japan)[-._]|[-._]jp$/i, country: "日本", code: "JP" },
    { reg: /[-._](kr|korea)[-._]|[-._]kr$/i, country: "韩国", code: "KR" },
    { reg: /[-._](us|usa|america)[-._]|[-._]us$/i, country: "美国", code: "US" },
    { reg: /[-._](tw|taiwan)[-._]|[-._]tw$/i, country: "台湾", code: "TW" },
    { reg: /[-._](hk|hongkong)[-._]|[-._]hk$/i, country: "香港", code: "HK" },
    { reg: /[-._](sg|singapore)[-._]|[-._]sg$/i, country: "新加坡", code: "SG" },
    { reg: /[-._](de|germany)[-._]|[-._]de$/i, country: "德国", code: "DE" },
    { reg: /[-._](uk|gb|britain)[-._]|[-._](uk|gb)$/i, country: "英国", code: "GB" },
    { reg: /[-._](fr|france)[-._]|[-._]fr$/i, country: "法国", code: "FR" },
    { reg: /[-._](ca|canada)[-._]|[-._]ca$/i, country: "加拿大", code: "CA" },
    { reg: /[-._](th|thailand)[-._]|[-._]th$/i, country: "泰国", code: "TH" },
    { reg: /[-._](vn|vietnam)[-._]|[-._]vn$/i, country: "越南", code: "VN" },
    { reg: /[-._](ru|russia)[-._]|[-._]ru$/i, country: "俄罗斯", code: "RU" },
    { reg: /[-._](au|australia)[-._]|[-._]au$/i, country: "澳大利亚", code: "AU" },
  ];
  for (const item of rules) {
    if (item.reg.test(h)) return { country: item.country, code: item.code };
  }
  return { country: "日本", code: "JP" };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(/^[#*]/, '').trim();
    if (clean.toLowerCase().startsWith('hostname')) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return [];

  const headers = lines[headerIndex].replace(/^[#*]/, '').split(',').map(h => h.trim().toLowerCase());
  const hostIdx = headers.indexOf('hostname');
  const ipIdx = headers.indexOf('ip');
  const countryLongIdx = headers.indexOf('countrylong');
  const countryShortIdx = headers.indexOf('countryshort');
  let b64Idx = headers.indexOf('openvpn_configdata_base64');
  if (b64Idx === -1) b64Idx = headers.findIndex(h => h.includes('base64'));

  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('*') || line.startsWith('#')) continue;
    const parts = line.split(',');
    if (parts.length < 7) continue;

    const host = (parts[hostIdx] || '').trim();
    const ip = (parts[ipIdx] || '').trim();
    const countryLong = (parts[countryLongIdx] || '').trim();
    const countryShort = (parts[countryShortIdx] || '').trim();
    const b64 = (parts[b64Idx !== -1 ? b64Idx : parts.length - 1] || '').trim();

    if (!host || !ip) continue;
    rows.push({
      host,
      ip,
      country_long: countryLong,
      country_code: countryShort,
      config_b64: b64
    });
  }
  return rows;
}

function parseMirrorJson(data) {
  const servers = [];
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (item && Array.isArray(item.servers)) {
      servers.push(...item.servers);
    } else if (item && typeof item === 'object') {
      servers.push(item);
    }
  }
  return servers.map(s => ({
    host: String(s.hostname || s.host || '').trim(),
    ip: String(s.ip || '').trim(),
    country_long: String(s.countrylong || s.country_long || s.country || '').trim(),
    country_code: String(s.countryshort || s.country_short || '').trim(),
    config_b64: String(s.openvpn_configdata_base64 || s.config_b64 || '').trim()
  })).filter(s => s.host && s.ip);
}

function extractSstpNodes(rows) {
  const protoTcpRegex = /^proto\s+(tcp|tcp4|tcp6)\b/m;
  const remoteRegex = /^remote\s+\S+\s+(\d+)/m;
  const nodes = [];

  for (const r of rows) {
    if (!r.config_b64) continue;
    const cfg = safeAtob(r.config_b64);
    if (!protoTcpRegex.test(cfg)) continue;

    const match = remoteRegex.exec(cfg);
    if (!match) continue;
    const port = parseInt(match[1], 10);
    if (isNaN(port) || port < 1 || port > 65535) continue;

    let host = r.host;
    if (!host.endsWith('.opengw.net')) {
      host = `${host}.opengw.net`;
    }

    nodes.push({
      host,
      port,
      ip: r.ip,
      country_long: r.country_long,
      country_code: r.country_code ? r.country_code.toUpperCase() : "JP"
    });
  }

  const seen = new Set();
  const unique = [];
  for (const n of nodes) {
    const key = `${n.host}:${n.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(n);
    }
  }
  return unique;
}

function parseSstpLines(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const nodes = [];
  const seen = new Set();
  for (const line of lines) {
    const m = line.match(/sstp:\/\/(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)/i);
    if (m) {
      const host = m[3].trim();
      const port = parseInt(m[4], 10);
      const key = `${host}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const detected = detectCountryFromHost(host);
      const residential = classifyHostNetwork(host);

      nodes.push({
        host,
        port,
        ip: host,
        country: detected.country,
        country_code: detected.code,
        residential,
        operator: "VPN Gate Community",
        latency_ms: 0,
        success: true
      });
    }
  }
  return nodes;
}

function selectCandidateNodes(nodes, maxTotal = MAX_NODES_TO_CHECK) {
  const byCountry = {};
  for (const n of nodes) {
    const c = n.country_code || "JP";
    if (!byCountry[c]) byCountry[c] = [];
    byCountry[c].push(n);
  }

  const sortedCountries = Object.keys(byCountry).sort((a, b) => byCountry[b].length - byCountry[a].length);
  const selected = [];
  let round = 0;
  while (selected.length < maxTotal) {
    let added = false;
    for (const c of sortedCountries) {
      if (selected.length >= maxTotal) break;
      if (round < byCountry[c].length) {
        selected.push(byCountry[c][round]);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return selected;
}

function classifyNetwork(orgName, host = "") {
  if (orgName) {
    const upper = orgName.toUpperCase();
    for (const kw of DATA_CENTER_KEYWORDS) {
      if (upper.includes(kw)) return "datacenter";
    }
    for (const kw of RESIDENTIAL_KEYWORDS) {
      if (upper.includes(kw)) return "residential";
    }
  }
  return classifyHostNetwork(host);
}

async function checkNode(node, checkWorkerBase) {
  const target = `${node.host}:${node.port}`;
  const testUrl = `${checkWorkerBase}${target}`;

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000); // 10s 超时
    const resp = await fetch(testUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VPNGate-Checker)" }
    });
    clearTimeout(timer);

    const latency = Date.now() - start;
    if (!resp.ok) {
      return { ...node, success: false, latency_ms: latency };
    }

    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {}

    if (!json || !json.success) {
      return { ...node, success: false, latency_ms: latency };
    }

    const exitIp = json.ip || "";
    const exitCountry = json.country || "";
    const exitOrg = json.org || json.asn || json.isp || "";
    const residential = classifyNetwork(exitOrg, node.host);

    const countryCode = exitCountry || node.country_code || "JP";
    const countryName = COUNTRY_ZH[countryCode] || node.country_long || exitCountry || node.country || "日本";

    return {
      ...node,
      success: true,
      latency_ms: latency,
      residential,
      country: countryName,
      country_code: countryCode,
      exit: {
        ip: exitIp,
        country: exitCountry,
        org: exitOrg
      },
      checked_at: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC'
    };
  } catch (err) {
    return { ...node, success: false, latency_ms: Date.now() - start, error: String(err) };
  }
}

async function fetchOptimalEndpoints(optimalApi) {
  const urls = optimalApi ? optimalApi.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_OPTIMAL_APIS;
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "curl/7.88.1" } });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const text = await resp.text();
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      const endpoints = [];
      for (const line of lines) {
        const parts = line.split('#')[0].trim().split(':');
        if (parts.length === 2 && parts[0] && parts[1]) {
          endpoints.push(`${parts[0]}:${parts[1]}`);
        } else if (parts.length === 1 && parts[0]) {
          endpoints.push(`${parts[0]}:443`);
        }
      }
      if (endpoints.length > 0) return endpoints;
    } catch (e) {}
  }
  return [];
}

function buildNodesText(data, edgeHosts, filters = {}) {
  const lines = [];
  let idx = 0;
  const targetType = (filters.type || "").toLowerCase();
  const targetCountry = (filters.country || "").toUpperCase();
  const maxLimit = filters.limit ? parseInt(filters.limit, 10) : 0;

  for (const [countryName, grp] of Object.entries(data.countries || {})) {
    const zh = countryName;
    const countryCode = (grp.code || "").toUpperCase();
    if (targetCountry && countryCode !== targetCountry && !zh.toUpperCase().includes(targetCountry)) {
      continue;
    }

    let nodes = grp.nodes || [];
    if (targetType === "residential") {
      nodes = nodes.filter(n => n.residential === "residential");
    } else if (targetType === "datacenter") {
      nodes = nodes.filter(n => n.residential !== "residential");
    }

    const resNodes = nodes.filter(n => n.residential === "residential");
    const dcNodes = nodes.filter(n => n.residential !== "residential");

    let rCount = 1;
    for (const n of resNodes) {
      if (maxLimit > 0 && lines.length >= maxLimit) break;
      const entry = edgeHosts[idx % edgeHosts.length];
      idx++;
      const numStr = String(rCount++).padStart(2, '0');
      lines.push(`${entry}#${zh}-住宅-${numStr}$sstp://vpn:vpn@${n.host}:${n.port}`);
    }

    let dCount = 1;
    for (const n of dcNodes) {
      if (maxLimit > 0 && lines.length >= maxLimit) break;
      const entry = edgeHosts[idx % edgeHosts.length];
      idx++;
      const numStr = String(dCount++).padStart(2, '0');
      lines.push(`${entry}#${zh}-机房-${numStr}$sstp://vpn:vpn@${n.host}:${n.port}`);
    }

    if (maxLimit > 0 && lines.length >= maxLimit) break;
  }

  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function getDynamicToken() {
  const beijingTime = new Date(Date.now() + 8 * 3600 * 1000);
  return beijingTime.toISOString().replace(/\D/g, '').slice(0, 14);
}

function resolveThirdPartyUrl(rawUrl) {
  const token = getDynamicToken();
  const url = rawUrl || DEFAULT_THIRD_PARTY_SSTP;
  if (/Token=[0-9]+/i.test(url)) {
    return url.replace(/Token=[0-9]+/i, `Token=${token}`);
  }
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}Token=${token}`;
}

async function runFastPipeline(env, sourceUrl = null) {
  const rawTarget = sourceUrl || env.SSTP_SOURCE || env.THIRD_PARTY_URL || DEFAULT_THIRD_PARTY_SSTP;
  const targetUrl = resolveThirdPartyUrl(rawTarget);
  let text = "";
  let source = targetUrl;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(targetUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Cloudflare-Pages)" }
    });
    clearTimeout(timer);
    if (resp.ok) {
      text = await resp.text();
    }
  } catch (e) {}

  let nodes = parseSstpLines(text);

  // 备用镜像源降级
  if (nodes.length === 0) {
    const mirrors = env.VPNGATE_MIRROR ? [env.VPNGATE_MIRROR] : DEFAULT_VPNGATE_MIRRORS;
    for (const mirror of mirrors) {
      try {
        const resp = await fetch(mirror, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (resp.ok) {
          const json = await resp.json();
          const rows = parseMirrorJson(json);
          const sstpNodes = extractSstpNodes(rows);
          nodes = sstpNodes.map(n => ({
            host: n.host,
            port: n.port,
            ip: n.ip,
            country: COUNTRY_ZH[n.country_code] || n.country_long || "日本",
            country_code: n.country_code || "JP",
            residential: classifyHostNetwork(n.host),
            operator: "VPN Gate Community",
            latency_ms: 0,
            success: true
          }));
          source = "github-mirror";
          break;
        }
      } catch (e) {}
    }
  }

  let edgeHosts = DEFAULT_EDGE_HOSTS;
  if (env.EDGE_HOSTS) {
    const custom = env.EDGE_HOSTS.split(',').map(s => s.trim()).filter(Boolean);
    if (custom.length > 0) edgeHosts = custom;
  }
  const optimalApi = env.OPTIMAL_API || "";
  const apiEndpoints = await fetchOptimalEndpoints(optimalApi);
  const combinedEdges = Array.from(new Set([...edgeHosts, ...apiEndpoints]));
  const finalEdges = combinedEdges.length > 0 ? combinedEdges : edgeHosts;

  const byCountry = {};
  for (const n of nodes) {
    const c = n.country || "日本";
    if (!byCountry[c]) {
      byCountry[c] = { code: n.country_code || "JP", count: 0, residential: 0, datacenter: 0, nodes: [] };
    }
    byCountry[c].nodes.push(n);
    byCountry[c].count++;
    if (n.residential === "residential") byCountry[c].residential++;
    else byCountry[c].datacenter++;
  }

  // 组内排序：住宅优先
  for (const c of Object.keys(byCountry)) {
    byCountry[c].nodes.sort((a, b) => {
      const aRes = a.residential === "residential" ? 0 : 1;
      const bRes = b.residential === "residential" ? 0 : 1;
      return aRes - bRes;
    });
  }

  const resCount = nodes.filter(n => n.residential === "residential").length;
  const dcCount = nodes.length - resCount;

  const stats = {
    raw_nodes: nodes.length,
    sstp_nodes: nodes.length,
    checked: 0,
    success: nodes.length,
    failed: 0,
    countries: Object.keys(byCountry).length,
    residential_est: resCount,
    datacenter_est: dcCount,
    mode: "fast (⚡ 免测极速模式 · 聚合直出)"
  };

  const data = {
    generated_at: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
    source,
    mode: "fast",
    stats,
    countries: byCountry,
    available: nodes
  };

  const nodesText = buildNodesText(data, finalEdges);

  return {
    data,
    nodesText,
    edgeHosts: finalEdges,
    timestamp: Date.now()
  };
}

async function runCheckPipeline(env, sourceUrl = null) {
  let workerUrl = (env.CHECK_WORKER || DEFAULT_CHECK_WORKER).trim();
  if (!workerUrl || workerUrl.includes("你的域名") || workerUrl.includes("YOUR_DOMAIN")) {
    workerUrl = DEFAULT_CHECK_WORKER;
  }
  if (!workerUrl.includes("?sstp=vpn:vpn@") && !workerUrl.endsWith("@")) {
    workerUrl = workerUrl.replace(/\/?$/, "/check?sstp=vpn:vpn@");
  }

  let rows = [];
  let source = "vpngate.net";
  try {
    const vpnApi = (env.VPNGATE_API || DEFAULT_VPNGATE_API).trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(vpnApi, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Cloudflare-Pages)" }
    });
    clearTimeout(timer);
    if (resp.ok) {
      const text = await resp.text();
      rows = parseCsv(text);
    }
  } catch (e) {}

  if (!rows || rows.length === 0) {
    const mirrors = env.VPNGATE_MIRROR ? [env.VPNGATE_MIRROR] : DEFAULT_VPNGATE_MIRRORS;
    for (const mirror of mirrors) {
      try {
        const resp = await fetch(mirror, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (resp.ok) {
          const json = await resp.json();
          rows = parseMirrorJson(json);
          source = "github-mirror";
          break;
        }
      } catch (e) {}
    }
  }

  const rawCount = rows.length;
  const sstpNodes = extractSstpNodes(rows);
  const sstpCount = sstpNodes.length;
  const maxCheck = env.MAX_CHECK_NODES ? parseInt(env.MAX_CHECK_NODES, 10) : MAX_NODES_TO_CHECK;
  const candidates = selectCandidateNodes(sstpNodes, maxCheck);

  const checkResults = await Promise.all(candidates.map(n => checkNode(n, workerUrl)));

  let edgeHosts = DEFAULT_EDGE_HOSTS;
  if (env.EDGE_HOSTS) {
    const custom = env.EDGE_HOSTS.split(',').map(s => s.trim()).filter(Boolean);
    if (custom.length > 0) edgeHosts = custom;
  }
  const optimalApi = env.OPTIMAL_API || "";
  const apiEndpoints = await fetchOptimalEndpoints(optimalApi);
  const combinedEdges = Array.from(new Set([...edgeHosts, ...apiEndpoints]));
  const finalEdges = combinedEdges.length > 0 ? combinedEdges : edgeHosts;

  const available = checkResults.filter(r => r.success);
  const countries = {};
  for (const n of available) {
    const c = n.country || "未知";
    if (!countries[c]) {
      countries[c] = { code: n.country_code || "?", nodes: [] };
    }
    countries[c].nodes.push(n);
  }

  const stats = {
    raw_nodes: rawCount,
    sstp_nodes: sstpCount,
    checked: checkResults.length,
    success: available.length,
    failed: checkResults.length - available.length,
    countries: Object.keys(countries).length,
    residential_est: available.filter(n => n.residential === "residential").length,
    datacenter_est: available.filter(n => n.residential === "datacenter").length,
    mode: "check (🔍 逐个 Worker 测活)"
  };

  const byCountry = {};
  for (const [name, grp] of Object.entries(countries)) {
    grp.count = grp.nodes.length;
    grp.residential = grp.nodes.filter(n => n.residential === "residential").length;
    grp.datacenter = grp.nodes.filter(n => n.residential === "datacenter").length;
    grp.nodes.sort((a, b) => {
      const aRes = a.residential === "residential" ? 0 : 1;
      const bRes = b.residential === "residential" ? 0 : 1;
      if (aRes !== bRes) return aRes - bRes;
      return (a.latency_ms || 9999) - (b.latency_ms || 9999);
    });
    byCountry[name] = grp;
  }

  const data = {
    generated_at: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
    source,
    worker: workerUrl,
    mode: "check",
    stats,
    countries: byCountry,
    available
  };

  const nodesText = buildNodesText(data, finalEdges);

  return {
    data,
    nodesText,
    edgeHosts: finalEdges,
    timestamp: Date.now()
  };
}

async function getOrUpdateData(env, forceRefresh = false, mode = "fast") {
  const isFast = mode === "fast";
  const now = Date.now();
  let mem = isFast ? MEMORY_CACHE_FAST : MEMORY_CACHE_CHECK;

  // 1. 检查内存缓存
  if (!forceRefresh && mem && (now - mem.timestamp) < CACHE_TTL_SECONDS * 1000) {
    return mem;
  }

  // 2. 检查 KV 存储
  const kvKey = isFast ? "gate_cache_fast" : "gate_cache_check";
  if (!forceRefresh && env.KV) {
    try {
      const kvVal = await env.KV.get(kvKey, "json");
      if (kvVal && kvVal.timestamp && (now - kvVal.timestamp) < CACHE_TTL_SECONDS * 1000) {
        if (isFast) MEMORY_CACHE_FAST = kvVal;
        else MEMORY_CACHE_CHECK = kvVal;
        return kvVal;
      }
    } catch (e) {}
  }

  // 3. 运行对应的流水线
  const result = isFast ? await runFastPipeline(env) : await runCheckPipeline(env);

  // 4. 更新内存与 KV
  if (isFast) MEMORY_CACHE_FAST = result;
  else MEMORY_CACHE_CHECK = result;

  if (env.KV) {
    try {
      await env.KV.put(kvKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    } catch (e) {}
  }

  return result;
}

// 内嵌前端仪表盘 HTML
const EMBEDDED_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VPN Gate · SSTP 节点看板与链式代理</title>
<style>
  :root {
    --bg: #090d16;
    --panel: #0f172a;
    --panel2: #1e293b;
    --panel-hover: #26354a;
    --border: #334155;
    --text: #f1f5f9;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --accent-glow: rgba(56, 189, 248, 0.18);
    --ok: #10b981;
    --res: #c084fc;
    --dc: #fbbf24;
    --unk: #94a3b8;
    --danger: #f43f5e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: radial-gradient(circle at top, #131d35 0%, var(--bg) 100%);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
    min-height: 100vh;
    padding: 24px 16px;
  }
  .wrap { max-width: 1140px; margin: 0 auto; }
  .header { margin-bottom: 22px; }
  .title-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  h1 { font-size: 24px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
  h1 .icon { color: var(--accent); }
  .sub { color: var(--muted); font-size: 13px; margin-top: 6px; line-height: 1.5; }
  .mode-tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .mode-tab {
    background: var(--panel2);
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all .2s;
  }
  .mode-tab:hover { color: var(--text); border-color: var(--accent); }
  .mode-tab.active { background: var(--accent-glow); border-color: var(--accent); color: var(--accent); }
  .sub-box {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 18px;
    margin-bottom: 20px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.25);
  }
  .sub-title { font-size: 13px; color: var(--muted); margin-bottom: 8px; font-weight: 600; }
  .sub-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .sub-val {
    flex: 1;
    min-width: 260px;
    background: var(--panel2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 12px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 13px;
    color: var(--accent);
    word-break: break-all;
    user-select: all;
  }
  .btn-group { display: flex; gap: 8px; }
  .btn {
    border: none;
    border-radius: 8px;
    padding: 9px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all .2s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn-primary { background: var(--accent); color: #020617; }
  .btn-primary:hover { opacity: .9; transform: translateY(-1px); }
  .btn-refresh { background: #10b981; color: #020617; }
  .btn-refresh:hover { opacity: .9; }
  .btn-refresh:disabled { opacity: .5; cursor: not-allowed; }
  .sub-filters { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; font-size: 12px; }
  .sub-filter-label { color: var(--muted); }
  .sub-chip {
    background: var(--panel2);
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    transition: all .2s;
  }
  .sub-chip:hover { color: var(--text); }
  .sub-chip.active { background: rgba(56, 189, 248, 0.15); border-color: var(--accent); color: var(--accent); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    transition: border-color .2s;
  }
  .card:hover { border-color: #475569; }
  .card .k { color: var(--muted); font-size: 12px; }
  .card .v { font-size: 24px; font-weight: 700; margin: 4px 0 2px 0; color: var(--text); }
  .card .sub-k { color: #64748b; font-size: 11px; }
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .search-box { flex: 1; min-width: 220px; position: relative; }
  .search-input {
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 12px 9px 34px;
    color: var(--text);
    font-size: 13px;
    outline: none;
    transition: border-color .2s;
  }
  .search-input:focus { border-color: var(--accent); }
  .search-icon {
    position: absolute;
    left: 11px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--muted);
    font-size: 13px;
    pointer-events: none;
  }
  .type-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill {
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    transition: all .2s;
  }
  .pill:hover { color: var(--text); border-color: #64748b; }
  .pill.on { background: var(--panel2); border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .country {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-bottom: 14px;
    overflow: hidden;
    transition: all .2s;
  }
  .country.collapsed .c-body { display: none; }
  .country.collapsed .head .toggle-arrow { transform: rotate(-90deg); }
  .country .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 18px;
    background: var(--panel2);
    font-weight: 600;
    cursor: pointer;
    user-select: none;
    gap: 8px;
  }
  .country .head:hover { background: var(--panel-hover); }
  .c-info { display: flex; align-items: center; gap: 8px; }
  .c-name { font-size: 14px; }
  .c-count { color: var(--muted); font-size: 12px; font-weight: 400; }
  .c-meta { display: flex; align-items: center; gap: 12px; }
  .c-tag { font-size: 12px; color: var(--muted); font-weight: 400; }
  .toggle-arrow { font-size: 11px; color: var(--muted); transition: transform .2s; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 14px; text-align: left; border-top: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; background: rgba(15,23,42,0.4); }
  tr:hover td { background: rgba(56, 189, 248, 0.04); }
  .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .b-res { background: rgba(192, 132, 252, 0.15); color: var(--res); border: 1px solid rgba(192, 132, 252, 0.25); }
  .b-dc { background: rgba(251, 191, 36, 0.15); color: var(--dc); border: 1px solid rgba(251, 191, 36, 0.25); }
  .b-unk { background: rgba(148, 163, 184, 0.15); color: var(--unk); border: 1px solid rgba(148, 163, 184, 0.25); }
  .lat-fast { color: var(--ok); font-weight: 600; }
  .lat-mid { color: var(--dc); font-weight: 600; }
  .lat-slow { color: var(--danger); font-weight: 600; }
  code.node-link {
    background: var(--panel2);
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    cursor: pointer;
    transition: all .2s;
    border: 1px solid transparent;
  }
  code.node-link:hover { outline: none; border-color: var(--accent); background: #26354a; color: var(--accent); }
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #1e293b;
    border: 1px solid var(--accent);
    color: var(--text);
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    opacity: 0;
    transform: translateY(15px);
    transition: all .25s ease;
    z-index: 9999;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  .footer { color: var(--muted); font-size: 12px; margin-top: 24px; text-align: center; line-height: 1.6; }
  @media (max-width: 768px) {
    th, td { padding: 8px 10px; }
    .hide-m { display: none; }
    .sub-main { flex-direction: column; align-items: stretch; }
    .btn-group { justify-content: flex-end; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="title-row">
      <h1><span class="icon">⚡</span> VPN Gate · SSTP 节点看板</h1>
    </div>
    <div class="sub">自动聚合全球 SSTP 节点，智能识别住宅宽带与机房，自动轮换绑定 Cloudflare Anycast 优选入口池</div>
  </div>

  <div class="mode-tabs">
    <button class="mode-tab active" id="tabFast" onclick="switchMode('fast')">⚡ 免检测极速源 (第三方聚合 · 80+ 节点 · 默认)</button>
    <button class="mode-tab" id="tabCheck" onclick="switchMode('check')">🔍 严格检测源 (VPNGate 测活与反查)</button>
  </div>

  <div class="sub-box">
    <div class="sub-title">edgetunnel 优选节点订阅地址（填入 edgetunnel 后台「自定义优选IP」框）：</div>
    <div class="sub-main">
      <code class="sub-val" id="nodesUrl">加载中…</code>
      <div class="btn-group">
        <button class="btn btn-primary" id="copyBtn" onclick="copyNodesUrl()">复制订阅网址</button>
        <button class="btn btn-refresh" id="refreshBtn" onclick="forceRefresh()">立即刷新</button>
      </div>
    </div>
    <div class="sub-filters">
      <span class="sub-filter-label">快捷定制参数：</span>
      <span class="sub-chip active" data-param="" onclick="setSubParam(this, '')">全部节点</span>
      <span class="sub-chip" data-param="type=residential" onclick="setSubParam(this, 'type=residential')">仅住宅家宽</span>
      <span class="sub-chip" data-param="type=datacenter" onclick="setSubParam(this, 'type=datacenter')">仅机房</span>
      <span class="sub-chip" data-param="country=JP" onclick="setSubParam(this, 'country=JP')">仅日本 (JP)</span>
      <span class="sub-chip" data-param="country=KR" onclick="setSubParam(this, 'country=KR')">仅韩国 (KR)</span>
      <span class="sub-chip" data-param="country=US" onclick="setSubParam(this, 'country=US')">仅美国 (US)</span>
    </div>
  </div>

  <div class="cards" id="cards"></div>

  <div class="toolbar">
    <div class="search-box">
      <span class="search-icon">🔍</span>
      <input type="text" class="search-input" id="searchInput" placeholder="搜索节点、IP、端口、国家、运营商..." oninput="onSearchChange(this.value)">
    </div>
    <div class="type-pills">
      <span class="pill on" data-f="all">全部类型</span>
      <span class="pill" data-f="residential">🏡 住宅宽带</span>
      <span class="pill" data-f="datacenter">🏢 数据中心</span>
      <span class="pill" data-f="unknown">❓ 未知</span>
    </div>
  </div>

  <div id="countries"></div>

  <div class="footer" id="foot">加载中…</div>
</div>

<div class="toast" id="toast"></div>

<script>
let DATA = null;
let FILTER_TYPE = "all";
let SEARCH_KEYWORD = "";
let currentMode = "fast";
let currentCustomParam = "";

function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.classList.remove("show"); }, 2200);
}

function copyText(text, label = "已复制到剪贴板") {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast(label)).catch(() => fallbackCopy(text, label));
  } else {
    fallbackCopy(text, label);
  }
}

function fallbackCopy(text, label) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    showToast(label);
  } catch (e) {
    prompt("请手动复制：", text);
  }
  document.body.removeChild(ta);
}

function initNodesUrl() {
  const base = window.location.origin + window.location.pathname.replace(/\\/(index\\.html)?$/, '').replace(/\\/$/, '');
  const params = [];
  if (currentMode === "check") params.push("mode=check");
  if (currentCustomParam) params.push(currentCustomParam);
  const q = params.length > 0 ? "?" + params.join("&") : "";
  const url = base + '/nodes.txt' + q;
  const el = document.getElementById("nodesUrl");
  if (el) el.textContent = url;
}

function setSubParam(el, param) {
  document.querySelectorAll(".sub-chip").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  currentCustomParam = param;
  initNodesUrl();
}

function copyNodesUrl() {
  const el = document.getElementById("nodesUrl");
  if (el) copyText(el.textContent, "✓ 订阅网址已复制");
}

function switchMode(m) {
  if (currentMode === m) return;
  currentMode = m;
  document.getElementById("tabFast").classList.toggle("active", m === "fast");
  document.getElementById("tabCheck").classList.toggle("active", m === "check");
  initNodesUrl();
  load();
}

function onSearchChange(val) {
  SEARCH_KEYWORD = (val || "").trim().toLowerCase();
  renderCountries();
}

function renderCards(d) {
  const s = d.stats || {};
  const isFast = d.mode === "fast" || s.checked === 0;
  const items = [
    ["最后更新", (d.generated_at || "-").replace(" UTC", ""), "UTC 边缘计算"],
    ["节点总数", s.sstp_nodes || s.raw_nodes || 0, isFast ? "第三方高可用源" : "筛选自 VPN Gate"],
    [isFast ? "工作模式" : "已检测数", isFast ? "⚡ 免测极速" : (s.checked || 0), isFast ? "零子请求消耗" : "提交测活 Worker"],
    ["可用节点", s.success || 0, isFast ? "聚合全部可用" : "测活成功 (success=true)"],
    ["覆盖国家", s.countries || 0, "全球分布区域"],
    ["住宅 / 机房", (s.residential_est || 0) + " / " + (s.datacenter_est || 0), isFast ? "启发式智能识别" : "ASN/反查判定"]
  ];
  document.getElementById("cards").innerHTML = items.map(x =>
    '<div class="card"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + '</div><div class="sub-k">' + x[2] + '</div></div>'
  ).join("");
}

function rowHtml(n) {
  let badge;
  if (n.residential === "residential") badge = '<span class="badge b-res">🏡 住宅宽带</span>';
  else if (n.residential === "datacenter") badge = '<span class="badge b-dc">🏢 机房</span>';
  else badge = '<span class="badge b-unk">❓ 未知</span>';

  const exit = n.exit ? ((n.exit.ip || "?") + " · " + (n.exit.org || n.exit.country || "")) : (n.operator || "VPN Gate Community");
  let latHtml;
  if (n.latency_ms && n.latency_ms > 0) {
    const cls = n.latency_ms < 150 ? 'lat-fast' : (n.latency_ms < 300 ? 'lat-mid' : 'lat-slow');
    latHtml = '<span class="' + cls + '">' + n.latency_ms + ' ms</span>';
  } else {
    latHtml = '<span class="lat-fast">⚡ 秒连</span>';
  }

  const sstpUri = 'sstp://vpn:vpn@' + n.host + ':' + n.port;
  return '<tr>' +
    '<td><code class="node-link" title="点击复制 SSTP 链接" onclick="copyText(\\'' + sstpUri + '\\', \\'✓ 已复制: ' + sstpUri + '\\')">' + n.host + ':' + n.port + '</code></td>' +
    '<td class="hide-m">' + (n.country_code || "-") + '</td>' +
    '<td>SSTP</td>' +
    '<td>' + latHtml + '</td>' +
    '<td class="hide-m" style="color:var(--muted)">' + exit + '</td>' +
    '<td>' + badge + '</td>' +
  '</tr>';
}

function filterNode(n) {
  if (FILTER_TYPE !== "all" && n.residential !== FILTER_TYPE) return false;
  if (!SEARCH_KEYWORD) return true;
  const kw = SEARCH_KEYWORD;
  const matchHost = (n.host || "").toLowerCase().includes(kw);
  const matchPort = String(n.port || "").includes(kw);
  const matchCountry = (n.country || "").toLowerCase().includes(kw) || (n.country_code || "").toLowerCase().includes(kw);
  const matchOrg = (n.operator || "").toLowerCase().includes(kw) || (n.exit && ((n.exit.org || "") + (n.exit.ip || "")).toLowerCase().includes(kw));
  return matchHost || matchPort || matchCountry || matchOrg;
}

function toggleCountry(el) {
  el.closest(".country").classList.toggle("collapsed");
}

function renderCountries() {
  const box = document.getElementById("countries");
  if (!DATA || !DATA.countries) {
    box.innerHTML = '<div class="empty">暂无可用节点</div>';
    return;
  }

  const entries = Object.entries(DATA.countries)
    .map(([cname, grp]) => {
      const filteredNodes = (grp.nodes || []).filter(filterNode);
      return [cname, Object.assign({}, grp, {
        nodes: filteredNodes,
        displayCount: filteredNodes.length,
        resCount: filteredNodes.filter(n => n.residential === "residential").length,
        dcCount: filteredNodes.filter(n => n.residential === "datacenter").length,
      })];
    })
    .filter(([_, grp]) => grp.displayCount > 0)
    .sort((a, b) => b[1].displayCount - a[1].displayCount);

  if (entries.length === 0) {
    box.innerHTML = '<div class="empty">未找到匹配的节点，请更换筛选条件或关键词</div>';
    return;
  }

  box.innerHTML = entries.map(([cname, grp]) => {
    const rows = grp.nodes.map(rowHtml).join("");
    return '<div class="country">' +
      '<div class="head" onclick="toggleCountry(this)">' +
        '<div class="c-info">' +
          '<span class="toggle-arrow">▼</span>' +
          '<span class="c-name">' + cname + '</span>' +
          '<span class="c-count">(' + grp.displayCount + ' 个)</span>' +
        '</div>' +
        '<div class="c-meta">' +
          '<span class="c-tag">住宅 ' + grp.resCount + ' / 机房 ' + grp.dcCount + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="c-body">' +
        '<table>' +
          '<thead>' +
            '<tr>' +
              '<th>节点地址与端口 (点击复制)</th>' +
              '<th class="hide-m">地区</th>' +
              '<th>协议</th>' +
              '<th>延迟</th>' +
              '<th class="hide-m">出口网络 / 组织</th>' +
              '<th>类型</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';
  }).join("");
}

function render() {
  if (!DATA) return;
  renderCards(DATA);
  renderCountries();
  const foot = document.getElementById("foot");
  if (foot) {
    foot.innerHTML = '数据源：' + (DATA.source || "-") + ' &nbsp;|&nbsp; 运行模式：' + (DATA.mode || "fast") + ' &nbsp;|&nbsp; 边缘缓存 30 分钟 (自动轮换)';
  }
}

document.querySelectorAll(".pill").forEach(p => {
  p.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
    p.classList.add("on");
    FILTER_TYPE = p.dataset.f;
    renderCountries();
  });
});

async function forceRefresh() {
  const btn = document.getElementById("refreshBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = currentMode === "fast" ? "同步中…" : "检测中…(约5~10秒)";
  }
  try {
    const r = await fetch('data.json?refresh=true&mode=' + currentMode, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    DATA = await r.json();
    render();
    showToast("✓ 节点列表刷新成功");
    if (btn) btn.textContent = "刷新成功 ✓";
  } catch (err) {
    showToast("刷新失败: " + err);
    if (btn) btn.textContent = "刷新失败";
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "立即刷新";
      }
    }, 2000);
  }
}

async function load() {
  try {
    const r = await fetch('data.json?mode=' + currentMode, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    DATA = await r.json();
    render();
  } catch (err) {
    const foot = document.getElementById("foot");
    if (foot) foot.textContent = "加载失败: " + err + "（可点击上方立即刷新）";
  }
}

initNodesUrl();
load();
setInterval(load, 60000);
</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get('refresh') === 'true' || url.pathname === '/api/refresh';

    // 默认模式：fast（免检测极速模式）
    let mode = "fast";
    const modeParam = (url.searchParams.get('mode') || "").toLowerCase();
    if (modeParam === "check" || modeParam === "strict" || env.MODE === "check") {
      mode = "check";
    }
    if (modeParam === "fast" || env.SKIP_CHECK === "true" || env.MODE === "fast") {
      mode = "fast";
    }

    // CORS preflight 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }

    // 1. 订阅列表: /nodes.txt (支持参数: ?type=residential|datacenter, ?country=JP, ?limit=30)
    if (url.pathname === "/nodes.txt") {
      try {
        const { data, edgeHosts } = await getOrUpdateData(env, forceRefresh, mode);
        const filters = {
          type: url.searchParams.get('type') || "",
          country: url.searchParams.get('country') || "",
          limit: url.searchParams.get('limit') || ""
        };
        const outputText = buildNodesText(data, edgeHosts, filters);
        return new Response(outputText, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=60, stale-while-revalidate=1800"
          }
        });
      } catch (err) {
        return new Response(`Error: ${err.message || err}`, { status: 500 });
      }
    }

    // 2. 统计与节点 JSON 数据: /data.json
    if (url.pathname === "/data.json" || url.pathname === "/api/data") {
      try {
        const { data } = await getOrUpdateData(env, forceRefresh, mode);
        return new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=60, stale-while-revalidate=1800"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 3. 手动触发刷新: /api/refresh
    if (url.pathname === "/api/refresh") {
      try {
        const result = await getOrUpdateData(env, true, mode);
        return new Response(JSON.stringify({
          success: true,
          mode,
          generated_at: result.data.generated_at,
          stats: result.data.stats
        }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 4. 静态网页首页 (Pages 部署模式)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // 纯 Worker 模式回退首页
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(EMBEDDED_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};
