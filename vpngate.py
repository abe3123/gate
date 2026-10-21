#!/usr/bin/env python3
"""
VPN Gate SSTP 节点检测流水线 (优化升级版)
=====================================
核心特性:
  1. 支持免检测极速模式 (动态时间戳 Token 防缓存，秒级产出 80+ 节点)
  2. 智能启发式网络识别 (自动区分家庭宽带住宅 IP 与数据中心机房)
  3. 多源优选入口地址池融合 (静态 Anycast 域名池 + 动态优选 IP API，优雅容错)
  4. 多级镜像源自动降级机制 (官方 API -> jsdelivr CDN 镜像 -> GitHub 原生镜像)
  5. 自动化同步与打包 (自动同步 web 资源并打包 cloudflare-pages-deploy.zip)
"""

import base64
import csv
import io
import json
import os
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from urllib.parse import quote

import requests
from requests.adapters import HTTPAdapter

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ---------------------------------------------------------------------------
# 全局基础配置
# ---------------------------------------------------------------------------
REPO_DIR = os.path.dirname(os.path.abspath(__file__))

VPNGATE_API = os.environ.get("VPNGATE_API", "http://www.vpngate.net/api/iphone/")
DEFAULT_MIRRORS = [
    "https://cdn.jsdelivr.net/gh/fdciabdul/Vpngate-Scraper-API@main/json/data.json",
    "https://raw.githubusercontent.com/fdciabdul/Vpngate-Scraper-API/main/json/data.json",
]
custom_mirror = os.environ.get("VPNGATE_MIRROR", "").strip()
VPNGATE_MIRRORS = [custom_mirror] + DEFAULT_MIRRORS if custom_mirror else DEFAULT_MIRRORS

SSTP_SOURCE = os.environ.get("SSTP_SOURCE", "https://sub.cmliussss.net/vpngate")
SKIP_CHECK = os.environ.get("SKIP_CHECK", "1").lower() in ("1", "true", "yes")

_raw_worker = os.environ.get("CHECK_WORKER", "").strip()
if _raw_worker and "你的域名" not in _raw_worker and "YOUR_DOMAIN" not in _raw_worker:
    WORKER_CHECK_URL = _raw_worker
else:
    WORKER_CHECK_URL = "https://check.socks5.cmliussss.net/check?sstp=vpn:vpn@"

CONCURRENCY = max(1, int(os.environ.get("CHECK_CONCURRENCY", "32")))
CHECK_TIMEOUT = float(os.environ.get("CHECK_TIMEOUT", "60"))
MAX_CHECK_NODES = int(os.environ.get("MAX_CHECK_NODES", "0"))
HTTP_TIMEOUT = int(os.environ.get("HTTP_TIMEOUT", "30"))
PUBLIC_DIR = os.environ.get("PUBLIC_DIR", os.path.join(REPO_DIR, "public"))
WEB_DIR = os.path.join(REPO_DIR, "web")
TEMPLATE_HTML = os.path.join(REPO_DIR, "index.html")

DATA_CENTER_ORG_KEYWORDS = [
    "GOOGLE", "AMAZON", "AWS", "MICROSOFT", "OVH", "HETZNER", "DIGITALOCEAN",
    "AKAMAI", "CLOUDFLARE", "FASTLY", "RACKSPACE", "EQUINIX", "LINODE", "VULTR",
    "HURRICANE", "TENCENT", "ALIBABA", "ALIYUN", "LEASWEB", "CHOOPA", "DATACAMP",
]
RESIDENTIAL_ORG_KEYWORDS = [
    "NTT EAST", "NTT WEST", "NTT COMMUNICATIONS", "NTT BROADBAND", "KDDI", "DOCOMO",
    "SOFTBANK", "AU COMMUNICATIONS", "J:COM", "JCOM", "OCN", "BIGLOBE",
    "IIJ", "SEIKO", "CLEVER-NET", "AT&T", "COMCAST", "XFINITY", "VERIZON",
    "TELUS", "ROGERS", "BELL CANADA", "VODAFONE", "ORANGE", "DEUTSCHE TELEKOM",
    "BREEZE", "TIM S.P.A", "LIBERO", "FASTWEB", "FREE FRANCE", "BT OPEN",
]

