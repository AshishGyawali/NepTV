/**
 * Global Toast Notification System
 */
const Toast = {
    container: null,

    init() {
        if (this.container) return;
        this.container = document.createElement('div');
        this.container.id = 'toast-container';
        this.container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:400px;';
        document.body.appendChild(this.container);
    },

    show(message, type = 'error') {
        this.init();
        const toast = document.createElement('div');
        const colors = {
            error:   { bg: 'rgba(239,68,68,0.12)', border: '#ef4444', text: '#fca5a5', icon: '\u2716' },
            warning: { bg: 'rgba(245,158,11,0.12)', border: '#f59e0b', text: '#fcd34d', icon: '\u26A0' },
            success: { bg: 'rgba(16,185,129,0.12)', border: '#10b981', text: '#6ee7b7', icon: '\u2714' },
            info:    { bg: 'rgba(99,102,241,0.12)', border: '#6366f1', text: '#a5b4fc', icon: '\u2139' },
        };
        const c = colors[type] || colors.error;
        toast.style.cssText = `background:${c.bg};border:1px solid ${c.border};border-left:4px solid ${c.border};color:${c.text};padding:14px 18px;border-radius:10px;font-size:14px;font-family:Inter,-apple-system,sans-serif;backdrop-filter:blur(16px);pointer-events:auto;cursor:pointer;transform:translateX(120%);transition:transform .3s ease,opacity .3s ease;opacity:0;display:flex;align-items:flex-start;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,0.3);`;
        toast.innerHTML = `<span style="font-size:16px;flex-shrink:0;margin-top:1px">${c.icon}</span><span>${message}</span>`;
        toast.onclick = () => this.dismiss(toast);
        this.container.appendChild(toast);
        requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; toast.style.opacity = '1'; });
        setTimeout(() => this.dismiss(toast), 5000);
    },

    dismiss(toast) {
        toast.style.transform = 'translateX(120%)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    },

    // Convert technical errors to friendly messages
    friendlyMessage(error) {
        const msg = typeof error === 'string' ? error : (error.message || error.error || String(error));
        const map = [
            [/IP mismatch/i,                'Your network has changed. Please log in again.'],
            [/No token provided/i,          'Your session has expired. Please sign in again.'],
            [/Invalid or expired token/i,   'Your session has expired. Please sign in again.'],
            [/Session invalidated/i,        'You were logged in from another device. Please sign in again.'],
            [/Account is pending/i,         'Your account is awaiting admin approval.'],
            [/Account.*blocked/i,           'Your account has been suspended. Contact your administrator.'],
            [/Invalid credentials/i,        'Incorrect username or password.'],
            [/Username already taken/i,     'That username is already in use. Try a different one.'],
            [/Email already registered/i,   'That email is already registered.'],
            [/License server timeout/i,     'Authentication server is slow. Please try again.'],
            [/License server unreachable/i, 'Cannot reach authentication server. Please try later.'],
            [/Forbidden/i,                  'You don\'t have permission for this action.'],
            [/Server error/i,              'Something went wrong on our end. Please try again.'],
            [/fetch|network|ECONNREFUSED/i, 'Network issue. Check your connection and try again.'],
            [/transcode.*fail|FFmpeg/i,     'Video processing failed. Trying alternative playback.'],
        ];
        for (const [pattern, friendly] of map) {
            if (pattern.test(msg)) return friendly;
        }
        return msg;
    },

    error(msg)   { this.show(this.friendlyMessage(msg), 'error'); },
    warning(msg) { this.show(this.friendlyMessage(msg), 'warning'); },
    success(msg) { this.show(msg, 'success'); },
    info(msg)    { this.show(msg, 'info'); },
};

window.Toast = Toast;

/**
 * Device Fingerprint — generates a stable hash from hardware/OS traits.
 * Same device = same fingerprint across all browsers.
 * Uses: screen resolution, color depth, timezone, platform, CPU cores,
 * device memory, GPU renderer — things that are consistent per machine.
 */
function getDeviceId() {
    // Always use hardware fingerprint (not old random UUID).
    // Use a separate key so stale 'deviceId' values are ignored.
    let id = localStorage.getItem('deviceFingerprint');
    if (!id) {
        id = generateDeviceFingerprint();
        localStorage.setItem('deviceFingerprint', id);
        // Clean up old random UUID if present
        localStorage.removeItem('deviceId');
    }
    return id;
}

