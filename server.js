const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const WebSocket = require("ws");
const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");
const crypto = require("crypto");
const yaml = require("js-yaml");

const subDir = path.join(__dirname, "sub");
const uploadDir = path.join(__dirname, "uploads");
for (const d of [subDir, uploadDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const MAX_CONCURRENCY = 100;
const MAX_URLS_PER_TASK = 5000;
const MAX_CONTENT_LENGTH = 20 * 1024 * 1024;
const MAX_WALK_VISITED = 1000;
const MAX_LINKS_PER_PAGE = 500;
const DNS_CACHE_TTL_MS = 60 * 1000;
const DNS_CACHE_MAX = 5000;
const SOCKET_POOL_MAX = 256;

const SUB_TTL_MS = 24 * 60 * 60 * 1000;
const SUB_CLEAN_INTERVAL_MS = 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_SCAN_MAX = 60;
const RATE_LIMIT_SUB_MAX = 600;

const taskStatus = new Map();
const sessions = new Map();

function ts() { return new Date().toISOString(); }
function logInfo(msg) { console.log(`[${ts()}] [INFO] ${msg}`); }
function logWarn(msg) { console.warn(`[${ts()}] [WARN] ${msg}`); }
function logError(msg) { console.error(`[${ts()}] [ERROR] ${msg}`); }

function isPrivateIPv4(ip) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
}

function isPrivateIPv6(ip) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) {
        const v4 = lower.substring(7);
        if (net.isIPv4(v4)) return isPrivateIPv4(v4);
    }
    return false;
}

function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) return isPrivateIPv4(ip);
    if (net.isIPv6(ip)) return isPrivateIPv6(ip);
    return true;
}

const dnsCache = new Map();

function evictDnsCache() {
    if (dnsCache.size <= DNS_CACHE_MAX) return;
    const now = Date.now();
    for (const [k, v] of dnsCache) {
        if (now - v.ts > DNS_CACHE_TTL_MS) dnsCache.delete(k);
    }
    if (dnsCache.size > DNS_CACHE_MAX) {
        const extra = dnsCache.size - DNS_CACHE_MAX;
        const keys = [...dnsCache.keys()].slice(0, extra);
        for (const k of keys) dnsCache.delete(k);
    }
}

function safeLookup(hostname, options, callback) {
    const lower = String(hostname).toLowerCase();
    if (lower === "localhost" || lower.endsWith(".localhost") ||
        lower === "metadata.google.internal" || lower.endsWith(".internal") || lower.endsWith(".local")) {
        return callback(new Error(`禁止访问受限主机名: ${hostname}`));
    }

    const now = Date.now();
    const cached = dnsCache.get(lower);
    if (cached && now - cached.ts < DNS_CACHE_TTL_MS) {
        if (cached.error) return callback(new Error(cached.error));
        if (options && options.all) return callback(null, cached.addrs);
        const first = cached.addrs[0];
        return callback(null, first.address, first.family);
    }

    dns.lookup(hostname, { all: true, verbatim: false }, (err, addrs) => {
        if (err) {
            const msg = `DNS 解析失败: ${err.message}`;
            dnsCache.set(lower, { ts: now, addrs: [], error: msg });
            evictDnsCache();
            return callback(new Error(msg));
        }
        const safe = (addrs || []).filter(a => !isPrivateAddress(a.address));
        if (safe.length === 0) {
            const msg = `禁止访问内网地址: ${hostname}`;
            dnsCache.set(lower, { ts: now, addrs: [], error: msg });
            evictDnsCache();
            return callback(new Error(msg));
        }
        dnsCache.set(lower, { ts: now, addrs: safe });
        evictDnsCache();
        if (options && options.all) return callback(null, safe);
        const first = safe[0];
        callback(null, first.address, first.family);
    });
}

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: SOCKET_POOL_MAX, maxFreeSockets: 64, lookup: safeLookup });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: SOCKET_POOL_MAX, maxFreeSockets: 64, lookup: safeLookup, rejectUnauthorized: true });
const httpsAgentInsecure = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: SOCKET_POOL_MAX, maxFreeSockets: 64, lookup: safeLookup, rejectUnauthorized: false });