COUNTRY_ZH = {
    "JP": "日本", "KR": "韩国", "US": "美国", "CA": "加拿大", "RU": "俄罗斯",
    "RO": "罗马尼亚", "TH": "泰国", "VN": "越南", "DE": "德国", "FR": "法国",
    "GB": "英国", "UK": "英国", "SG": "新加坡", "TW": "台湾", "HK": "香港",
    "CN": "中国", "AU": "澳大利亚", "NL": "荷兰", "SE": "瑞典", "CH": "瑞士",
    "IT": "意大利", "ES": "西班牙", "PL": "波兰", "IN": "印度", "BR": "巴西",
    "MX": "墨西哥", "ID": "印度尼西亚", "MY": "马来西亚", "PH": "菲律宾",
}

# 静态 Anycast 优选入口池
EDGE_HOSTS = [
    h.strip()
    for h in os.environ.get(
        "EDGE_HOSTS",
        "saas.sin.fan:443,cdn.204910.best:443,www.mfyx.cn:443,p.etime.vip:443,cdn.ctn32.us.kg:443,cf.877774.xyz:443,spring.io:443,"
        "cf.nyanya.moe:443,www.sloomb.com:443,op.chinwa.eu.cc:443,www.leics.police.uk:443,securecircle.com:443,www.shopify.com:443,"
        "www.carousell.sg:443,www.dbs.com.sg:443,openai.com:443,linear.app:443,www.bilibili.com:443,uspto.gov:443,www.vmware.com:443,"
        "time.is:443,download.visualstudio.microsoft.com:443,images.unsplash.com:443",
    ).split(",")
    if h.strip()
]

# 优选 API 配置 (默认配置高可用源)
OPTIMAL_API = os.environ.get(
    "OPTIMAL_API",
    "https://cdn.jsdelivr.net/gh/cmliu/WorkerVless2sub@main/addressesapi.txt,https://cf.090227.xyz/ct?ips=6&port=443",
)

def create_session():
    """创建带连接池扩容的高性能 requests Session"""
    s = requests.Session()
    adapter = HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=2)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s

def resolve_nodes_url():
    explicit = os.environ.get("NODES_URL", "").strip()
    if explicit and "YOUR_GITHUB_USERNAME" not in explicit:
        return explicit
    cf_proj = os.environ.get("CLOUDFLARE_PROJECT_NAME", "").strip()
    if cf_proj:
        return f"https://{cf_proj}.pages.dev/nodes.txt"
    cf_url = os.environ.get("CF_PAGES_URL", "").strip()
    if cf_url:
        return f"{cf_url.rstrip('/')}/nodes.txt"
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if repo and "/" in repo:
        owner, name = repo.split("/", 1)
        return f"https://{owner}.github.io/{name}/nodes.txt"
    return "https://YOUR_PROJECT.pages.dev/nodes.txt"

NODES_URL = resolve_nodes_url()

_section = None

def log(section, msg=""):
    global _section
    if section != _section:
        print(f"========== {section} ==========")
        _section = section
    if msg:
        print(msg, flush=True)

def die(msg):
    log("FATAL", f"[失败] {msg}")
    sys.exit(1)

