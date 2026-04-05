/**
 * Stalker Portal (Ministra/Middleware) API Client
 * Handles authentication, channel/VOD fetching, and stream URL resolution
 */

const crypto = require('crypto');

const STB_USER_AGENT = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
const X_USER_AGENT = 'Model: MAG250; Link: WiFi';

class StalkerApi {
    constructor(portalUrl, mac, options = {}) {
        this.portalUrl = portalUrl.replace(/\/+$/, '');
        this.mac = mac;
        this.token = null;
        this.tokenTimestamp = 0;
        this.tokenValidity = 3600; // seconds

        // Optional fields
        this.serialNumber = options.serialNumber || this._generateSerial(mac);
        this.deviceId = options.deviceId || this._generateDeviceId(mac);
        this.deviceId2 = options.deviceId2 || this.deviceId;
        this.adultPassword = options.adultPassword || null;

        // Optional Xtream login (some portals support it)
        this.username = options.username || null;
        this.password = options.password || null;

        // Determine the server load.php path
        this.serverUrl = this._resolveServerUrl(this.portalUrl);
        this.referrer = this._resolveReferrer(this.portalUrl);
    }

    /**
     * Resolve the server load.php URL from portal URL
     */
    _resolveServerUrl(portalUrl) {
        // If URL already contains load.php or portal.php, use it directly
        if (portalUrl.includes('load.php') || portalUrl.includes('portal.php')) {
            return portalUrl;
        }

        // Strip trailing /c/ or /c if present
        let base = portalUrl.replace(/\/c\/?$/, '');

        // Check if stalker_portal is in the path
        if (base.includes('/stalker_portal')) {
            return `${base}/server/load.php`;
        }

        // Try standard stalker_portal path
        return `${base}/server/load.php`;
    }

    /**
     * Resolve the Referer header
     */
    _resolveReferrer(portalUrl) {
        let base = portalUrl.replace(/\/c\/?$/, '');
        if (!base.endsWith('/c')) {
            base += '/c';
        }
        return base + '/';
    }

    /**
     * Generate serial number from MAC: MD5(mac)[:13].toUpperCase()
     */
    _generateSerial(mac) {
        return crypto.createHash('md5').update(mac).digest('hex').substring(0, 13).toUpperCase();
    }

    /**
     * Generate device ID from MAC: SHA256(mac).toUpperCase()
     */
    _generateDeviceId(mac) {
        return crypto.createHash('sha256').update(mac).digest('hex').toUpperCase();
    }

    /**
     * Build common headers for all requests
     */
    _buildHeaders(includeAuth = true) {
        const encodedMac = encodeURIComponent(this.mac);
        const headers = {
            'User-Agent': STB_USER_AGENT,
            'X-User-Agent': X_USER_AGENT,
            'Referer': this.referrer,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'close',
            'Cookie': `mac=${encodedMac}; stb_lang=en; timezone=America/New_York`
        };

        if (includeAuth && this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
            headers['Cookie'] += `; token=${this.token}`;
        }

        return headers;
    }