function generateDeviceFingerprint() {
    const parts = [];

    // Screen hardware
    parts.push(screen.width + 'x' + screen.height);
    parts.push(screen.colorDepth);
    parts.push(window.devicePixelRatio || 1);

    // OS / platform
    parts.push(navigator.platform);
    parts.push(navigator.hardwareConcurrency || 'unknown');
    parts.push(navigator.deviceMemory || 'unknown');

    // Timezone
    parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone);

    // GPU renderer (most unique per-device trait)
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (ext) {
                parts.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
            }
        }
    } catch (e) {}

    // Hash the combined string into a stable ID
    const raw = parts.join('|');
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        const chr = raw.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    // Convert to hex-like UUID format
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    const hash2 = raw.split('').reduce((a, c) => ((a << 3) - a + c.charCodeAt(0)) | 0, 0);
    const hex2 = Math.abs(hash2).toString(16).padStart(8, '0');
    return `${hex}-${hex2}-${raw.length.toString(16).padStart(4, '0')}`;
}

/**
 * Global fetch interceptor — auto-injects Authorization header
 * and X-Device-Id for all requests to /api/ endpoints.
 */
(function() {
    const originalFetch = window.fetch;
    window.fetch = function(url, options = {}) {
        const urlStr = typeof url === 'string' ? url : (url instanceof Request ? url.url : String(url));
        if (urlStr.startsWith('/api/')) {
            options = { ...options };
            options.headers = new Headers(options.headers || {});
            const token = localStorage.getItem('authToken');
            if (token && !options.headers.has('Authorization')) {
                options.headers.set('Authorization', `Bearer ${token}`);
            }
            options.headers.set('X-Device-Id', getDeviceId());
        }
        return originalFetch.call(this, url, options);
    };
})();

/**
 * API Client - Frontend API wrapper for NodeCast TV
 */