# ---------------------------------------------------------------------------
# 启发式网络与国家识别
# ---------------------------------------------------------------------------
def detect_country_from_host(host):
    if not host:
        return "日本", "JP"
    h = host.lower()
    rules = [
        (re.compile(r"[-._](jp|japan)[-._]|[-._]jp$", re.I), "日本", "JP"),
        (re.compile(r"[-._](kr|korea)[-._]|[-._]kr$", re.I), "韩国", "KR"),
        (re.compile(r"[-._](us|usa|america)[-._]|[-._]us$", re.I), "美国", "US"),
        (re.compile(r"[-._](tw|taiwan)[-._]|[-._]tw$", re.I), "台湾", "TW"),
        (re.compile(r"[-._](hk|hongkong)[-._]|[-._]hk$", re.I), "香港", "HK"),
        (re.compile(r"[-._](sg|singapore)[-._]|[-._]sg$", re.I), "新加坡", "SG"),
        (re.compile(r"[-._](de|germany)[-._]|[-._]de$", re.I), "德国", "DE"),
        (re.compile(r"[-._](uk|gb|britain)[-._]|[-._](uk|gb)$", re.I), "英国", "GB"),
        (re.compile(r"[-._](fr|france)[-._]|[-._]fr$", re.I), "法国", "FR"),
        (re.compile(r"[-._](ca|canada)[-._]|[-._]ca$", re.I), "加拿大", "CA"),
        (re.compile(r"[-._](th|thailand)[-._]|[-._]th$", re.I), "泰国", "TH"),
        (re.compile(r"[-._](vn|vietnam)[-._]|[-._]vn$", re.I), "越南", "VN"),
        (re.compile(r"[-._](ru|russia)[-._]|[-._]ru$", re.I), "俄罗斯", "RU"),
        (re.compile(r"[-._](au|australia)[-._]|[-._]au$", re.I), "澳大利亚", "AU"),
    ]
    for pattern, name, code in rules:
        if pattern.search(h):
            return name, code
    return "日本", "JP"

def classify_network(host, exit_org=None, is_datacenter=None):
    if is_datacenter is True:
        return "datacenter"
    if is_datacenter is False:
        return "residential"
    org = (exit_org or "").upper()
    if org:
        if any(k in org for k in DATA_CENTER_ORG_KEYWORDS):
            return "datacenter"
        if any(k in org for k in RESIDENTIAL_ORG_KEYWORDS):
            return "residential"
    h = host.lower()
    # 动态家宽客户端 (SoftEther 客户端特征)
    if re.match(r"^vpn\d{5,}", h) or re.match(r"^vpnv\d+", h) or "-res-" in h or ".home." in h:
        return "residential"
    # 机房/公开中继服务器
    if h.startswith("public-vpn") or "relay" in h or "server" in h or "vpngw" in h:
        return "datacenter"
    return "unknown"

