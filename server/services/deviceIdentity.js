const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MAC_ADDRESS_REGEX = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
const CACHE_TTL_MS = 60 * 1000;

const macCache = new Map();
let primaryMacCache = { value: null, ts: 0 };

function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return null;

    const trimmed = ip.trim();
    if (!trimmed) return null;

    const noZone = trimmed.includes('%') ? trimmed.split('%')[0] : trimmed;
    if (noZone === '::1') return '127.0.0.1';
    if (noZone.startsWith('::ffff:')) return noZone.slice(7);
    return noZone;
}

function normalizeMacAddress(value) {
    if (!value || typeof value !== 'string') return null;

    const hexOnly = value.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (hexOnly.length === 12) {
        const colonFormatted = hexOnly.match(/.{1,2}/g)?.join(':') || null;
        return colonFormatted && MAC_ADDRESS_REGEX.test(colonFormatted) ? colonFormatted : null;
    }

    const normalized = value.trim().replace(/-/g, ':').toUpperCase();
    return MAC_ADDRESS_REGEX.test(normalized) ? normalized : null;
}

function isLoopbackIp(ip) {
    return ip === '127.0.0.1';
}

function isPrivateIpv4(ip) {
    return /^10\./.test(ip)
        || /^192\.168\./.test(ip)
        || /^169\.254\./.test(ip)
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}

function isPrivateIpv6(ip) {
    return /^fc/i.test(ip) || /^fd/i.test(ip) || /^fe80:/i.test(ip);
}

function isResolvableLanIp(ip) {
    return isPrivateIpv4(ip) || isPrivateIpv6(ip);
}

function extractMacAddress(text) {
    if (!text || typeof text !== 'string') return null;

    const match = text.match(/([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i);
    return match ? normalizeMacAddress(match[1]) : null;
}

function getCachedMac(cacheKey) {
    const cached = macCache.get(cacheKey);
    if (!cached) return null;
    if ((Date.now() - cached.ts) > CACHE_TTL_MS) {
        macCache.delete(cacheKey);
        return null;
    }
    return cached.value;
}

function setCachedMac(cacheKey, value) {
    macCache.set(cacheKey, { value, ts: Date.now() });
}

function getPrimaryHostMac() {
    if (primaryMacCache.value && (Date.now() - primaryMacCache.ts) < CACHE_TTL_MS) {
        return primaryMacCache.value;
    }

    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries || []) {
            const mac = normalizeMacAddress(entry.mac);
            if (!mac || mac === '00:00:00:00:00:00' || entry.internal) continue;

            let score = 0;
            if (entry.family === 'IPv4') score += 5;
            if (/^(en|eth|wlan|wl|wifi|wi-fi)/i.test(name)) score += 3;
            if (!entry.address?.startsWith('169.254.')) score += 1;

            candidates.push({ mac, score });
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]?.mac || null;

    primaryMacCache = { value: best, ts: Date.now() };
    return best;
}

async function lookupMacWith(command, args) {
    try {
        const { stdout, stderr } = await execFileAsync(command, args, {
            timeout: 1500,
            windowsHide: true,
        });
        return extractMacAddress(`${stdout}\n${stderr}`);
    } catch (_) {
        return null;
    }
}

async function lookupMacForIp(ip) {
    const normalizedIp = normalizeIp(ip);
    if (!normalizedIp) return null;

    const cached = getCachedMac(normalizedIp);
    if (cached) return cached;

    let mac = null;

    if (process.platform === 'darwin') {
        mac = await lookupMacWith('arp', ['-n', normalizedIp]);
    } else if (process.platform === 'linux') {
        mac = await lookupMacWith('ip', ['neigh', 'show', normalizedIp]);
        if (!mac) {
            mac = await lookupMacWith('arp', ['-n', normalizedIp]);
        }
    } else if (process.platform === 'win32') {
        mac = await lookupMacWith('arp', ['-a', normalizedIp]);
    }

    if (mac) {
        setCachedMac(normalizedIp, mac);
    }

    return mac;
}

function extractRequestIp(req) {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
        return normalizeIp(forwardedFor.split(',')[0]);
    }

    return normalizeIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || null);
}

async function resolveRequestDeviceMac(req) {
    const headerMac = normalizeMacAddress(req.headers['x-device-id'] || req.query?.deviceId || null);
    if (headerMac) {
        return headerMac;
    }

    const requestIp = extractRequestIp(req);
    if (!requestIp) return null;

    if (isLoopbackIp(requestIp)) {
        return getPrimaryHostMac();
    }

    if (!isResolvableLanIp(requestIp)) {
        return null;
    }

    return lookupMacForIp(requestIp);
}

module.exports = {
    extractRequestIp,
    normalizeMacAddress,
    resolveRequestDeviceMac,
};