const API = {
    /**
     * Get stored auth token
     */
    getToken() {
        return localStorage.getItem('authToken');
    },

    /**
     * Append auth token + device ID to a URL as query params (for video/image elements that can't send headers)
     */
    withToken(url) {
        const token = localStorage.getItem('authToken');
        if (!token) return url;
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}token=${encodeURIComponent(token)}&deviceId=${encodeURIComponent(getDeviceId())}`;
    },

    /**
     * Set auth token (null to clear)
     */
    setToken(token) {
        if (token) {
            localStorage.setItem('authToken', token);
        } else {
            localStorage.removeItem('authToken');
        }
    },

    /**
     * Make API request
     */
    async request(method, endpoint, data = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        // Add authentication token if available
        const token = localStorage.getItem('authToken');
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        if (data) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(`/api${endpoint}`, options);

        let result;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            result = await response.json();
        } else {
            const text = await response.text();
            result = { error: text || 'API request failed' };
        }

        if (!response.ok) {
            const errorMsg = result.error || `Server responded with ${response.status}`;

            // If unauthorized, show toast and redirect to login
            if (response.status === 401) {
                Toast.error(errorMsg);
                localStorage.removeItem('authToken');
                setTimeout(() => { window.location.href = '/login.html'; }, 1500);
                return;
            }

            // Show friendly toast for all other errors
            if (response.status === 403) {
                Toast.warning(errorMsg);
            } else {
                Toast.error(errorMsg);
            }

            throw new Error(errorMsg);
        }

        return result;
    },

    // Sources
    sources: {
        getAll: () => API.request('GET', '/sources'),
        getByType: (type) => API.request('GET', `/sources/type/${type}`),
        getById: (id) => API.request('GET', `/sources/${id}`),
        create: (data) => API.request('POST', '/sources', data),
        update: (id, data) => API.request('PUT', `/sources/${id}`, data),
        delete: (id) => API.request('DELETE', `/sources/${id}`),
        toggle: (id) => API.request('POST', `/sources/${id}/toggle`),
        test: (id) => API.request('POST', `/sources/${id}/test`),
        sync: (id) => API.request('POST', `/sources/${id}/sync`), // Manual sync
        getStatus: () => API.request('GET', '/sources/status'), // Get all statuses
        estimate: (id) => API.request('GET', `/sources/${id}/estimate`), // Estimate M3U size
        estimateByUrl: (url, type) => API.request('POST', '/sources/estimate', { url, type }), // Estimate by URL (before creation)
    },

    // Channels (hidden items)
    channels: {
        getHidden: (sourceId = null) => API.request('GET', `/channels/hidden${sourceId ? `?sourceId=${sourceId}` : ''}`),
        hide: (sourceId, itemType, itemId) => API.request('POST', '/channels/hide', { sourceId, itemType, itemId }),
        show: (sourceId, itemType, itemId) => API.request('POST', '/channels/show', { sourceId, itemType, itemId }),
        isHidden: (sourceId, itemType, itemId) => API.request('GET', `/channels/hidden/check?sourceId=${sourceId}&itemType=${itemType}&itemId=${itemId}`),
        bulkHide: (items) => API.request('POST', '/channels/hide/bulk', { items }),
        bulkShow: (items) => API.request('POST', '/channels/show/bulk', { items }),
        // Fast bulk operations - single SQL statement
        showAll: (sourceId, contentType) => API.request('POST', '/channels/show/all', { sourceId, contentType }),
        hideAll: (sourceId, contentType) => API.request('POST', '/channels/hide/all', { sourceId, contentType })
    },

    // Favorites
    favorites: {
        getAll: (sourceId = null, itemType = null) => {
            let url = '/favorites';
            const params = [];
            if (sourceId) params.push(`sourceId=${sourceId}`);
            if (itemType) params.push(`itemType=${itemType}`);
            if (params.length) url += '?' + params.join('&');
            return API.request('GET', url);
        },
        add: (sourceId, itemId, itemType = 'channel') =>
            API.request('POST', '/favorites', { sourceId, itemId, itemType }),
        remove: (sourceId, itemId, itemType = 'channel') =>
            API.request('DELETE', '/favorites', { sourceId, itemId, itemType }),
        check: (sourceId, itemId, itemType = 'channel') =>
            API.request('GET', `/favorites/check?sourceId=${sourceId}&itemId=${itemId}&itemType=${itemType}`)
    },

    // Proxy
    proxy: {
        // Xtream
        xtream: {
            auth: (sourceId) => API.request('GET', `/proxy/xtream/${sourceId}/auth`),
            liveCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/live_categories${params}`);
            },
            liveStreams: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/live_streams${query}`);
            },
            vodCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/vod_categories${params}`);
            },
            vodStreams: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/vod_streams${query}`);
            },
            seriesCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/series_categories${params}`);
            },
            series: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/series${query}`);
            },
            seriesInfo: (sourceId, seriesId) =>
                API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${seriesId}`),
            shortEpg: (sourceId, streamId) => API.request('GET', `/proxy/xtream/${sourceId}/short_epg?stream_id=${streamId}`),
            getStreamUrl: (sourceId, streamId, type = 'live', container = 'm3u8') =>
                API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${type}?container=${container}`)
        },

        // Stalker Portal
        stalker: {
            getStreamUrl: (sourceId, streamId, type = 'live') =>
                API.request('GET', `/proxy/stalker/${sourceId}/stream/${streamId}/${type}`)
        },

        // EPG
        epg: {
            get: (sourceId) => API.request('GET', `/proxy/epg/${sourceId}`),
            getForChannels: (sourceId, channelIds) => API.request('POST', `/proxy/epg/${sourceId}/channels`, { channelIds })
        },

        // Cache management
        cache: {
            clear: (sourceId) => API.request('DELETE', `/proxy/cache/${sourceId}`)
        }
    },

    // Settings
    settings: {
        get: () => API.request('GET', '/settings'),
        update: (data) => API.request('PUT', '/settings', data),
        reset: () => API.request('DELETE', '/settings'),
        getDefaults: () => API.request('GET', '/settings/defaults')
    },

    // Auth helpers
    auth: {
        checkSetup: () => API.request('GET', '/auth/setup-required'),
        setup: (username, password) => API.request('POST', '/auth/setup', { username, password }),
        login: (username, password) => API.request('POST', '/auth/login', { username, password }),
        register: (username, password, email) => API.request('POST', '/auth/register', { username, password, email }),
        logout: () => API.request('POST', '/auth/logout'),
        me: () => API.request('GET', '/auth/me'),
        mode: () => API.request('GET', '/auth/mode'),
    },

    // Users (admin only)
    users: {
        getAll: () => API.request('GET', '/auth/users'),
        create: (data) => API.request('POST', '/auth/users', data),
        update: (id, data) => API.request('PUT', `/auth/users/${id}`, data),
        delete: (id) => API.request('DELETE', `/auth/users/${id}`)
    }
};

// Make API available globally
window.API = API;