# ---------------------------------------------------------------------------
# 数据抓取与降级
# ---------------------------------------------------------------------------
def fetch_vpngate(session):
    try:
        log("VPN GATE", f"获取官方 API: {VPNGATE_API}")
        resp = session.get(VPNGATE_API, timeout=HTTP_TIMEOUT, headers={"User-Agent": "Mozilla/5.0 (compatible; gate-checker)"})
        resp.raise_for_status()
        rows = parse_csv(resp.text)
        if rows:
            log("VPN GATE", f"主源(官方 API) 获取到 {len(rows)} 个原始节点")
            return rows, "vpngate.net/api/iphone"
    except Exception as exc:
        log("VPN GATE", f"官方 API 获取失败: {exc}，尝试镜像源...")

    for mirror in VPNGATE_MIRRORS:
        try:
            log("VPN GATE", f"尝试回退镜像: {mirror}")
            resp = session.get(mirror, timeout=HTTP_TIMEOUT, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
            rows = parse_mirror_json(resp.json())
            if rows:
                log("VPN GATE", f"镜像源获取成功，获得 {len(rows)} 个原始节点")
                return rows, mirror
        except Exception as exc:
            log("VPN GATE", f"镜像源失败 ({mirror}): {exc}")

    die("VPN Gate 官方 API 与全部镜像源均不可用，数据抓取完全失败")

def parse_csv(text):
    lines = [ln for ln in text.splitlines() if ln.strip()]
    header_idx = None
    for i, ln in enumerate(lines):
        if ln.lstrip("#").strip().lower().startswith("hostname"):
            header_idx = i
            break
    if header_idx is None:
        raise RuntimeError("找不到 CSV 表头行 (HostName)")

    header = lines[header_idx].lstrip("#").split(",")
    data_lines = lines[header_idx + 1:]
    idx = {}
    for col in ("hostname", "ip", "countrylong", "countryshort", "openvpn_configdata_base64"):
        for i, h in enumerate(header):
            if h.strip().lstrip("*").lower() == col:
                idx[col] = i
                break
    if "openvpn_configdata_base64" not in idx:
        for i, h in enumerate(header):
            if "base64" in h.lower():
                idx["openvpn_configdata_base64"] = i
                break

    pos = {
        "hostname": idx.get("hostname", 0),
        "ip": idx.get("ip", 1),
        "countrylong": idx.get("countrylong", 5),
        "countryshort": idx.get("countryshort", 6),
        "openvpn_configdata_base64": idx.get("openvpn_configdata_base64", len(header) - 1),
    }

    rows = []
    for ln in data_lines:
        fields = next(csv.reader(io.StringIO(ln)))
        if len(fields) < 7:
            continue
        host = fields[pos["hostname"]].strip()
        ip = fields[pos["ip"]].strip()
        if not host or not ip:
            continue
        rows.append({
            "host": host,
            "ip": ip,
            "country_long": fields[pos["countrylong"]].strip(),
            "country_short": fields[pos["countryshort"]].strip(),
            "config_b64": fields[pos["openvpn_configdata_base64"]].strip(),
        })
    return rows

def parse_mirror_json(data):
    servers = []
    items = data if isinstance(data, list) else [data]
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("servers"), list):
            servers.extend(item["servers"])
        elif isinstance(item, dict):
            servers.append(item)
    rows = []
    for s in servers:
        host = str(s.get("hostname") or s.get("host") or "").strip()
        ip = str(s.get("ip") or "").strip()
        if not host or not ip:
            continue
        rows.append({
            "host": host,
            "ip": ip,
            "country_long": str(s.get("countrylong") or s.get("country_long") or s.get("country") or "").strip(),
            "country_short": str(s.get("countryshort") or s.get("country_short") or "").strip(),
            "config_b64": str(s.get("openvpn_configdata_base64") or s.get("config_b64") or "").strip(),
        })
    return rows

# ---------------------------------------------------------------------------
# 优选入口端点处理
# ---------------------------------------------------------------------------
def fetch_optimal_api_endpoints(api_urls_str, session):
    if not api_urls_str.strip():
        return []

    endpoints = []
    urls = [u.strip() for u in api_urls_str.split(",") if u.strip()]
    for url in urls:
        try:
            resp = session.get(url, timeout=8, headers={"User-Agent": "curl/7.88.1"})
            if resp.status_code == 200:
                lines = resp.text.strip().splitlines()
                count = 0
                for line in lines:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    endpoint = line.split("#")[0].strip()
                    if endpoint:
                        if ":" not in endpoint:
                            endpoint = f"{endpoint}:443"
                        endpoints.append(endpoint)
                        count += 1
                if count > 0:
                    log("OPTIMAL API", f"成功从 API ({url}) 获取到 {count} 个优选端点")
            else:
                pass  # 静默容错 (如 403 挑战等)
        except Exception:
            pass
    return endpoints

def get_combined_edge_hosts(session):
    _entry = os.environ.get("HOSTS_ENTRY", "").strip()
    static_hosts = [e.strip() for e in _entry.split(",") if e.strip()] if _entry else EDGE_HOSTS
    api_hosts = fetch_optimal_api_endpoints(OPTIMAL_API, session)

    combined = []
    seen = set()
    for h in static_hosts + api_hosts:
        if h and h not in seen:
            seen.add(h)
            combined.append(h)

    log("EDGE POOL", f"汇总入口池: 静态入口 {len(static_hosts)} 个, 动态 API {len(api_hosts)} 个, 合并有效入口共 {len(combined)} 个")
    return combined if combined else EDGE_HOSTS