function normalizeUrl(raw) {
    let url = String(raw || "").trim();
    if (!url) return null;
    if (url.length > 2048) return null;
    if (!/^https?:\/\//i.test(url)) url = "http://" + url;
    try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        return u.href;
    } catch { return null; }
}

function isLikelyBase64(str) {
    if (!str) return false;
    if (str.length < 100 || str.length > MAX_CONTENT_LENGTH) return false;
    const cleaned = str.replace(/\s+/g, "");
    if (cleaned.length < 100 || cleaned.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/=]+$/.test(cleaned);
}

function tryBase64Decode(str) {
    try {
        const cleaned = str.replace(/\s+/g, "");
        const decoded = Buffer.from(cleaned, "base64").toString("utf8");
        if (!decoded || decoded.length === 0) return null;
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x08\x0E-\x1F]/.test(decoded)) return null;
        return decoded;
    } catch { return null; }
}

async function fetchUrl(url, options, signal) {
    const isHttps = url.startsWith("https://");
    const agent = isHttps ? (options.ignoreSSL ? httpsAgentInsecure : httpsAgent) : httpAgent;
    const resp = await axios.get(url, {
        timeout: options.timeout, httpAgent: agent, httpsAgent: agent,
        maxRedirects: 5, maxContentLength: MAX_CONTENT_LENGTH, maxBodyLength: MAX_CONTENT_LENGTH,
        validateStatus: () => true, signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Yidunsao/2.2.0)" },
        responseType: "text", transformResponse: [(d) => d], decompress: true,
    });
    let data = resp.data;
    if (Buffer.isBuffer(data)) data = data.toString("utf8");
    if (typeof data !== "string") data = JSON.stringify(data);
    if (data.length > MAX_CONTENT_LENGTH) data = data.slice(0, MAX_CONTENT_LENGTH);
    const trimmed = data.trim();
    if (isLikelyBase64(trimmed)) {
        const decoded = tryBase64Decode(trimmed);
        if (decoded) data = decoded;
    }
    return data;
}

