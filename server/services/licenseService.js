/**
 * License Service
 *
 * Communicates with the centralized PHP auth server (Hostinger).
 * All user state (registration, login, token validation, IP locking)
 * is owned by the remote server — the Node app never stores users locally.
 */
const { licenseServerUrl } = require('../authMode');

// Cache verified tokens for a short window to avoid hitting the PHP server on every request
const tokenCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 1 minute

class LicenseService {
    /**
     * @param {string} baseUrl - The PHP auth server URL, e.g. "https://your-domain.com/auth-server"
     */
    constructor(baseUrl) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    // ---- Public API ----

    /**
     * Register a new user (status = pending, requires admin approval).
     */
    async register(username, password, email = null, fullname = null, deviceId = null) {
        return this._post('/api/register.php', { username, password, email, fullname, device_id: deviceId });
    }

    /**
     * Login — returns { token, user } on success.
     * The PHP server locks the session to the client's MAC address.
     */
    async login(username, password, deviceId = null) {
        const result = await this._post('/api/login.php', { username, password, device_id: deviceId });
        // Bust any stale cache for this user
        if (result.token) {
            tokenCache.delete(result.token);
        }
        return result;
    }

    /**
     * Verify a token and optionally check device.
     * Returns the user payload on success, throws on failure.
     *
     * @param {string} token - JWT from the client
     * @param {string|null} deviceId - The resolved client MAC address
     */
    async verify(token, deviceId = null) {
        if (!token) throw new Error('No token provided');

        // Check short-lived cache to avoid hammering the PHP server
        const cached = tokenCache.get(token);
        if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
            // If we have a cached result but now need device check, re-verify
            if (deviceId && cached.deviceId && cached.deviceId !== deviceId) {
                tokenCache.delete(token);
                // Fall through to remote verify
            } else {
                return cached.data;
            }
        }

        const result = await this._post('/api/verify.php', { device_id: deviceId }, token);

        if (result.error) {
            tokenCache.delete(token);
            const err = new Error(result.message || 'Token verification failed');
            err.status = result.message?.includes('device') ? 403 : 401;
            throw err;
        }

        // Cache the successful result
        tokenCache.set(token, {
            ts: Date.now(),
            deviceId: deviceId,
            data: result.user
        });

        return result.user;
    }

    /**
     * Invalidate the token cache for a specific token.
     */
    invalidateCache(token) {
        tokenCache.delete(token);
    }

    /**
     * Clear the entire token cache.
     */
    clearCache() {
        tokenCache.clear();
    }

    // ---- Admin API (forwarded from Node admin routes) ----

    async getUsers(token, statusFilter = null) {
        const qs = statusFilter ? `?status=${statusFilter}` : '';
        return this._get(`/api/users.php${qs}`, token);
    }

    async getStats(token) {
        return this._get('/api/users.php?action=stats', token);
    }

    async updateUser(token, userId, updates) {
        return this._request('/api/users.php', {
            method: 'PUT',
            body: JSON.stringify({ id: userId, ...updates }),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
    }

    async deleteUser(token, userId) {
        return this._request(`/api/users.php?id=${userId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
    }

    // ---- Internal HTTP helpers ----

    async _post(endpoint, body, bearerToken = null) {
        const headers = { 'Content-Type': 'application/json' };
        if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

        return this._request(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
    }

    async _get(endpoint, bearerToken = null) {
        const headers = {};
        if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

        return this._request(endpoint, { method: 'GET', headers });
    }

    async _request(endpoint, options) {
        const url = `${this.baseUrl}${endpoint}`;
        try {
            const res = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(10000), // 10s timeout
            });

            const data = await res.json();
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                return { ...data, status: res.status };
            }
            return { data, status: res.status };
        } catch (err) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                return { error: true, message: 'License server timeout', status: 504 };
            }
            console.error('[LicenseService] Request failed:', err.message);
            return { error: true, message: 'License server unreachable', status: 503 };
        }
    }
}

// Singleton — configured from settings or environment
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new LicenseService(licenseServerUrl);
    }
    return instance;
}

function configure(baseUrl) {
    instance = new LicenseService(baseUrl);
    return instance;
}

module.exports = { LicenseService, getInstance, configure };