# ---------------------------------------------------------------------------
# SSTP 节点提取与去重
# ---------------------------------------------------------------------------
_PROTO_TCP_RE = re.compile(r"^proto\s+(tcp|tcp4|tcp6)\b", re.M)
_REMOTE_RE = re.compile(r"^remote\s+\S+\s+(\d+)", re.M)

def to_sstp_nodes(rows):
    nodes = []
    for r in rows:
        cfg = ""
        if r["config_b64"]:
            try:
                cfg = base64.b64decode(r["config_b64"], validate=False).decode("utf-8", "replace")
            except Exception:
                cfg = ""
        if not _PROTO_TCP_RE.search(cfg):
            continue
        m = _REMOTE_RE.search(cfg)
        if not m:
            continue
        port = int(m.group(1))
        if not (1 <= port <= 65535):
            continue
        host = r["host"]
        if not host.endswith(".opengw.net"):
            host = f"{host}.opengw.net"
        nodes.append({
            "host": host,
            "port": port,
            "ip": r["ip"],
            "country": r["country_long"],
            "country_code": r["country_short"]
        })
    return nodes

def dedupe(nodes):
    seen = set()
    out = []
    for n in nodes:
        key = (n["host"].lower(), n["port"], "sstp")
        if key in seen:
            continue
        seen.add(key)
        out.append(n)
    return out

# ---------------------------------------------------------------------------
# Worker 测活
# ---------------------------------------------------------------------------
def check_one(node, session):
    url = WORKER_CHECK_URL + quote(f"{node['host']}:{node['port']}", safe="")
    out = dict(node)
    out["protocol"] = "sstp"
    out["link"] = f"sstp://vpn:vpn@{node['host']}:{node['port']}"
    out["status"] = "failed"
    out["checked_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    out["exit"] = None
    out["residential"] = "unknown"
    try:
        r = session.get(url, timeout=CHECK_TIMEOUT, headers={"User-Agent": "Mozilla/5.0 (compatible; gate-checker)"})
        if r.status_code != 200:
            out["error"] = f"HTTP {r.status_code}"
            out["worker_error"] = True
            return out
        j = r.json()
        ok = bool(j.get("success"))
        out["success"] = ok
        out["status"] = "success" if ok else "failed"
        out["latency_ms"] = j.get("responseTime")
        out["colo"] = j.get("colo")
        out["error"] = (None if ok else (j.get("error") or j.get("message") or "check failed"))
        exit_info = j.get("exit") or {}
        if exit_info:
            asn = exit_info.get("asn") or {}
            org = asn.get("org") or asn.get("name") or ""
            out["exit"] = {
                "ip": exit_info.get("ip"),
                "country": exit_info.get("country"),
                "country_code": exit_info.get("country_code"),
                "city": exit_info.get("city"),
                "continent": exit_info.get("continent"),
                "asn": asn.get("asn"),
                "org": org,
                "type": asn.get("type"),
                "is_datacenter": exit_info.get("is_datacenter"),
            }
            out["residential"] = classify_network(out["host"], org, exit_info.get("is_datacenter"))
        else:
            out["residential"] = classify_network(out["host"], None, None)
        return out
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"
        out["worker_error"] = True
        return out

def check_all(nodes, session):
    results = []
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = [pool.submit(check_one, n, session) for n in nodes]
        for fut in as_completed(futures):
            results.append(fut.result())
    return results

# ---------------------------------------------------------------------------
# 结果构建与文件生成
# ---------------------------------------------------------------------------
def build_outputs(results, raw_count, sstp_count, source):
    available = [r for r in results if r.get("success")]
    countries = {}
    for n in available:
        c = n.get("country") or "未知"
        countries.setdefault(c, {"code": n.get("country_code") or "?", "nodes": []})["nodes"].append(n)

    res_count = sum(1 for n in available if n.get("residential") == "residential")
    dc_count = sum(1 for n in available if n.get("residential") != "residential")

    stats = {
        "raw_nodes": raw_count,
        "sstp_nodes": sstp_count,
        "checked": len(results),
        "success": len(available),
        "failed": len(results) - len(available),
        "countries": len(countries),
        "residential_est": res_count,
        "datacenter_est": dc_count,
    }
    by_country = {}
    for name, grp in countries.items():
        grp["count"] = len(grp["nodes"])
        grp["residential"] = sum(1 for n in grp["nodes"] if n.get("residential") == "residential")
        grp["datacenter"] = sum(1 for n in grp["nodes"] if n.get("residential") != "residential")
        # 组内排序：优先住宅，其次延迟
        grp["nodes"].sort(key=lambda n: (
            0 if n.get("residential") == "residential" else 1,
            n.get("latency_ms") is None,
            n.get("latency_ms") or 0,
            n.get("host") or ""
        ))
        by_country[name] = grp

    data = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "source": source,
        "worker": WORKER_CHECK_URL,
        "stats": stats,
        "countries": by_country,
        "available": available,
    }
    return data