const NODE_REGEX = /(?:ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|anytls):\/\/[^\s"'<>;,]+/gi;

function extractNodesFromLinks(text = "") {
    if (!text || typeof text !== "string") return [];
    const matches = text.match(NODE_REGEX);
    if (!matches) return [];
    const nodes = new Set();
    for (let node of matches) {
        node = node.trim();
        if (node.length < 10 || node.length > 4096) continue;
        if (/[<>"'\s]/.test(node)) continue;
        const parts = node.split("://");
        if (parts.length !== 2 || parts[1].length < 5) continue;
        nodes.add(node);
    }
    return [...nodes];
}

function isClashYaml(text) {
    if (!text || typeof text !== "string") return false;
    const hasProxies = /proxies\s*:/i.test(text);
    const hasProxyKeywords = /(?:name|type|server|port)\s*:/i.test(text);
    const likelyHasNodes = /type\s*:\s*(?:ss|vmess|vless|trojan|hysteria2?|tuic|anytls)/i.test(text);
    return hasProxies && (likelyHasNodes || hasProxyKeywords);
}

function toStr(v) {
    if (v === undefined || v === null) return "";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "object") {
        if (Array.isArray(v)) return v.map(toStr).filter(Boolean).join(",");
        return "";
    }
    return String(v);
}

function buildQuery(params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        const s = toStr(v);
        if (s) sp.set(k, s);
    }
    const q = sp.toString();
    return q ? "?" + q : "";
}

function resolveTransport(proxy) {
    const network = toStr(proxy.network || "tcp").toLowerCase();
    const result = { type: network, path: "", host: "", serviceName: "", headers: {} };

    if (network === "ws") {
        const wsOpts = proxy["ws-opts"] || proxy["ws-options"] || {};
        result.path = toStr(wsOpts.path || "/");
        if (wsOpts.headers) {
            result.headers = wsOpts.headers;
            result.host = toStr(wsOpts.headers.Host || wsOpts.headers.host || "");
        }
    } else if (network === "grpc") {
        const grpcOpts = proxy["grpc-opts"] || proxy["grpc-options"] || {};
        result.serviceName = toStr(grpcOpts["grpc-service-name"] || "");
    } else if (network === "h2" || network === "http") {
        const h2Opts = proxy["h2-opts"] || proxy["h2-options"] || {};
        result.path = toStr(h2Opts.path || "/");
        if (Array.isArray(h2Opts.host)) result.host = toStr(h2Opts.host[0] || "");
        else result.host = toStr(h2Opts.host || "");
    } else if (network === "httpupgrade") {
        const huOpts = proxy["httpupgrade-opts"] || proxy["http-upgrade-opts"] || {};
        result.path = toStr(huOpts.path || "/");
        result.host = toStr(huOpts.host || "");
    }

    return result;
}

function resolveTLS(proxy) {
    const tls = {
        enabled: !!proxy.tls,
        sni: toStr(proxy.servername || proxy.sni || ""),
        alpn: toStr(proxy.alpn || ""),
        fp: toStr(proxy["client-fingerprint"] || ""),
        insecure: !!proxy["skip-cert-verify"],
        reality: null,
    };
    if (proxy["reality-opts"]) {
        tls.enabled = true;
        tls.reality = {
            publicKey: toStr(proxy["reality-opts"]["public-key"] || ""),
            shortId: toStr(proxy["reality-opts"]["short-id"] || ""),
        };
    }
    return tls;
}

// 解万物 mihomo

function clashSS(proxy) {
    const cipher = toStr(proxy.cipher || "");
    const password = toStr(proxy.password || "");
    if (!cipher || !password) return null;

    const server = toStr(proxy.server);
    const port = toStr(proxy.port);
    const name = encodeURIComponent(toStr(proxy.name || "Unnamed"));

    let pluginPart = "";
    if (proxy.plugin) {
        const pluginName = toStr(proxy.plugin);
        const pluginOpts = proxy["plugin-opts"] || {};
        const optParts = [];
        for (const [k, v] of Object.entries(pluginOpts)) {
            if (v === true) optParts.push(k);
            else if (v !== false && v !== undefined && v !== null && v !== "") {
                optParts.push(`${k}=${toStr(v)}`);
            }
        }
        const optStr = optParts.join(";");
        pluginPart = `/` + (optStr ? `?plugin=${encodeURIComponent(pluginName + (optStr ? ";" + optStr : ""))}` : `?plugin=${encodeURIComponent(pluginName)}`);
    }

    const userInfo = Buffer.from(`${cipher}:${password}`, "utf8").toString("base64").replace(/=+$/, "");
    const base = `ss://${userInfo}@${server}:${port}`;
    return pluginPart ? `${base}${pluginPart}#${name}` : `${base}#${name}`;
}

function clashVMess(proxy) {
    const uuid = toStr(proxy.uuid || "");
    if (!uuid) return null;

    const transport = resolveTransport(proxy);
    const tls = resolveTLS(proxy);
    const name = toStr(proxy.name || "Unnamed");

    const vmessObj = {
        v: "2",
        ps: name,
        add: toStr(proxy.server),
        port: toStr(proxy.port),
        id: uuid,
        aid: toStr(proxy.alterId !== undefined ? proxy.alterId : 0),
        scy: toStr(proxy.cipher || "auto"),
        net: transport.type,
        type: toStr(proxy["packet-encoding"] || "none"),
        host: transport.host || tls.sni || toStr(proxy.server),
        path: transport.path || transport.serviceName || "/",
        tls: tls.enabled ? (tls.reality ? "reality" : "tls") : "",
        sni: tls.sni,
        alpn: tls.alpn,
        fp: tls.fp,
    };

    if (tls.reality) {
        vmessObj["pbk"] = tls.reality.publicKey;
        vmessObj["sid"] = tls.reality.shortId;
    }

    for (const k of Object.keys(vmessObj)) {
        if (vmessObj[k] === "" || vmessObj[k] === undefined) delete vmessObj[k];
    }

    const jsonStr = JSON.stringify(vmessObj);
    const b64 = Buffer.from(jsonStr, "utf8").toString("base64").replace(/=+$/, "");
    return `vmess://${b64}`;
}

function clashVLESS(proxy) {
    const uuid = toStr(proxy.uuid || "");
    if (!uuid) return null;

    const transport = resolveTransport(proxy);
    const tls = resolveTLS(proxy);
    const name = encodeURIComponent(toStr(proxy.name || "Unnamed"));

    const params = {
        type: transport.type,
        security: tls.reality ? "reality" : (tls.enabled ? "tls" : "none"),
        encryption: toStr(proxy.encryption || "none"),
        flow: toStr(proxy.flow || ""),
        sni: tls.sni,
        alpn: tls.alpn,
        fp: tls.fp,
    };

    if (transport.type === "ws" || transport.type === "httpupgrade") {
        params.path = transport.path || "/";
        params.host = transport.host || tls.sni;
    } else if (transport.type === "grpc") {
        params.serviceName = transport.serviceName;
    } else if (transport.type === "h2") {
        params.path = transport.path || "/";
        params.host = transport.host;
    }

    if (tls.reality) {
        params.pbk = tls.reality.publicKey;
        params.sid = tls.reality.shortId;
    }

    if (tls.insecure) params.allowInsecure = "1";

    const query = buildQuery(params);
    return `vless://${uuid}@${toStr(proxy.server)}:${toStr(proxy.port)}${query}#${name}`;
}

function clashTrojan(proxy) {
    const password = toStr(proxy.password || "");
    if (!password) return null;

    const transport = resolveTransport(proxy);
    const tls = resolveTLS(proxy);
    const name = encodeURIComponent(toStr(proxy.name || "Unnamed"));

    const params = {
        sni: tls.sni,
        alpn: tls.alpn,
        fp: tls.fp,
    };

    if (transport.type === "ws") {
        params.type = "ws";
        params.path = transport.path || "/";
        params.host = transport.host || tls.sni;
    } else if (transport.type === "grpc") {
        params.type = "grpc";
        params.serviceName = transport.serviceName;
    } else if (transport.type !== "tcp") {
        params.type = transport.type;
        if (transport.path) params.path = transport.path;
        if (transport.host) params.host = transport.host;
    }

    if (tls.insecure) params.allowInsecure = "1";

    const query = buildQuery(params);
    return `trojan://${encodeURIComponent(password)}@${toStr(proxy.server)}:${toStr(proxy.port)}${query}#${name}`;
}

function clashHysteria2(proxy) {
    const password = toStr(proxy.password || proxy.auth || proxy["auth-str"] || "");
    if (!password) return null;

    const tls = resolveTLS(proxy);
    const name = encodeURIComponent(toStr(proxy.name || "Unnamed"));

    const params = {
        sni: tls.sni,
        alpn: tls.alpn,
    };
    if (tls.insecure) params.insecure = "1";
    if (proxy.obfs) params.obfs = toStr(proxy.obfs);
    if (proxy["obfs-password"]) params["obfs-password"] = toStr(proxy["obfs-password"]);
    if (proxy.up) params.up = toStr(proxy.up);
    if (proxy.down) params.down = toStr(proxy.down);
    if (proxy.ports) params.ports = toStr(proxy.ports);

    const query = buildQuery(params);
    return `hysteria2://${encodeURIComponent(password)}@${toStr(proxy.server)}:${toStr(proxy.port)}${query}#${name}`;
}

function clashTUIC(proxy) {
    const uuid = toStr(proxy.uuid || "");
    const password = toStr(proxy.password || "");
    if (!uuid || !password) return null;

    const tls = resolveTLS(proxy);
    const name = encodeURIComponent(toStr(proxy.name || "Unnamed"));

    const params = {
        sni: tls.sni,
        alpn: tls.alpn,
        fp: tls.fp,
    };
    if (tls.insecure) params.allow_insecure = "1";
    if (proxy["congestion-controller"]) params.congestion_control = toStr(proxy["congestion-controller"]);
    if (proxy["udp-relay-mode"]) params.udp_relay_mode = toStr(proxy["udp-relay-mode"]);
    if (proxy["heartbeat-interval"]) params.heartbeat_interval = toStr(proxy["heartbeat-interval"]);
    if (proxy["disable-sni"]) params.disable_sni = "1";
    if (proxy["reduce-rtt"]) params.reduce_rtt = "1";

    const query = buildQuery(params);
    return `tuic://${uuid}:${password}@${toStr(proxy.server)}:${toStr(proxy.port)}${query}#${name}`;
}

function clashAnyTLS(proxy) {
    const password = toStr(proxy.password || "");
    if (!password) return null;

    const tls = resolveTLS(proxy);
    const name = encodeURIComponent(toStr(proxy.name || "Unnamed"));

    const params = {
        sni: tls.sni,
        alpn: tls.alpn,
        fp: tls.fp,
    };
    if (tls.insecure) params.insecure = "1";

    const query = buildQuery(params);
    return `anytls://${encodeURIComponent(password)}@${toStr(proxy.server)}:${toStr(proxy.port)}${query}#${name}`;
}

function clashNodeToLink(proxy) {
    if (!proxy || typeof proxy !== "object") return null;
    const type = toStr(proxy.type || "").toLowerCase();

    switch (type) {
        case "ss":
        case "shadowsocks":  return clashSS(proxy);
        case "vmess":        return clashVMess(proxy);
        case "vless":        return clashVLESS(proxy);
        case "trojan":       return clashTrojan(proxy);
        case "hysteria2":
        case "hy2":          return clashHysteria2(proxy);
        case "tuic":         return clashTUIC(proxy);
        case "anytls":       return clashAnyTLS(proxy);
        default:             return null;
    }
}

function extractNodesFromClashYaml(text) {
    const result = [];
    try {
        const doc = yaml.load(text);
        if (!doc || typeof doc !== "object") return result;
        const proxies = doc.proxies;
        if (!Array.isArray(proxies)) return result;
        for (const proxy of proxies) {
            const link = clashNodeToLink(proxy);
            if (link) result.push(link);
        }
    } catch (e) {
        logWarn(`Clash YAML 解析失败: ${e.message}`);
    }
    return result;
}

function extractNodes(text = "") {
    if (!text || typeof text !== "string") return [];
    if (isClashYaml(text)) {
        const yamlNodes = extractNodesFromClashYAML(text);
        if (yamlNodes.length > 0) {
            const linkNodes = extractNodesFromLinks(text);
            return [...new Set([...yamlNodes, ...linkNodes])];
        }
    }
    return extractNodesFromLinks(text);
}

function extractNodesFromClashYAML(text) { return extractNodesFromClashYaml(text); }

const COMMON_FILES = [
    "sub.txt", "nodes.txt", "proxy.txt", "config.json", "config.yaml",
    "clash.yaml", "clash.yml", "sing-box.json", "sb.json",
    "subscription.txt", "share.txt", "proxy.json", "proxies.txt",
    "robots.txt", "sitemap.xml"
];

async function scanFileProbe(baseUrl, options, signal) {
    const result = [];
    const root = baseUrl.replace(/\/$/, "");
    for (const file of COMMON_FILES) {
        try {
            const url = root + "/" + file;
            const content = await fetchUrl(url, options, signal);
            result.push(...extractNodes(content));
        } catch (err) {
            if (err.name === "AbortError" || err.code === "ERR_CANCELED") throw err;
        }
    }
    return [...new Set(result)];
}

async function scanSubscription(url, options, signal) {
    try {
        const content = await fetchUrl(url, options, signal);
        return extractNodes(content);
    } catch (err) {
        if (err.name === "AbortError" || err.code === "ERR_CANCELED") throw err;
        return [];
    }
}

async function scanHtml(url, options, signal) {
    try {
        const html = await fetchUrl(url, options, signal);
        return extractNodes(html);
    } catch (err) {
        if (err.name === "AbortError" || err.code === "ERR_CANCELED") throw err;
        return [];
    }
}

async function walk(currentUrl, depth, options, result, visited, signal) {
    if (depth < 0) return;
    if (visited.has(currentUrl)) return;
    if (visited.size >= MAX_WALK_VISITED) return;
    visited.add(currentUrl);
    let html;
    try {
        html = await fetchUrl(currentUrl, options, signal);
    } catch (err) {
        if (err.name === "AbortError" || err.code === "ERR_CANCELED") throw err;
        return;
    }
    let $;
    try { $ = cheerio.load(html); } catch { return; }
    const links = [];
    $("a").each((i, el) => {
        const href = $(el).attr("href");
        if (href && links.length < MAX_LINKS_PER_PAGE) links.push(href);
    });
    for (const href of links) {
        try {
            const nextUrl = new URL(href, currentUrl).href;
            const cleanPath = nextUrl.split("?")[0].split("#")[0];
            const ext = cleanPath.split(".").pop().toLowerCase();
            if (options.extensions.includes(ext)) {
                try {
                    const content = await fetchUrl(nextUrl, options, signal);
                    result.push(...extractNodes(content));
                } catch (err) {
                    if (err.name === "AbortError" || err.code === "ERR_CANCELED") throw err;
                }
            }
            if (href.endsWith("/")) {
                await walk(nextUrl, depth - 1, options, result, visited, signal);
            }
        } catch (err) {
            if (err.name === "AbortError" || err.code === "ERR_CANCELED") throw err;
        }
    }
}

async function scanTraverse(url, options, signal) {
    const result = [];
    await walk(url, options.depth, options, result, new Set(), signal);
    return [...new Set(result)];
}

function createLimiter(concurrency) {
    const queue = [];
    let active = 0;
    const runNext = () => {
        while (active < concurrency && queue.length > 0) {
            const { fn, resolve, reject } = queue.shift();
            active++;
            Promise.resolve().then(fn).then(resolve, reject).finally(() => {
                active--; runNext();
            });
        }
    };
    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject }); runNext();
    });
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 1024 * 1024 });