    /**
     * Make a request to the Stalker Portal API
     */
    async _request(type, action, params = {}, requiresAuth = true, _isRetry = false) {
        if (requiresAuth) {
            await this._ensureToken();
        }

        const url = new URL(this.serverUrl);
        url.searchParams.set('type', type);
        url.searchParams.set('action', action);
        url.searchParams.set('JsHttpRequest', '1-xml');

        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, String(value));
            }
        }

        const headers = this._buildHeaders(requiresAuth);

        // Small delay between API calls to avoid rate limiting / token invalidation
        if (this._lastRequestTime) {
            const elapsed = Date.now() - this._lastRequestTime;
            if (elapsed < 100) {
                await new Promise(r => setTimeout(r, 100 - elapsed));
            }
        }

        const response = await fetch(url.toString(), {
            headers,
            redirect: 'follow'
        });

        this._lastRequestTime = Date.now();

        if (!response.ok) {
            throw new Error(`Stalker API error: ${response.status} ${response.statusText}`);
        }

        const text = await response.text();

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            // Non-JSON response — check if it's an auth failure and retry once
            if (!_isRetry && requiresAuth && text.includes('Authorization failed')) {
                console.warn(`[StalkerApi] Auth failed for ${type}/${action}, re-authenticating...`);
                this.token = null; // Force re-handshake
                this.tokenTimestamp = 0;
                await new Promise(r => setTimeout(r, 500)); // Brief pause
                return this._request(type, action, params, requiresAuth, true);
            }
            throw new Error(`Stalker API returned non-JSON: ${text.substring(0, 200)}`);
        }

        if (!data.js) {
            throw new Error('Invalid Stalker API response: missing js field');
        }

        return data.js;
    }

    /**
     * Ensure we have a valid token
     */
    async _ensureToken() {
        const now = Math.floor(Date.now() / 1000);
        if (this.token && (now - this.tokenTimestamp) < this.tokenValidity) {
            return; // Token is still valid
        }
        await this.handshake();
    }

    /**
     * Step 1: Handshake - get auth token
     */
    async handshake() {
        const url = new URL(this.serverUrl);
        url.searchParams.set('type', 'stb');
        url.searchParams.set('action', 'handshake');
        url.searchParams.set('token', '');
        url.searchParams.set('JsHttpRequest', '1-xml');

        const headers = this._buildHeaders(false);

        const response = await fetch(url.toString(), {
            headers,
            redirect: 'follow'
        });

        if (!response.ok) {
            // Try with generated token/prehash on 404
            if (response.status === 404) {
                return this._handshakeWithPrehash();
            }
            throw new Error(`Handshake failed: ${response.status} ${response.statusText}`);
        }

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error(`Handshake returned non-JSON: ${text.substring(0, 200)}`);
        }

        if (!data.js || !data.js.token) {
            throw new Error('Handshake failed: no token received');
        }

        this.token = data.js.token;
        this.tokenTimestamp = Math.floor(Date.now() / 1000);

        // Step 2: Get profile to register device and possibly get a new token
        await this._getProfile();
    }

    /**
     * Handshake with prehash (fallback for 404)
     */
    async _handshakeWithPrehash() {
        const generatedToken = crypto.randomBytes(16).toString('hex');
        const prehash = crypto.createHash('sha1').update(generatedToken).digest('hex');

        const url = new URL(this.serverUrl);
        url.searchParams.set('type', 'stb');
        url.searchParams.set('action', 'handshake');
        url.searchParams.set('token', generatedToken);
        url.searchParams.set('prehash', prehash);
        url.searchParams.set('JsHttpRequest', '1-xml');

        const headers = this._buildHeaders(false);

        const response = await fetch(url.toString(), {
            headers,
            redirect: 'follow'
        });

        if (!response.ok) {
            throw new Error(`Handshake (prehash) failed: ${response.status}`);
        }

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error(`Handshake (prehash) returned non-JSON: ${text.substring(0, 200)}`);
        }

        if (!data.js || !data.js.token) {
            throw new Error('Handshake (prehash) failed: no token received');
        }

        this.token = data.js.token;
        this.tokenTimestamp = Math.floor(Date.now() / 1000);

        await this._getProfile();
    }

    /**
     * Step 2: Get profile - register device
     */
    async _getProfile() {
        const hwVersion2 = crypto.createHash('sha1').update(this.mac).digest('hex');
        const signature = crypto.createHash('sha256')
            .update(this.mac + this.serialNumber + this.deviceId + this.deviceId2)
            .digest('hex').toUpperCase();
        const timestamp = Math.floor(Date.now() / 1000);

        const metrics = JSON.stringify({
            mac: this.mac,
            sn: this.serialNumber,
            type: 'STB',
            model: 'MAG250',
            uid: '',
            random: crypto.randomBytes(8).toString('hex')
        });

        const params = {
            hd: 1,
            ver: 'ImageDescription: 0.2.18-r14-pub-250; ImageDate: Fri Jan 15 2016; PORTAL version: 5.5.0; API Version: JS API version: 328; STB API version: 134; Player Engine version: 0x566',
            num_banks: 2,
            sn: this.serialNumber,
            stb_type: 'MAG250',
            client_type: 'STB',
            image_version: 218,
            video_out: 'hdmi',
            device_id: this.deviceId,
            device_id2: this.deviceId2,
            signature: signature,
            auth_second_step: 1,
            hw_version: '1.7-BD-00',
            not_valid_token: 0,
            metrics: metrics,
            hw_version_2: hwVersion2,
            timestamp: timestamp,
            api_signature: 262,
            prehash: ''
        };

        try {
            const result = await this._request('stb', 'get_profile', params);

            // Profile may return a new token
            if (result.token) {
                this.token = result.token;
                this.tokenTimestamp = Math.floor(Date.now() / 1000);
            }

            return result;
        } catch (err) {
            // Some portals don't fully support get_profile but work anyway
            console.warn('[StalkerApi] get_profile warning:', err.message);
        }
    }

    /**
     * Get account info (expiry, parent password, etc.)
     */
    async getAccountInfo() {
        return this._request('account_info', 'get_main_info');
    }

    // ============================================================
    // Live TV (IPTV)
    // ============================================================

    /**
     * Get live TV categories (genres)
     */
    async getLiveCategories() {
        const result = await this._request('itv', 'get_genres');
        if (!Array.isArray(result)) return [];

        return result.map(cat => ({
            category_id: cat.id,
            category_name: cat.title || cat.alias || `Category ${cat.id}`
        }));
    }

    /**
     * Get all live channels (paginated)
     */
    async getLiveStreams(genreId = null) {
        const allChannels = [];
        let page = 1;
        let totalItems = Infinity;

        while (allChannels.length < totalItems) {
            const params = { p: page };
            if (genreId && genreId !== '*') {
                params.genre = genreId;
            }

            const result = await this._request('itv', 'get_ordered_list', params);

            if (result.total_items !== undefined) {
                totalItems = parseInt(result.total_items) || 0;
            }

            if (!result.data || result.data.length === 0) break;

            for (const ch of result.data) {
                allChannels.push({
                    stream_id: ch.id,
                    name: ch.name || `Channel ${ch.id}`,
                    stream_icon: ch.logo ? this._resolveLogoUrl(ch.logo) : null,
                    category_id: ch.tv_genre_id || ch.category_id || (genreId || 'uncategorized'),
                    cmd: ch.cmd,
                    use_http_tmp_link: ch.use_http_tmp_link,
                    epg_channel_id: ch.xmltv_id || null,
                    number: ch.number,
                    tv_archive: ch.enable_tv_archive === '1',
                    tv_archive_duration: parseInt(ch.tv_archive_duration) || 0
                });
            }

            page++;

            // Safety limit
            if (page > 500) break;
        }

        return allChannels;
    }

    /**
     * Get all channels at once (some portals support this)
     */
    async getAllChannels() {
        try {
            const result = await this._request('itv', 'get_all_channels');
            if (result.data && Array.isArray(result.data)) {
                return result.data.map(ch => ({
                    stream_id: ch.id,
                    name: ch.name || `Channel ${ch.id}`,
                    stream_icon: ch.logo ? this._resolveLogoUrl(ch.logo) : null,
                    category_id: ch.tv_genre_id || 'uncategorized',
                    cmd: ch.cmd,
                    use_http_tmp_link: ch.use_http_tmp_link,
                    epg_channel_id: ch.xmltv_id || null,
                    number: ch.number
                }));
            }
        } catch (err) {
            // Fallback to paginated approach
            console.warn('[StalkerApi] get_all_channels not supported, using pagination');
        }
        return this.getLiveStreams();
    }

    /**
     * Create a playable link for a live channel
     */
    async createLiveLink(cmd) {
        const result = await this._request('itv', 'create_link', {
            cmd: cmd,
            forced_storage: '',
            disable_ad: 0
        });
        return this._extractStreamUrl(result);
    }

    // ============================================================
    // VOD (Movies)
    // ============================================================

    /**
     * Get VOD categories
     */
    async getVodCategories() {
        const result = await this._request('vod', 'get_categories');
        if (!Array.isArray(result)) return [];

        return result.map(cat => ({
            category_id: cat.id,
            category_name: cat.title || cat.alias || `Category ${cat.id}`
        }));
    }

    /**
     * Get VOD streams (movies, paginated)
     */
    async getVodStreams(categoryId = null) {
        const allMovies = [];
        let page = 1;
        let totalItems = Infinity;

        while (allMovies.length < totalItems) {
            const params = { p: page };
            if (categoryId) {
                params.category = categoryId;
            }

            const result = await this._request('vod', 'get_ordered_list', params);

            if (result.total_items !== undefined) {
                totalItems = parseInt(result.total_items) || 0;
            }

            if (!result.data || result.data.length === 0) break;

            for (const item of result.data) {
                // Skip series items (they have is_series flag)
                if (item.is_series === '1' || item.is_series === 1) continue;

                allMovies.push({
                    stream_id: item.id,
                    name: item.name || `Movie ${item.id}`,
                    stream_icon: item.screenshot_uri || null,
                    category_id: item.category_id || categoryId || 'uncategorized',
                    cmd: item.cmd,
                    container_extension: 'mp4',
                    rating: parseFloat(item.rating) || null,
                    added: item.added || null,
                    year: item.year || null,
                    description: item.description || null
                });
            }

            page++;
            if (page > 500) break;
        }

        return allMovies;
    }

    /**
     * Create a playable link for a VOD item
     */
    async createVodLink(cmd) {
        const result = await this._request('vod', 'create_link', {
            cmd: cmd,
            forced_storage: '',
            disable_ad: 0
        });
        return this._extractStreamUrl(result);
    }

    /**
     * Create a playable link for a series episode.
     * If episode has its own cmd, use type=series create_link.
     * If not, use parentCmd + series={seriesNumber} (Series Array hack).
     */
    async createSeriesLink(cmd, seriesNumber = null) {
        // If we have a direct episode cmd, try type=series first
        if (cmd) {
            try {
                const params = { cmd, forced_storage: '', disable_ad: 0 };
                if (seriesNumber) params.series = seriesNumber;
                const result = await this._request('series', 'create_link', params);
                return this._extractStreamUrl(result);
            } catch (err) {
                console.warn('[StalkerApi] series create_link failed, trying vod:', err.message);
                try {
                    const params = { cmd, forced_storage: '', disable_ad: 0 };
                    if (seriesNumber) params.series = seriesNumber;
                    const result = await this._request('vod', 'create_link', params);
                    return this._extractStreamUrl(result);
                } catch (err2) {
                    throw new Error(`create_link failed for both series and vod: ${err2.message}`);
                }
            }
        }
        throw new Error('No cmd provided for series episode');
    }

    // ============================================================
    // Series
    // ============================================================

    /**
     * Get series categories (dedicated type=series endpoint)
     * Falls back to VOD categories if not supported
     */
    async getSeriesCategories() {
        try {
            const result = await this._request('series', 'get_categories');
            if (Array.isArray(result) && result.length > 0) {
                this._hasSeriesEndpoint = true;
                return result.map(cat => ({
                    category_id: cat.id,
                    category_name: cat.title || cat.alias || `Category ${cat.id}`
                }));
            }
        } catch (err) {
            console.warn('[StalkerApi] Dedicated series endpoint not available:', err.message);
        }
        // Fallback: reuse VOD categories
        this._hasSeriesEndpoint = false;
        return this.getVodCategories();
    }

    /**
     * Get series items — tries dedicated type=series endpoint first,
     * falls back to filtering VOD items by is_series flag
     */
    async getSeries(categoryId = null) {
        // Try dedicated series endpoint first
        try {
            const series = await this._getSeriesDedicated(categoryId);
            if (series.length > 0) return series;
        } catch (err) {
            console.warn('[StalkerApi] Dedicated series fetch failed, trying VOD fallback:', err.message);
        }

        // Fallback: filter VOD items by is_series flag
        return this._getSeriesFromVod(categoryId);
    }

    /**
     * Fetch series from dedicated type=series endpoint
     */
    async _getSeriesDedicated(categoryId = null) {
        const allSeries = [];
        let page = 1;
        let totalItems = Infinity;

        while (allSeries.length < totalItems) {
            const params = { p: page };
            if (categoryId) {
                params.category = categoryId;
            }

            const result = await this._request('series', 'get_ordered_list', params);

            if (result.total_items !== undefined) {
                totalItems = parseInt(result.total_items) || 0;
            }

            if (!result.data || result.data.length === 0) break;

            for (const item of result.data) {
                allSeries.push({
                    series_id: item.id,
                    name: item.name || `Series ${item.id}`,
                    cover: item.screenshot_uri || item.logo || null,
                    category_id: item.category_id || categoryId || 'uncategorized',
                    cmd: item.cmd,
                    rating: parseFloat(item.rating) || null,
                    year: item.year || null
                });
            }

            page++;
            if (page > 500) break;
        }

        return allSeries;
    }

    /**
     * Fallback: filter VOD items by is_series flag
     */
    async _getSeriesFromVod(categoryId = null) {
        const allSeries = [];
        let page = 1;
        let totalItems = Infinity;

        while (allSeries.length < totalItems) {
            const params = { p: page };
            if (categoryId) {
                params.category = categoryId;
            }

            const result = await this._request('vod', 'get_ordered_list', params);

            if (result.total_items !== undefined) {
                totalItems = parseInt(result.total_items) || 0;
            }

            if (!result.data || result.data.length === 0) break;

            for (const item of result.data) {
                if (item.is_series === '1' || item.is_series === 1) {
                    allSeries.push({
                        series_id: item.id,
                        name: item.name || `Series ${item.id}`,
                        cover: item.screenshot_uri || null,
                        category_id: item.category_id || categoryId || 'uncategorized',
                        cmd: item.cmd,
                        rating: parseFloat(item.rating) || null,
                        year: item.year || null
                    });
                }
            }

            page++;
            if (page > 500) break;
        }

        return allSeries;
    }

    /**
     * Get episodes for a series (three-tier: Show → Seasons → Episodes).
     *
     * Step 1: type=series&action=get_ordered_list&movie_id={id}
     *         Returns SEASONS, not episodes.
     *
     * Step 2: For each season, check for nested episodes (Scenario A),
     *         or make a second call with season_id (Scenario B).
     *
     * Each episode carries: cmd (if it has its own), parentCmd (season's cmd),
     * and seriesNumber — so playback can use the "Series Array" hack when
     * the episode lacks its own cmd.
     */
    async getSeriesInfo(seriesId) {
        try {
            // Step 1: Fetch seasons
            const seasonsResult = await this._request('series', 'get_ordered_list', {
                movie_id: seriesId,
                sortby: 'added'
            });

            if (!seasonsResult.data || seasonsResult.data.length === 0) {
                return null;
            }

            const seasons = seasonsResult.data;
            const episodes = {};

            for (const season of seasons) {
                const seasonName = season.name || `Season ${season.id}`;
                const seasonNumMatch = seasonName.match(/(\d+)/);
                const seasonNum = seasonNumMatch ? seasonNumMatch[1] : String(season.id);
                const parentCmd = season.cmd || null; // Season's cmd for fallback

                // Helper: map raw episode data to our format
                const mapEpisode = (ep, idx) => {
                    const epNum = parseInt(ep.episode) || parseInt(ep.series_number) || idx + 1;
                    return {
                        id: ep.id || ep.movie_id || ep.series_id || `${seriesId}_s${seasonNum}_e${epNum}`,
                        episode_num: epNum,
                        title: ep.name || ep.title || `Episode ${epNum}`,
                        container_extension: ep.container_extension || 'mp4',
                        duration: ep.duration || ep.time || '',
                        cmd: ep.cmd || null,
                        parentCmd: parentCmd,
                        seriesNumber: ep.series_number || ep.episode || String(epNum),
                        cover: ep.screenshot_uri || ep.logo || null
                    };
                };

                // Scenario A: Episodes nested inside the season object
                const nestedEps = season.series || season.episodes;
                if (Array.isArray(nestedEps) && nestedEps.length > 0) {
                    episodes[seasonNum] = nestedEps.map(mapEpisode);
                    continue;
                }

                // Scenario B: Second API call with season_id
                let fetched = false;
                try {
                    const epResult = await this._request('series', 'get_ordered_list', {
                        movie_id: seriesId,
                        season_id: season.id,
                        sortby: 'added'
                    });

                    if (epResult.data && epResult.data.length > 0) {
                        const epItems = epResult.data.filter(item =>
                            item.cmd ||
                            item.is_episode === 1 || item.is_episode === '1' ||
                            (item.name && !item.name.match(/^Season\s+\d+$/i))
                        );
                        if (epItems.length > 0) {
                            episodes[seasonNum] = epItems.map(mapEpisode);
                            fetched = true;
                        }
                    }
                } catch (err) {
                    // Will try category= next
                }

                // Try with category= instead of season_id= (some portals)
                if (!fetched) {
                    try {
                        const epResult2 = await this._request('series', 'get_ordered_list', {
                            movie_id: seriesId,
                            category: season.id,
                            sortby: 'added'
                        });
                        if (epResult2.data && epResult2.data.length > 0) {
                            const epItems = epResult2.data.filter(item =>
                                item.cmd || (item.name && !item.name.match(/^Season\s+\d+$/i))
                            );
                            if (epItems.length > 0) {
                                episodes[seasonNum] = epItems.map(mapEpisode);
                            }
                        }
                    } catch (err) {
                        console.warn(`[StalkerApi] Failed to fetch episodes for season ${season.id}:`, err.message);
                    }
                }
            }

            if (Object.keys(episodes).length > 0) {
                for (const s of Object.keys(episodes)) {
                    episodes[s].sort((a, b) => a.episode_num - b.episode_num);
                }
                return { episodes };
            }

            return null;
        } catch (err) {
            console.warn(`[StalkerApi] Series info fetch failed for ${seriesId}:`, err.message);
        }

        return null;
    }

    // ============================================================
    // EPG
    // ============================================================

    /**
     * Get short EPG for a channel
     */
    async getShortEpg(channelId, size = 10) {
        const result = await this._request('itv', 'get_short_epg', {
            ch_id: channelId,
            size: size
        });
        return result;
    }

    // ============================================================
    // Helpers
    // ============================================================

    /**
     * Extract the actual stream URL from create_link response
     */
    _extractStreamUrl(result) {
        let url = null;

        // Check result.cmd first (most common)
        if (result.cmd) {
            // Strip "ffmpeg " or "ffrt " prefix
            url = String(result.cmd).replace(/^(ffmpeg|ffrt)\s+/i, '').trim();
        }

        // Fallback to result.url
        if (!url && result.url) {
            url = result.url;
        }

        if (!url) {
            throw new Error('Failed to extract stream URL from create_link response');
        }

        return url;
    }

    /**
     * Resolve logo URL (may be relative)
     */
    _resolveLogoUrl(logo) {
        if (!logo) return null;
        if (logo.startsWith('http://') || logo.startsWith('https://')) {
            return logo;
        }
        // Construct from portal base URL
        const base = this.portalUrl.replace(/\/c\/?$/, '');
        return `${base}/misc/logos/320/${logo}`;
    }
}

/**
 * Factory function to create API instance from source config
 */
function createFromSource(source) {
    return new StalkerApi(source.url, source.mac, {
        serialNumber: source.serial_number || null,
        deviceId: source.device_id || null,
        deviceId2: source.device_id2 || null,
        adultPassword: source.adult_password || null,
        username: source.username || null,
        password: source.password || null
    });
}

/**
 * Test connection to a Stalker Portal
 */
async function testConnection(url, mac, options = {}) {
    const api = new StalkerApi(url, mac, options);
    await api.handshake();

    // Try to get account info
    let accountInfo = null;
    try {
        accountInfo = await api.getAccountInfo();
    } catch (err) {
        // Some portals don't support account_info
    }

    return {
        success: true,
        token: api.token,
        accountInfo
    };
}

module.exports = { StalkerApi, createFromSource, testConnection };