def build_nodes_text(data, edge_hosts):
    countries = data.get("countries", {})
    edge = edge_hosts
    lines = []
    idx = 0
    ordered = sorted(countries.items(), key=lambda kv: (-int(kv[1].get("count") or 0), str(kv[1].get("code") or kv[0])))
    for cname, grp in ordered:
        code = str(grp.get("code") or "?").upper()
        zh = COUNTRY_ZH.get(code) or (code if code and code != "?" else cname)
        nodes = grp.get("nodes", [])
        res_nodes = [n for n in nodes if n.get("residential") == "residential"]
        dc_nodes = [n for n in nodes if n.get("residential") != "residential"]

        for i, n in enumerate(res_nodes, 1):
            entry = edge[idx % len(edge)]
            idx += 1
            lines.append(f"{entry}#{zh}-住宅-{i:02d}$sstp://vpn:vpn@{n['host']}:{n['port']}")
        for i, n in enumerate(dc_nodes, 1):
            entry = edge[idx % len(edge)]
            idx += 1
            lines.append(f"{entry}#{zh}-机房-{i:02d}$sstp://vpn:vpn@{n['host']}:{n['port']}")
    return "\n".join(lines) + ("\n" if lines else "")

def update_deploy_artifacts():
    """同步 web 目录及更新 cloudflare-pages-deploy.zip"""
    os.makedirs(WEB_DIR, exist_ok=True)
    zip_path = os.path.join(REPO_DIR, "cloudflare-pages-deploy.zip")
    files_to_sync = ["_worker.js", "index.html", "_headers"]

    # 1. 确保 web 目录与根目录同步
    for fname in files_to_sync:
        src = os.path.join(REPO_DIR, fname)
        dst = os.path.join(WEB_DIR, fname)
        if os.path.exists(src):
            with open(src, "rb") as f_src:
                content = f_src.read()
            with open(dst, "wb") as f_dst:
                f_dst.write(content)

    # 2. 重新打包 cloudflare-pages-deploy.zip
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for fname in files_to_sync:
            fpath = os.path.join(WEB_DIR, fname)
            if os.path.exists(fpath):
                zf.write(fpath, arcname=fname)
    log("BUILD", f"已同步更新部署包: {os.path.relpath(zip_path, REPO_DIR)}")