const rateLimitStore = new Map();
function rateLimit(maxReq, windowMs) {
    return (req, res, next) => {
        const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
        const now = Date.now();
        let entry = rateLimitStore.get(ip);
        if (!entry || now - entry.start > windowMs) {
            entry = { start: now, count: 0 };
            rateLimitStore.set(ip, entry);
        }
        entry.count++;
        if (entry.count > maxReq) {
            return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
        }
        next();
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitStore) {
        if (now - entry.start > RATE_LIMIT_WINDOW_MS) rateLimitStore.delete(ip);
    }
}, 5 * 60 * 1000).unref();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    try {
        const u = new URL(origin);
        return u.host === req.headers.host;
    } catch { return false; }
}

function sendToSession(sessionId, type, data) {
    const clients = sessions.get(sessionId);
    if (!clients) return;
    const message = JSON.stringify({ type, data });
    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(message);
    });
}

function log(sessionId, message) { sendToSession(sessionId, "log", message); }
function sendNode(sessionId, node) { sendToSession(sessionId, "node", node); }
function sendStats(sessionId, stats) { sendToSession(sessionId, "stats", stats); }

wss.on("connection", (ws, req) => {
    if (!checkOrigin(req)) {
        logWarn(`[WebSocket] 拒绝非法 Origin: ${req.headers.origin}`);
        ws.close(1008, "Origin not allowed");
        return;
    }
    let sessionId = null;
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        sessionId = url.searchParams.get("sessionId");
    } catch {
        ws.close(1008, "Invalid URL");
        return;
    }
    if (!sessionId || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
        ws.close(1008, "Invalid sessionId");
        return;
    }
    if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
    sessions.get(sessionId).add(ws);
    logInfo(`[WebSocket] 会话 ${sessionId} 已连接`);

    ws.on("message", (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            if (data.type === "control") {
                const status = taskStatus.get(sessionId);
                if (!status) return;
                if (data.action === "pause") {
                    status.status = "paused";
                    log(sessionId, "[控制] 已暂停扫描");
                } else if (data.action === "resume") {
                    status.status = "running";
                    log(sessionId, "[控制] 已恢复扫描");
                } else if (data.action === "stop") {
                    status.status = "terminated";
                    if (status.abortController) status.abortController.abort();
                    log(sessionId, "[控制] 扫描已终止");
                }
            }
        } catch (err) {
            logError(`[WebSocket 控制消息解析错误] ${err.message}`);
        }
    });

    ws.on("close", () => {
        const clientSet = sessions.get(sessionId);
        if (clientSet) {
            clientSet.delete(ws);
            if (clientSet.size === 0) sessions.delete(sessionId);
            const status = taskStatus.get(sessionId);
            if (status && status.status !== "terminated") {
                status.status = "terminated";
                if (status.abortController) status.abortController.abort();
                logInfo(`[WebSocket] 会话 ${sessionId} 断开，自动终止扫描`);
            }
        }
        logInfo(`[WebSocket] 会话 ${sessionId} 已断开`);
    });
});

