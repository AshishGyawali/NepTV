const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { getDb } = require('../db/sqlite'); // Import SQLite
const xtreamApi = require('../services/xtreamApi');
const stalkerApi = require('../services/stalkerApi');
const epgParser = require('../services/epgParser');
const cache = require('../services/cache');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { Readable } = require('stream');

// Default cache max age in hours
const DEFAULT_MAX_AGE_HOURS = 24;

// MAG STB headers for Stalker portal stream proxying
const STALKER_STB_USER_AGENT = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250/1.1.0';

// Relaxed HTTPS agent for Stalker streams with outdated TLS
const stalkerHttpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'ALL'
});

// Helper to get formatted category list from DB
function getCategoriesFromDb(sourceId, type, includeHidden = false) {
    const db = getDb();
    let query = `
        SELECT category_id, name as category_name, parent_id 
        FROM categories 
        WHERE source_id = ? AND type = ?
    `;
    if (!includeHidden) {
        query += ` AND is_hidden = 0`;
    }
    query += ` ORDER BY name ASC`;
    const cats = db.prepare(query).all(sourceId, type);
    return cats;
}

// Helper to get formatted streams from DB
function getStreamsFromDb(sourceId, type, categoryId = null, includeHidden = false) {
    const db = getDb();
    let query = `
        SELECT item_id, name, stream_icon, added_at, rating, container_extension, year, category_id, data
        FROM playlist_items 
        WHERE source_id = ? AND type = ?
    `;
    if (!includeHidden) {
        query += ` AND is_hidden = 0`;
    }
    const params = [sourceId, type];

    if (categoryId) {
        query += ` AND category_id = ?`;
        params.push(categoryId);
    }

    // Default sorting
    // query += ` ORDER BY name ASC`; // Sorting usually handled by client

    const items = db.prepare(query).all(...params);

    // Map to Xtream format
    return items.map(item => {
        const data = JSON.parse(item.data || '{}');
        // Override with our local fields if needed, or just return the mixed object
        // We should ensure critical fields are present
        return {
            ...data,
            stream_id: item.item_id, // ensure ID matches what client expects
            series_id: type === 'series' ? item.item_id : undefined,
            name: item.name,
            stream_icon: item.stream_icon,
            cover: item.stream_icon, // series/vod often use cover
            added: item.added_at,
            rating: item.rating,
            container_extension: item.container_extension,
            category_id: item.category_id,
            // Normalize EPG channel ID: Xtream uses epg_channel_id, M3U uses tvgId
            epg_channel_id: data.epg_channel_id || data.tvgId || null
        };
    });
}


// --- Xtream Codes Proxy API --- //