def write_outputs(data, edge_hosts):
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    data_path = os.path.join(PUBLIC_DIR, "data.json")
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    html_path = os.path.join(PUBLIC_DIR, "index.html")
    if os.path.exists(TEMPLATE_HTML):
        with open(TEMPLATE_HTML, "r", encoding="utf-8") as f:
            html = f.read()
    else:
        html = "<html><head><meta charset='utf-8'><title>VPN Gate</title></head><body>VPN Gate SSTP Nodes</body></html>"
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    nodes_path = os.path.join(PUBLIC_DIR, "nodes.txt")
    with open(nodes_path, "w", encoding="utf-8") as f:
        f.write(build_nodes_text(data, edge_hosts))

    headers_path = os.path.join(PUBLIC_DIR, "_headers")
    headers_content = (
        "/*\n"
        "  Access-Control-Allow-Origin: *\n\n"
        "/nodes.txt\n"
        "  Cache-Control: public, max-age=60, stale-while-revalidate=1800\n"
        "  Content-Type: text/plain; charset=utf-8\n\n"
        "/data.json\n"
        "  Cache-Control: public, max-age=60, stale-while-revalidate=1800\n"
        "  Content-Type: application/json; charset=utf-8\n"
    )
    with open(headers_path, "w", encoding="utf-8") as f:
        f.write(headers_content)

    # 同步 _worker.js 到 public 目录，使 Cloudflare Pages 自动启用 Advanced Mode (支持动态参数过滤与刷新)
    worker_src = os.path.join(REPO_DIR, "_worker.js")
    worker_dst = os.path.join(PUBLIC_DIR, "_worker.js")
    if os.path.exists(worker_src):
        with open(worker_src, "rb") as f_src:
            with open(worker_dst, "wb") as f_dst:
                f_dst.write(f_src.read())

    update_deploy_artifacts()
    return data_path, html_path, nodes_path

# ---------------------------------------------------------------------------
# Main 主流程
# ---------------------------------------------------------------------------
def get_dynamic_token():
    now_bj = datetime.now(timezone(timedelta(hours=8)))
    return now_bj.strftime("%Y%m%d%H%M%S")

def resolve_third_party_url(raw_url):
    token = get_dynamic_token()
    url = raw_url or SSTP_SOURCE
    if re.search(r"Token=[0-9]+", url, re.I):
        return re.sub(r"Token=[0-9]+", f"Token={token}", url, flags=re.I)
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}Token={token}"