function cleanExpiredSubs() {
    const now = Date.now();
    fs.readdir(subDir, (err, files) => {
        if (err) return;
        for (const f of files) {
            const fp = path.join(subDir, f);
            fs.stat(fp, (err2, st) => {
                if (err2) return;
                if (now - st.mtimeMs > SUB_TTL_MS) {
                    fs.unlink(fp, (e) => { if (!e) logInfo(`[清理] 已删除过期订阅文件 ${f}`); });
                }
            });
        }
    });
}
cleanExpiredSubs();
setInterval(cleanExpiredSubs, SUB_CLEAN_INTERVAL_MS).unref();

app.get("/sub/:fileId", rateLimit(RATE_LIMIT_SUB_MAX, RATE_LIMIT_WINDOW_MS), (req, res) => {
    const fileId = req.params.fileId;
    if (!/^[a-f0-9-]{36}$/i.test(fileId)) return res.status(400).send("Invalid subscription id");
    const filePath = path.join(subDir, fileId);
    if (!filePath.startsWith(subDir + path.sep)) return res.status(400).send("Invalid path");
    if (!fs.existsSync(filePath)) return res.status(404).send("Subscription not found");
    const content = fs.readFileSync(filePath, "utf8");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(content);
});

app.post("/scan", rateLimit(RATE_LIMIT_SCAN_MAX, RATE_LIMIT_WINDOW_MS), upload.single("file"), async (req, res) => {
    const sessionId = req.query.sessionId;
    const cleanTempFile = () => {
        if (req.file && req.file.path) {
            fs.unlink(req.file.path, (err) => { if (err) logError(`清理临时文件失败: ${err.message}`); });
        }
    };
    if (!sessionId || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
        cleanTempFile();
        return res.status(400).json({ error: "Missing or invalid sessionId" });
    }
    if (!req.file) return res.status(400).json({ error: "Missing file" });

    try {
        const rawUrls = fs.readFileSync(req.file.path, "utf8").split(/\r?\n/).map(normalizeUrl).filter(Boolean);
        cleanTempFile();
        if (rawUrls.length === 0) return res.status(400).json({ error: "文件中没有有效的 URL" });
        if (rawUrls.length > MAX_URLS_PER_TASK) return res.status(400).json({ error: `URL 数量超过上限 (${MAX_URLS_PER_TASK})` });

        const options = {
            timeout: Math.min(Number(req.body.timeout) || 10000, 60000),
            ignoreSSL: req.body.ignoreSSL === "true",
            depth: Math.min(Number(req.body.depth) || 3, 5),
            extensions: String(req.body.extensions || "").split(",").map(v => v.trim().toLowerCase().replace(/^\./, "")).filter(v => /^[a-z0-9]{1,10}$/.test(v)).slice(0, 50),
        };
        const concurrency = Math.min(Number(req.body.concurrency) || 10, MAX_CONCURRENCY);
        const limit = createLimiter(concurrency);

        const allNodes = new Set();
        let scanned = 0, success = 0, failed = 0;
        const abortController = new AbortController();
        const signal = abortController.signal;
        taskStatus.set(sessionId, { status: "running", abortController });

        const scanUrl = async (url) => {
            const status = taskStatus.get(sessionId);
            if (!status || status.status === "terminated") throw new Error("扫描已被终止");
            while (status.status === "paused") {
                await new Promise(r => setTimeout(r, 200));
                const s2 = taskStatus.get(sessionId);
                if (!s2 || s2.status === "terminated") throw new Error("扫描已被终止");
            }
            log(sessionId, `[开始] ${url}`);
            try {
                const addNodes = (nodes) => {
                    nodes.forEach(node => {
                        if (!allNodes.has(node)) {
                            allNodes.add(node);
                            sendNode(sessionId, node);
                        }
                    });
                };
                addNodes(await scanFileProbe(url, options, signal));
                if (req.body.subscription === "true") addNodes(await scanSubscription(url, options, signal));
                if (req.body.html === "true") addNodes(await scanHtml(url, options, signal));
                if (req.body.traverse === "true") addNodes(await scanTraverse(url, options, signal));
                scanned++; success++;
                sendStats(sessionId, { scanned, success, failed, nodes: allNodes.size });
                log(sessionId, `[完成] ${url}`);
            } catch (err) {
                if (err.name === "AbortError" || err.code === "ERR_CANCELED" || err.message === "扫描已被终止") throw err;
                scanned++; failed++;
                sendStats(sessionId, { scanned, success, failed, nodes: allNodes.size });
                log(sessionId, `[失败] ${url} ${err.message}`);
            }
        };

        try {
            await Promise.all(rawUrls.map(url => limit(() => scanUrl(url))));
        } catch (err) {
            if (err.name === "AbortError" || err.code === "ERR_CANCELED" || err.message === "扫描已被终止") {
                log(sessionId, "[系统] 扫描因用户操作而终止");
            } else {
                throw err;
            }
        } finally {
            taskStatus.delete(sessionId);
        }

        const uuid = crypto.randomUUID();
        const subFilePath = path.join(subDir, uuid);
        const nodeList = [...allNodes].join("\n");
        const base64Content = Buffer.from(nodeList, "utf8").toString("base64");
        fs.writeFileSync(subFilePath, base64Content, "utf8");
        const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
        const host = req.get("host");
        const subUrl = `${proto}://${host}/sub/${uuid}`;
        res.json({ success: true, nodes: [...allNodes], subUrl });
    } catch (err) {
        cleanTempFile();
        logError(`[错误] ${err.message}`);
        if (err.message === "扫描已被终止") return res.status(200).json({ success: false, error: "扫描已被用户终止" });
        res.status(500).json({ error: err.message || "内部错误" });
    }
});

app.use((err, req, res, next) => {
    logError(`[未处理错误] ${err.message}`);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "服务器内部错误" });
});
const PORT = process.env.PORT || 15362;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
    const addr = server.address();
    const displayHost = (addr.address === "0.0.0.0" || addr.address === "::")
        ? "localhost"
        : addr.address;
    const displayPort = addr.port;

    logInfo(`启动成功`);
    logInfo(`  监听地址: http://${displayHost}:${displayPort}`);
    logInfo(`  监听主机: ${addr.address}:${addr.port} (${addr.family})`);
    logInfo(`  访问入口: http://localhost:${displayPort}`);
});
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT", () => { server.close(() => process.exit(0)); });
process.on("unhandledRejection", (r) => logError(`未处理的 Promise 拒绝: ${r && r.stack || r}`));
process.on("uncaughtException", (e) => logError(`未捕获异常: ${e.stack || e}`));