// Login / Authenticate
router.get('/xtream/:sourceId', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') return res.status(404).send('Source not found');

        // Proxy auth check to upstream to ensure credentials are still valid

        const cached = cache.get('xtream', source.id, 'auth', 300000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source);
        const data = await api.authenticate();
        cache.set('xtream', source.id, 'auth', data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// Live Categories
router.get('/xtream/:sourceId/live_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cats = getCategoriesFromDb(sourceId, 'live', includeHidden);
        res.json(cats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Live Streams
router.get('/xtream/:sourceId/live_streams', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        const streams = getStreamsFromDb(sourceId, 'live', categoryId, includeHidden);
        res.json(streams);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// VOD Categories
router.get('/xtream/:sourceId/vod_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cats = getCategoriesFromDb(sourceId, 'movie', includeHidden);
        res.json(cats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// VOD Streams (with on-demand stalker loading)
router.get('/xtream/:sourceId/vod_streams', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';

        let streams = getStreamsFromDb(sourceId, 'movie', categoryId, includeHidden);

        // Stalker on-demand: if no items in DB, fetch from portal
        if (streams.length === 0) {
            const source = await sources.getById(sourceId);
            if (source && source.type === 'stalker') {
                const syncService = require('../services/syncService');
                if (categoryId) {
                    // Fetch single category
                    await syncService.stalkerOnDemandFetch(source, 'movie', categoryId);
                } else {
                    // No category selected: fetch first few categories to populate
                    const cats = getCategoriesFromDb(sourceId, 'movie', includeHidden);
                    const toFetch = cats.slice(0, 5); // Fetch first 5 categories
                    for (const cat of toFetch) {
                        await syncService.stalkerOnDemandFetch(source, 'movie', cat.category_id);
                    }
                }
                streams = getStreamsFromDb(sourceId, 'movie', categoryId, includeHidden);
            }
        }

        res.json(streams);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series Categories
router.get('/xtream/:sourceId/series_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cats = getCategoriesFromDb(sourceId, 'series', includeHidden);
        res.json(cats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series (with on-demand stalker loading)
router.get('/xtream/:sourceId/series', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';

        let streams = getStreamsFromDb(sourceId, 'series', categoryId, includeHidden);

        // Stalker on-demand: if no items in DB, fetch from portal
        if (streams.length === 0) {
            const source = await sources.getById(sourceId);
            if (source && source.type === 'stalker') {
                const syncService = require('../services/syncService');
                if (categoryId) {
                    await syncService.stalkerOnDemandFetch(source, 'series', categoryId);
                } else {
                    const cats = getCategoriesFromDb(sourceId, 'series', includeHidden);
                    const toFetch = cats.slice(0, 5);
                    for (const cat of toFetch) {
                        await syncService.stalkerOnDemandFetch(source, 'series', cat.category_id);
                    }
                }
                streams = getStreamsFromDb(sourceId, 'series', categoryId, includeHidden);
            }
        }

        res.json(streams);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series Info (Episodes)
// Proxy series info request (supports xtream and stalker sources)
router.get('/xtream/:sourceId/series_info', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source) return res.status(404).send('Source not found');

        const seriesId = req.query.series_id;
        if (!seriesId) return res.status(400).send('series_id required');

        const cacheKey = `series_info_${seriesId}`;
        const cacheType = source.type === 'stalker' ? 'stalker' : 'xtream';
        const cached = cache.get(cacheType, source.id, cacheKey, 3600000);
        if (cached) return res.json(cached);

        let data;
        if (source.type === 'stalker') {
            const api = stalkerApi.createFromSource(source);
            data = await api.getSeriesInfo(seriesId);

            if (!data) {
                // Scenario B (Indian/VOD portals): series item is directly playable
                const db = getDb();
                const item = db.prepare(
                    'SELECT * FROM playlist_items WHERE source_id = ? AND item_id = ? AND type = ?'
                ).get(source.id, seriesId, 'series');

                if (item) {
                    const itemData = JSON.parse(item.data || '{}');
                    data = {
                        episodes: {
                            '1': [{
                                id: item.item_id,
                                episode_num: 1,
                                title: item.name || 'Play',
                                container_extension: item.container_extension || 'mp4',
                                duration: '',
                                cmd: itemData.cmd
                            }]
                        }
                    };
                } else {
                    return res.json({ episodes: {} });
                }
            }

            // Save episode data to DB so the stalker stream endpoint can resolve them.
            // Stores cmd, parentCmd, and seriesNumber for the "Series Array" fallback.
            if (data && data.episodes) {
                const db = getDb();
                const stmt = db.prepare(`
                    INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_icon, container_extension, data)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data
                `);
                const insertBatch = db.transaction((eps) => {
                    for (const ep of eps) {
                        // Episode is playable if it has its own cmd OR a parentCmd
                        if (ep.cmd || ep.parentCmd) {
                            stmt.run(
                                `${source.id}:${ep.id}`,
                                source.id,
                                String(ep.id),
                                'series',
                                ep.title || `Episode ${ep.episode_num}`,
                                seriesId,
                                ep.cover || null,
                                ep.container_extension || 'mp4',
                                JSON.stringify({
                                    cmd: ep.cmd || null,
                                    parentCmd: ep.parentCmd || null,
                                    seriesNumber: ep.seriesNumber || null
                                })
                            );
                        }
                    }
                });
                const allEps = Object.values(data.episodes).flat();
                insertBatch(allEps);
            }
        } else {
            const api = xtreamApi.createFromSource(source);
            data = await api.getSeriesInfo(seriesId);

            // Normalize Xtream response: ensure episodes is an object with season keys
            if (data && data.episodes) {
                if (Array.isArray(data.episodes)) {
                    data.episodes = { "1": data.episodes };
                }
            }

            // Fallback: if Xtream returned no episodes (common for season-split entries
            // like "Show Name S04" which is listed as its own series_id), look up the
            // item in the DB and offer it as a single playable entry.
            const hasEpisodes = data && data.episodes &&
                typeof data.episodes === 'object' &&
                Object.keys(data.episodes).length > 0 &&
                Object.values(data.episodes).some(arr => Array.isArray(arr) && arr.length > 0);

            if (!hasEpisodes) {
                const db = getDb();
                const item = db.prepare(
                    'SELECT * FROM playlist_items WHERE source_id = ? AND item_id = ? AND type = ?'
                ).get(source.id, seriesId, 'series');

                if (item) {
                    data = data || {};
                    data.episodes = {
                        '1': [{
                            id: item.item_id,
                            episode_num: 1,
                            title: item.name || 'Play',
                            container_extension: item.container_extension || 'mp4',
                            duration: ''
                        }]
                    };
                }
            }
        }

        if (data && data.episodes) {
            data.seasons = data.seasons || Object.keys(data.episodes).map(s => ({
                season_number: parseInt(s),
                name: `Season ${s}`
            }));
        }

        cache.set(cacheType, source.id, cacheKey, data);
        res.json(data);
    } catch (err) {
        console.error(`[Proxy] series_info error:`, err.message);
        res.json({ episodes: {}, seasons: [] });
    }
});

// VOD Info
router.get('/xtream/:sourceId/vod_info', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source) return res.status(404).send('Source not found');

        const vodId = req.query.vod_id;
        if (!vodId) return res.status(400).send('vod_id required');

        const cacheKey = `vod_info_${vodId}`;
        const cached = cache.get('xtream', source.id, cacheKey, 3600000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source);
        const data = await api.getVodInfo(vodId);
        cache.set('xtream', source.id, cacheKey, data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// Get Stream URL for playback
// Returns the direct stream URL for a given stream ID
router.get('/xtream/:sourceId/stream/:streamId/:type', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }

        const streamId = req.params.streamId;
        const type = req.params.type || 'live';
        const container = req.query.container || 'm3u8';

        // Construct the Xtream stream URL
        // Format: http://server:port/live/username/password/streamId.container (for live)
        // Format: http://server:port/movie/username/password/streamId.container (for movie)
        // Format: http://server:port/series/username/password/streamId.container (for series)

        let streamUrl;
        const baseUrl = source.url.replace(/\/$/, ''); // Remove trailing slash

        if (type === 'live') {
            streamUrl = `${baseUrl}/live/${source.username}/${source.password}/${streamId}.${container}`;
        } else if (type === 'movie') {
            streamUrl = `${baseUrl}/movie/${source.username}/${source.password}/${streamId}.${container}`;
        } else if (type === 'series') {
            streamUrl = `${baseUrl}/series/${source.username}/${source.password}/${streamId}.${container}`;
        } else {
            return res.status(400).json({ error: 'Invalid stream type' });
        }

        res.json({ url: streamUrl });
    } catch (err) {
        console.error('Error getting stream URL:', err);
        res.status(500).json({ error: 'Failed to get stream URL' });
    }
});


// --- Stalker Portal Proxy Routes --- //

// Get stream URL for Stalker portal (resolves via create_link)
router.get('/stalker/:sourceId/stream/:streamId/:type', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'stalker') {
            return res.status(404).json({ error: 'Stalker source not found' });
        }

        const { streamId, type } = req.params;

        // Get the item data from DB to find the cmd
        const db = getDb();
        const itemType = type === 'movie' ? 'movie' : type === 'series' ? 'series' : 'live';
        const item = db.prepare(
            'SELECT data FROM playlist_items WHERE source_id = ? AND item_id = ? AND type = ?'
        ).get(parseInt(req.params.sourceId), streamId, itemType);

        if (!item) {
            return res.status(404).json({ error: 'Stream not found' });
        }

        const itemData = JSON.parse(item.data || '{}');
        const cmd = itemData.cmd;
        const parentCmd = itemData.parentCmd;
        const seriesNumber = itemData.seriesNumber;

        // For series: need either own cmd or parentCmd
        // For live/movie: need cmd
        if (!cmd && !parentCmd) {
            return res.status(400).json({ error: 'No stream command found for this item' });
        }

        // Use cached URL if available (short TTL - 5 minutes)
        const cacheKey = `stalker_link_${streamId}_${type}`;
        const cached = cache.get('stalker', req.params.sourceId, cacheKey, 300000);
        if (cached) {
            return res.json({ url: cached });
        }

        // Create the API instance and resolve the link
        const api = stalkerApi.createFromSource(source);

        let streamUrl;
        if (type === 'live') {
            streamUrl = await api.createLiveLink(cmd);
        } else if (type === 'series') {
            // Use episode's own cmd if available, otherwise parent season's cmd + series number
            const effectiveCmd = cmd || parentCmd;
            const effectiveSeriesNum = !cmd ? seriesNumber : null;
            streamUrl = await api.createSeriesLink(effectiveCmd, effectiveSeriesNum);
        } else {
            streamUrl = await api.createVodLink(cmd);
        }

        // Cache the resolved URL
        cache.set('stalker', req.params.sourceId, cacheKey, streamUrl);

        res.json({ url: streamUrl });
    } catch (err) {
        console.error('Stalker stream URL error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Stalker portal categories/streams use the same DB-backed endpoints as xtream
// (getCategoriesFromDb / getStreamsFromDb already work for any source type)

// --- Other Proxy Routes --- //

// M3U Playlist 
// (For M3U sources, we now have data in DB. We can reconstruct M3U or return JSON)
// Frontend ChannelList.js for M3U sources calls `API.proxy.m3u.get(sourceId)`
// which points here. It expects { channels, groups }.
router.get('/m3u/:sourceId', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';

        // Fetch from DB
        const channels = getStreamsFromDb(sourceId, 'live', null, includeHidden);
        const groups = getCategoriesFromDb(sourceId, 'live', includeHidden);

        // Format for frontend helper
        // ChannelList expects:
        // { 
        //   channels: [ { id, name, groupTitle, url, tvgLogo, ... } ], 
        //   groups: [ { id, name, channelCount } ] 
        // }
        // Note: DB `live` items from M3U sync have `category_id` as their group name usually.

        const reformattedChannels = channels.map(c => ({
            ...c,
            id: c.stream_id,
            groupTitle: c.category_id || 'Uncategorized',
            url: c.stream_url || c.url,
            tvgLogo: c.stream_icon
        }));

        const reformattedGroups = groups.map(g => ({
            id: g.category_id,
            name: g.category_name,
            channelCount: 0 // Frontend calculates this or we can
        }));

        // Add implicit groups check?
        // The frontend M3U parser generates groups from the channels if explicit groups missing.
        // Our SyncService `saveCategories` handles explicit groups.

        res.json({ channels: reformattedChannels, groups: reformattedGroups });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// EPG
router.get('/epg/:sourceId', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const db = getDb();

        // Time window: 24 hours ago to 24 hours from now
        // This prevents returning millions of rows and crashing the server/browser
        const windowStart = Date.now() - (24 * 60 * 60 * 1000); // -24 hours
        const windowEnd = Date.now() + (24 * 60 * 60 * 1000);   // +24 hours

        // Fetch programs within the time window
        let programsQuery = `
            SELECT channel_id as channelId, start_time, end_time, title, description, data 
            FROM epg_programs 
            WHERE source_id = ? AND end_time > ? AND start_time < ?
        `;
        const params = [sourceId, windowStart, windowEnd];

        const programs = db.prepare(programsQuery).all(...params);

        const formattedPrograms = programs.map(p => ({
            channelId: p.channelId,
            start: new Date(p.start_time).toISOString(), // EpgGuide parse this back
            stop: new Date(p.end_time).toISOString(),
            title: p.title,
            description: p.description
        }));

        // Fetch EPG channels from playlist_items (type='epg_channel')


        let epgChannels = [];

        // Try getting stored channels first
        const storedChannels = db.prepare(`
            SELECT item_id as id, name, stream_icon as icon, data 
            FROM playlist_items 
            WHERE source_id = ? AND type = 'epg_channel'
        `).all(sourceId);

        if (storedChannels.length > 0) {
            epgChannels = storedChannels;
        } else {
            // Fallback: Build from unique channelIds in programmes (Legacy behavior)
            const uniqueChannelIds = [...new Set(programs.map(p => p.channelId))];
            epgChannels = uniqueChannelIds.map(id => ({
                id: id,
                name: id // Use channelId as name (fallback)
            }));
        }

        res.json({
            channels: epgChannels,
            programmes: formattedPrograms
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Clear cache (kept for compatibility)
router.delete('/cache/:sourceId', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clearSource(sourceId);
    res.json({ success: true });
});



/**
 * Proxy Xtream API calls
 * GET /api/proxy/xtream/:sourceId/:action
 */
router.get('/xtream/:sourceId/:action', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }

        const { action } = req.params;
        const { category_id, stream_id, vod_id, series_id, limit, refresh, maxAge } = req.query;
        const forceRefresh = refresh === '1';
        const maxAgeHours = parseInt(maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Actions that should be cached
        const cacheableActions = [
            'live_categories', 'live_streams',
            'vod_categories', 'vod_streams',
            'series_categories', 'series'
        ];

        // Build cache key (include category_id if present)
        const cacheKey = category_id ? `${action}_${category_id}` : action;

        // Check cache for cacheable actions
        if (!forceRefresh && cacheableActions.includes(action)) {
            const cached = cache.get('xtream', sourceId, cacheKey, maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        // Fetch fresh data
        const api = xtreamApi.createFromSource(source);
        let data;
        switch (action) {
            case 'auth':
                data = await api.authenticate();
                break;
            case 'live_categories':
                data = await api.getLiveCategories();
                break;
            case 'live_streams':
                data = await api.getLiveStreams(category_id);
                break;
            case 'vod_categories':
                data = await api.getVodCategories();
                break;
            case 'vod_streams':
                data = await api.getVodStreams(category_id);
                break;
            case 'vod_info':
                data = await api.getVodInfo(vod_id);
                break;
            case 'series_categories':
                data = await api.getSeriesCategories();
                break;
            case 'series':
                data = await api.getSeries(category_id);
                break;
            case 'series_info':
                data = await api.getSeriesInfo(series_id);

                // Normalize Xtream response: ensure episodes is an object with season keys
                if (data && data.episodes) {
                    if (Array.isArray(data.episodes)) {
                        data.episodes = { "1": data.episodes };
                    }
                }

                // Fallback for empty episodes (season-split entries)
                const hasEpisodes = data && data.episodes &&
                    typeof data.episodes === 'object' &&
                    Object.keys(data.episodes).length > 0 &&
                    Object.values(data.episodes).some(arr => Array.isArray(arr) && arr.length > 0);

                if (!hasEpisodes) {
                    const db = getDb();
                    const item = db.prepare(
                        'SELECT * FROM playlist_items WHERE source_id = ? AND item_id = ? AND type = ?'
                    ).get(source.id, series_id, 'series');

                    if (item) {
                        data = data || {};
                        data.episodes = {
                            '1': [{
                                id: item.item_id,
                                episode_num: 1,
                                title: item.name || 'Play',
                                container_extension: item.container_extension || 'mp4',
                                duration: ''
                            }]
                        };
                    }
                }

                if (data && data.episodes) {
                    data.seasons = data.seasons || Object.keys(data.episodes).map(s => ({
                        season_number: parseInt(s),
                        name: `Season ${s}`
                    }));
                }
                break;
            case 'short_epg':
                data = await api.getShortEpg(stream_id, limit);
                break;
            default:
                return res.status(400).json({ error: 'Unknown action' });
        }

        // Cache the result for cacheable actions
        if (cacheableActions.includes(action)) {
            cache.set('xtream', sourceId, cacheKey, data);
        }

        res.json(data);
    } catch (err) {
        console.error('Xtream proxy error:', err);
        const actionParam = req.params.action; // Safe way to check since action could be undefined here if not defined at top
        if (actionParam === 'series_info') {
            return res.json({ episodes: {}, seasons: [] });
        }
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get Xtream stream URL
 * GET /api/proxy/xtream/:sourceId/stream/:streamId
 */
router.get('/xtream/:sourceId/stream/:streamId/:type?', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }

        const api = xtreamApi.createFromSource(source);
        const { streamId, type = 'live' } = req.params;
        const { container = 'm3u8' } = req.query;

        const url = api.buildStreamUrl(streamId, type, container);
        res.json({ url });
    } catch (err) {
        console.error('Stream URL error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Fetch and parse EPG (with file-based caching)
 * GET /api/proxy/epg/:sourceId
 * Query params:
 * - refresh=1  Force refresh, bypass cache
 * - maxAge=N   Max cache age in hours (default 24)
 */
router.get('/epg/:sourceId', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId);
        if (!source || (source.type !== 'epg' && source.type !== 'xtream')) {
            return res.status(404).json({ error: 'Valid EPG source not found' });
        }

        const forceRefresh = req.query.refresh === '1';
        const maxAgeHours = parseInt(req.query.maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Check file cache (unless force refresh)
        if (!forceRefresh) {
            const cached = cache.get('epg', sourceId, 'data', maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        // Fetch fresh data
        let url = source.url;
        if (source.type === 'xtream') {
            const api = xtreamApi.createFromSource(source);
            url = api.getXmltvUrl();
        }

        const data = await epgParser.fetchAndParse(url);

        // Store in file cache
        cache.set('epg', sourceId, 'data', data);

        res.json(data);
    } catch (err) {
        console.error('EPG proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Clear cache for a source
 * DELETE /api/proxy/cache/:sourceId
 */
router.delete('/cache/:sourceId', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clearSource(sourceId);
    res.json({ success: true });
});

/**
 * Clear EPG cache for a source (legacy endpoint, calls clearSource)
 * DELETE /api/proxy/epg/:sourceId/cache
 */
router.delete('/epg/:sourceId/cache', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clear('epg', sourceId, 'data');
    res.json({ success: true });
});

/**
 * Get EPG for specific channels
 * POST /api/proxy/epg/:sourceId/channels
 */
router.post('/epg/:sourceId/channels', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'epg') {
            return res.status(404).json({ error: 'EPG source not found' });
        }

        const { channelIds } = req.body;
        if (!channelIds || !Array.isArray(channelIds)) {
            return res.status(400).json({ error: 'channelIds array required' });
        }

        const data = await epgParser.fetchAndParse(source.url);

        // Filter programmes for requested channels
        const result = {};
        for (const channelId of channelIds) {
            result[channelId] = epgParser.getCurrentAndUpcoming(data.programmes, channelId);
        }

        res.json(result);
    } catch (err) {
        console.error('EPG channels error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Proxy stream for playback
 * This handles CORS for streams that don't allow cross-origin
 * Supports HTTP Range requests for video seeking
 */
router.get('/stream', async (req, res) => {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let { url } = req.query;
            if (!url) {
                return res.status(400).json({ error: 'URL required' });
            }

            // Resolve stalker pseudo-URLs
            if (url.startsWith('stalker://')) {
                const { resolveStalkerUrl } = require('../services/stalkerResolver');
                url = await resolveStalkerUrl(url);
            }

            // Detect Stalker stream requests (need MAG headers + relaxed TLS)
            const isStalker = req.query.stalker === '1';
            let stalkerMac = req.query.mac;
            let stalkerPortal = req.query.portal;

            // If sourceId provided, look up MAC and portal from the source
            if (isStalker && !stalkerMac && req.query.sourceId) {
                try {
                    const source = await sources.getById(req.query.sourceId);
                    if (source && source.type === 'stalker') {
                        stalkerMac = source.mac;
                        stalkerPortal = source.url.replace(/\/+$/, '').replace(/\/c\/?$/, '') + '/c/';
                    }
                } catch (err) {
                    console.warn('[Proxy] Failed to look up stalker source:', err.message);
                }
            }

            // Forward some headers to be more "transparent" back to the origin
            // Pluto TV uses multiple domains for content delivery
            const plutoDomains = ['pluto.tv', 'pluto.io', 'plutotv.net', 'siloh.pluto.tv', 'service-stitcher'];
            const isPluto = plutoDomains.some(domain => url.includes(domain));

            let headers;
            let fetchOptions = {};

            if (isStalker) {
                // Use MAG STB headers for Stalker portal streams
                const encodedMac = stalkerMac ? encodeURIComponent(stalkerMac) : '';
                headers = {
                    'User-Agent': STALKER_STB_USER_AGENT,
                    'X-User-Agent': 'Model: MAG250; Link: WiFi',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Connection': 'keep-alive',
                    'Referer': stalkerPortal || new URL(url).origin + '/',
                };
                if (stalkerMac) {
                    headers['Cookie'] = `mac=${encodedMac}; stb_lang=en; timezone=America/New_York`;
                }
                // Use relaxed TLS agent for Stalker streams
                if (url.startsWith('https')) {
                    fetchOptions.dispatcher = undefined; // Node fetch doesn't use dispatcher the same way
                    // For Node.js built-in fetch, we need to use the agent option
                    // Since Node 18+ fetch doesn't support agent directly, we use http/https module
                }
            } else {
                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Origin': isPluto ? 'https://pluto.tv' : new URL(url).origin,
                    'Referer': isPluto ? 'https://pluto.tv/' : new URL(url).origin + '/'
                };
            }

            // Forward Range header for video seeking support
            const rangeHeader = req.get('range');
            if (rangeHeader) {
                headers['Range'] = rangeHeader;
            }

            // Use appropriate fetch method based on source type
            let response;
            if (isStalker && url.startsWith('https')) {
                // Use Node.js https module with relaxed TLS for Stalker HTTPS streams
                response = await new Promise((resolve, reject) => {
                    const parsedUrl = new URL(url);
                    const reqOptions = {
                        hostname: parsedUrl.hostname,
                        port: parsedUrl.port || 443,
                        path: parsedUrl.pathname + parsedUrl.search,
                        method: 'GET',
                        headers: headers,
                        agent: stalkerHttpsAgent,
                        timeout: 30000
                    };

                    const httpsReq = https.request(reqOptions, (httpsRes) => {
                        // Convert to fetch-like response
                        resolve({
                            ok: httpsRes.statusCode >= 200 && httpsRes.statusCode < 400,
                            status: httpsRes.statusCode,
                            statusText: httpsRes.statusMessage,
                            headers: {
                                get: (name) => httpsRes.headers[name.toLowerCase()] || null
                            },
                            body: httpsRes,
                            url: url
                        });
                    });

                    httpsReq.on('error', reject);
                    httpsReq.on('timeout', () => {
                        httpsReq.destroy();
                        reject(new Error('Stalker stream request timed out'));
                    });
                    httpsReq.end();
                });
            } else {
                response = await fetch(url, { headers });
            }

            // Retry on 5xx errors (transient upstream issues)
            if (response.status >= 500 && attempt < maxRetries) {
                console.log(`[Proxy] Upstream 5xx error (attempt ${attempt}/${maxRetries}), retrying in 500ms...`);
                // Consume body to free resources
                if (response.body && typeof response.body.resume === 'function') {
                    response.body.resume();
                }
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            if (!response.ok) {
                console.error(`Upstream error for ${url.substring(0, 80)}...: ${response.status} ${response.statusText}`);
                if (response.status === 403) {
                    try {
                        // Handle both fetch Response and Node IncomingMessage
                        let errorBody = 'N/A';
                        if (typeof response.text === 'function') {
                            errorBody = await response.text();
                        } else if (response.body) {
                            const chunks = [];
                            for await (const chunk of response.body) {
                                chunks.push(chunk);
                            }
                            errorBody = Buffer.concat(chunks).toString('utf-8');
                        }
                        console.error(`403 Response body: ${errorBody.substring(0, 200)}`);
                    } catch (e) { /* ignore */ }
                }
                return res.status(response.status).send(`Failed to fetch stream: ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type') || '';
            res.set('Access-Control-Allow-Origin', '*');

            // Forward range-related headers for video seeking support
            const contentLength = response.headers.get('content-length');
            const contentRange = response.headers.get('content-range');
            const acceptRanges = response.headers.get('accept-ranges');

            if (contentLength) {
                res.set('Content-Length', contentLength);
            }
            if (contentRange) {
                res.set('Content-Range', contentRange);
            }
            if (acceptRanges) {
                res.set('Accept-Ranges', acceptRanges);
            } else if (contentLength && !contentRange) {
                // If server supports content-length but didn't explicitly state accept-ranges,
                // we can safely assume it supports byte ranges
                res.set('Accept-Ranges', 'bytes');
            }

            // Set status code (206 for partial content when range request was made)
            res.status(response.status);

            // Create an async iterator for the response body
            const iterator = response.body[Symbol.asyncIterator]();
            const first = await iterator.next();

            if (first.done) {
                res.set('Content-Type', contentType || 'application/octet-stream');
                return res.end();
            }

            const firstChunk = Buffer.from(first.value);

            // Peek at first bytes to check for HLS manifest ({ #EXTM3U })
            const textPrefix = firstChunk.subarray(0, 7).toString('utf8');
            const contentLooksLikeHls = textPrefix === '#EXTM3U';

            if (contentLooksLikeHls) {
                // HLS Manifest: We must read the WHOLE manifest to rewrite it
                const chunks = [firstChunk];

                // Consume the rest of the stream
                let result = await iterator.next();
                while (!result.done) {
                    chunks.push(Buffer.from(result.value));
                    result = await iterator.next();
                }

                const buffer = Buffer.concat(chunks);
                const finalUrl = response.url || url;
                console.log(`[Proxy] Processing HLS manifest from: ${finalUrl.substring(0, 80)}...`);
                res.set('Content-Type', 'application/vnd.apple.mpegurl');

                let manifest = buffer.toString('utf-8');

                const finalUrlObj = new URL(finalUrl);
                const baseUrl = finalUrlObj.origin + finalUrlObj.pathname.substring(0, finalUrlObj.pathname.lastIndexOf('/') + 1);

                // Build stalker param suffix for sub-resource URLs
                const stalkerSuffix = isStalker
                    ? `&stalker=1${stalkerMac ? `&mac=${encodeURIComponent(stalkerMac)}` : ''}${stalkerPortal ? `&portal=${encodeURIComponent(stalkerPortal)}` : ''}`
                    : '';

                manifest = manifest.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (trimmed === '' || trimmed.startsWith('#')) {
                        // Handle both URI="..." and URI='...' formats
                        if (trimmed.includes('URI=')) {
                            // Replace both double and single quoted URIs
                            return line.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
                                try {
                                    const absoluteUrl = new URL(p1, baseUrl).href;
                                    return `URI="${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}${stalkerSuffix}"`;
                                } catch (e) {
                                    return match;
                                }
                            });
                        }
                        return line;
                    }

                    // Stream URL handling
                    try {
                        let absoluteUrl;
                        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                            absoluteUrl = trimmed;
                        } else {
                            absoluteUrl = new URL(trimmed, baseUrl).href;
                        }
                        return `${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}${stalkerSuffix}`;
                    } catch (e) { return line; }
                }).join('\n');

                return res.send(manifest);
            }

            // Binary content should be streamed through, not buffered in memory.
            // Buffering whole MP4 responses breaks native direct-play and causes endless buffering.
            console.log(`[Proxy] Streaming binary content (${contentType})`);
            res.set('Content-Type', contentType || 'application/octet-stream');
            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }

            if (!res.write(firstChunk)) {
                await new Promise(resolve => res.once('drain', resolve));
            }

            let result = await iterator.next();
            while (!result.done) {
                if (res.destroyed || res.writableEnded) {
                    break;
                }

                const chunk = Buffer.from(result.value);
                if (!res.write(chunk)) {
                    await new Promise(resolve => res.once('drain', resolve));
                }
                result = await iterator.next();
            }

            if (!res.writableEnded) {
                res.end();
            }
            return; // Success - exit the retry loop

        } catch (err) {
            lastError = err;
            console.error(`Stream proxy error (attempt ${attempt}/${maxRetries}):`, err.message);
            if (attempt < maxRetries) {
                console.log('[Proxy] Retrying after error...');
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
        }
    }

    // All retries failed
    if (!res.headersSent) {
        res.status(500).json({ error: lastError?.message || 'Stream proxy failed after retries' });
    }
});

/**
 * Proxy images (channel logos, posters)
 * Fixes mixed content errors when loading HTTP images on HTTPS pages
 * GET /api/proxy/image?url=...
 */
router.get('/image', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ error: 'URL required' });
        }

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,*/*;q=0.8'
            }
        });

        if (!response.ok) {
            return res.status(response.status).send('Failed to fetch image');
        }

        const contentType = response.headers.get('content-type') || 'image/png';
        res.set('Content-Type', contentType);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours

        // Efficiently pipe the response body
        if (response.body) {
            // response.body is an AsyncIterable in standard fetch/undici
            // Readable.from converts it to a Node.js Readable stream
            const stream = Readable.from(response.body);
            stream.pipe(res);
        } else {
            res.end();
        }

    } catch (err) {
        console.error('Image proxy error:', err.message);
        res.status(500).send('Image proxy error');
    }
});

module.exports = router;