def main():
    session = create_session()

    # 1. 免检测模式 (默认)
    if SKIP_CHECK:
        dyn_url = resolve_third_party_url(SSTP_SOURCE)
        log("FAST MODE", f"已启用免检测模式，动态 Token 防缓存拉取: {dyn_url}")
        try:
            resp = session.get(dyn_url, timeout=15, headers={"User-Agent": "curl/7.88.1"})
            if resp.status_code == 200:
                lines = [l.strip() for l in resp.text.splitlines() if l.strip()]
                fast_nodes = []
                seen_keys = set()
                for l in lines:
                    m = re.search(r"@([^:]+):(\d+)", l)
                    if m:
                        host = m.group(1).strip()
                        port = int(m.group(2))
                        key = f"{host}:{port}"
                        if key in seen_keys:
                            continue
                        seen_keys.add(key)
                        country_name, country_code = detect_country_from_host(host)
                        residential_type = classify_network(host, None, None)
                        fast_nodes.append({
                            "host": host,
                            "port": port,
                            "ip": host,
                            "country": country_name,
                            "country_code": country_code,
                            "residential": residential_type,
                            "operator": "VPN Gate Community",
                            "latency_ms": 0,
                            "success": True,
                        })
                if fast_nodes:
                    log("FAST MODE", f"免检测成功解析节点: {len(fast_nodes)} (智能识别住宅/机房)")
                    edge_hosts = get_combined_edge_hosts(session)
                    data = build_outputs(fast_nodes, len(fast_nodes), len(fast_nodes), SSTP_SOURCE)
                    data["mode"] = "fast"
                    data_path, html_path, nodes_path = write_outputs(data, edge_hosts)
                    log("WEBSITE", f"已生成 {os.path.relpath(data_path, REPO_DIR)}")
                    log("WEBSITE", f"已生成 {os.path.relpath(html_path, REPO_DIR)}")
                    log("WEBSITE", f"已生成 {os.path.relpath(nodes_path, REPO_DIR)}")
                    log("USAGE", f"自动轮换: 把 {NODES_URL} 填入 edgetunnel 后台「自定义优选IP」框")
                    return
        except Exception as e:
            log("FAST MODE", f"第三方源拉取异常: {e}，自动回退到常规检测流程")

    # 2. 严格检测模式
    dyn_url = resolve_third_party_url(SSTP_SOURCE)
    uniq = []
    source = dyn_url
    try:
        log("VPNGATE", f"优先从第三方源抓取待检测节点: {dyn_url}")
        resp = session.get(dyn_url, timeout=15, headers={"User-Agent": "curl/7.88.1"})
        if resp.status_code == 200:
            lines = [l.strip() for l in resp.text.splitlines() if l.strip()]
            seen = set()
            for l in lines:
                m = re.search(r"@([^:]+):(\d+)", l)
                if m:
                    h = m.group(1).strip()
                    p = int(m.group(2))
                    k = f"{h}:{p}"
                    if k in seen:
                        continue
                    seen.add(k)
                    cname, ccode = detect_country_from_host(h)
                    uniq.append({
                        "host": h,
                        "port": p,
                        "ip": h,
                        "country_long": cname,
                        "country_code": ccode
                    })
    except Exception as e:
        log("VPNGATE", f"第三方源抓取异常: {e}")

    if not uniq:
        rows, source = fetch_vpngate(session)
        raw_count = len(rows)
        if raw_count == 0:
            die("VPN Gate 返回 0 个原始节点 (数据源异常)")
        sstp_nodes = to_sstp_nodes(rows)
        sstp_count = len(sstp_nodes)
        if sstp_count == 0:
            die(f"从 {raw_count} 个原始节点中没有解析出任何 SSTP 节点")
        uniq = dedupe(sstp_nodes)
    else:
        raw_count = len(uniq)
        sstp_count = len(uniq)

    if MAX_CHECK_NODES > 0:
        uniq = uniq[:MAX_CHECK_NODES]

    log("VPN GATE", f"待测节点: {len(uniq)}")
    log("CLOUDFLARE WORKER", f"提交检测: {len(uniq)} (并发 {CONCURRENCY}, 单请求超时 {CHECK_TIMEOUT}s)")
    t0 = time.time()
    results = check_all(uniq, session)
    elapsed = time.time() - t0

    success = [r for r in results if r.get("success")]
    failed = [r for r in results if not r.get("success")]
    worker_errors = [r for r in failed if r.get("worker_error")]

    log("CLOUDFLARE WORKER", f"检测成功: {len(success)}, 失败: {len(failed)}" + (f" (其中 Worker 异常 {len(worker_errors)})" if worker_errors else ""))
    log("CLOUDFLARE WORKER", f"测活耗时: {elapsed:.1f}s")

    if uniq and not success and len(worker_errors) == len(uniq):
        die("Worker 全部请求异常，检测服务不可用 (不生成空结果)")

    data = build_outputs(results, raw_count, sstp_count, source)
    edge_hosts = get_combined_edge_hosts(session)
    data_path, html_path, nodes_path = write_outputs(data, edge_hosts)

    log("WEBSITE", f"已生成 {os.path.relpath(data_path, REPO_DIR)}")
    log("WEBSITE", f"已生成 {os.path.relpath(html_path, REPO_DIR)}")
    log("WEBSITE", f"已生成 {os.path.relpath(nodes_path, REPO_DIR)}")
    log("USAGE", f"自动轮换: 把 {NODES_URL} 填入 edgetunnel 后台「自定义优选IP」框")

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        die(f"程序异常: {type(exc).__name__}: {exc}")
