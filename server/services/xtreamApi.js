/**
 * Xtream Codes API v2 Client
 * Handles authentication and API calls to Xtream servers
 */

class XtreamApi {
    constructor(baseUrl, username, password) {
        // Clean up base URL
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.username = username;
        this.password = password;
    }

    /**
     * Build API URL with authentication
     */
    buildApiUrl(action, params = {}) {
        const url = new URL(`${this.baseUrl}/player_api.php`);
        url.searchParams.set('username', this.username);
        url.searchParams.set('password', this.password);
        if (action) {
            url.searchParams.set('action', action);
        }
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, value);
            }
        }
        return url.toString();
    }

    /**
     * Make API request
     */
    async request(action, params = {}) {
        const url = this.buildApiUrl(action, params);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Xtream API error: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Authenticate and get server/user info
     */
    async authenticate() {
        const data = await this.request(null);
        if (!data.user_info) {
            throw new Error('Invalid credentials or server response');
        }
        return data;
    }

    // ==========================================
    // LIVE TV
    // ==========================================

    async getLiveCategories() {
        const data = await this.request('get_live_categories');
        if (!Array.isArray(data)) return [];

        return data.map(cat => ({
            ...cat,
            category_id: cat.category_id != null ? `live_${cat.category_id}` : null
        }));
    }

    async getLiveStreams(categoryId = null) {
        // Strip prefix before sending to provider
        const cleanId = categoryId ? categoryId.toString().replace('live_', '') : null;
        const params = cleanId ? { category_id: cleanId } : {};

        const data = await this.request('get_live_streams', params);
        if (!Array.isArray(data)) return [];

        return data.map(stream => {
            // Live TV channels use tv_genre_id as their folder key.
            // Fall back to category_id for providers that populate it instead.
            let rawId = stream.category_id;
            if (stream.tv_genre_id != null && stream.tv_genre_id !== '') {
                rawId = stream.tv_genre_id;
            }

            return {
                ...stream,
                category_id: rawId != null ? `live_${rawId}` : null
            };
        });
    }

    // ==========================================
    // VOD (MOVIES)
    // ==========================================

    async getVodCategories() {
        const data = await this.request('get_vod_categories');
        if (!Array.isArray(data)) return [];

        return data.map(cat => ({
            ...cat,
            category_id: cat.category_id != null ? `vod_${cat.category_id}` : null
        }));
    }

    async getVodStreams(categoryId = null) {
        const cleanId = categoryId ? categoryId.toString().replace('vod_', '') : null;
        const params = cleanId ? { category_id: cleanId } : {};

        const data = await this.request('get_vod_streams', params);
        if (!Array.isArray(data)) return [];

        return data.map(stream => ({
            ...stream,
            category_id: stream.category_id != null ? `vod_${stream.category_id}` : null
        }));
    }

    /**
     * Get VOD info
     */
    async getVodInfo(vodId) {
        return this.request('get_vod_info', { vod_id: vodId });
    }

    // ==========================================
    // SERIES
    // ==========================================

    async getSeriesCategories() {
        const data = await this.request('get_series_categories');
        if (!Array.isArray(data)) return [];

        return data.map(cat => ({
            ...cat,
            category_id: cat.category_id != null ? `series_${cat.category_id}` : null
        }));
    }

    async getSeries(categoryId = null) {
        const cleanId = categoryId ? categoryId.toString().replace('series_', '') : null;
        const params = cleanId ? { category_id: cleanId } : {};

        const data = await this.request('get_series', params);
        if (!Array.isArray(data)) return [];

        return data.map(series => ({
            ...series,
            category_id: series.category_id != null ? `series_${series.category_id}` : null
        }));
    }

    /**
     * Get series info
     */
    async getSeriesInfo(seriesId) {
        return this.request('get_series_info', { series_id: seriesId });
    }

    /**
     * Get short EPG for a stream
     */
    async getShortEpg(streamId, limit = 10) {
        return this.request('get_short_epg', { stream_id: streamId, limit });
    }

    /**
     * Get full EPG for a stream
     */
    async getSimpleDateTable(streamId) {
        return this.request('get_simple_data_table', { stream_id: streamId });
    }

    /**
     * Build stream URL for playback
     */
    buildStreamUrl(streamId, type = 'live', container = 'ts') {
        const typeMap = {
            live: 'live',
            vod: 'movie',
            series: 'series'
        };
        const streamType = typeMap[type] || 'live';
        return `${this.baseUrl}/${streamType}/${this.username}/${this.password}/${streamId}.${container}`;
    }

    /**
     * Get XMLTV EPG URL
     */
    getXmltvUrl() {
        return `${this.baseUrl}/xmltv.php?username=${this.username}&password=${this.password}`;
    }
}

/**
 * Factory function to create API instance from source
 */
function createFromSource(source) {
    return new XtreamApi(source.url, source.username, source.password);
}

/**
 * Static authenticate for testing
 */
async function authenticate(url, username, password) {
    const api = new XtreamApi(url, username, password);
    return api.authenticate();
}

module.exports = { XtreamApi, createFromSource, authenticate };
