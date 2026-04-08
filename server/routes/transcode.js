const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const db = require('../db');
const transcodeSession = require('../services/transcodeSession');
const { resolveStalkerUrl } = require('../services/stalkerResolver');

/**
 * Transcode Routes
 * * Direct streaming (backward compatible):
 * GET /api/transcode?url=...
 * * HLS session-based (new, supports seeking):
 * POST /api/transcode/session        - Create new session
 * GET  /api/transcode/:id/stream.m3u8 - Get HLS playlist
 * GET  /api/transcode/:id/:segment.ts - Get segment file
 * DELETE /api/transcode/:id          - Stop and cleanup session
 * GET /api/transcode/sessions        - List all sessions (debug)
 */

// Start session cleanup interval
transcodeSession.startCleanupInterval();

/**
 * Create a new transcode session
 * POST /api/transcode/session
 * Body: { url: string, seekOffset?: number }
 */
router.post('/session', async (req, res) => {
    try {
        let { url, seekOffset, videoMode, videoCodec, audioCodec, audioChannels, audioIdx, sourceType, sourceId, isLive } = req.body || {};

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Resolve relative URLs (e.g., /api/proxy/stream?...) to absolute for FFmpeg
        if (url.startsWith('/')) {
            const port = req.app.get('port') || req.socket.localPort || 3000;
            url = `http://127.0.0.1:${port}${url}`;
            console.log(`[Transcode] Resolved relative URL to: ${url}`);
        }

        const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
        const settings = await db.settings.get();
        let userAgent = db.getUserAgent(settings);

        // Stalker portal streams need MAG STB User-Agent and cookies for FFmpeg
        let stalkerHeaders = null;

        // Extract sourceId from pseudo-url if present
        if (url.startsWith('stalker://')) {
            const match = url.match(/stalker:\/\/(\d+)\//);
            if (match) {
                sourceId = parseInt(match[1], 10);
                sourceType = 'stalker';
            }
        }

        if (sourceType === 'stalker' && sourceId) {
            try {
                const source = await db.sources.getById(sourceId);
                if (source && source.type === 'stalker') {
                    const STALKER_STB_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
                    userAgent = STALKER_STB_UA;
                    const encodedMac = encodeURIComponent(source.mac);
                    const portalUrl = source.url.replace(/\/+$/, '').replace(/\/c\/?$/, '');
                    stalkerHeaders = {
                        cookie: `mac=${encodedMac}; stb_lang=en; timezone=America/New_York`,
                        referer: portalUrl + '/c/'
                    };
                    console.log(`[Transcode] Using Stalker MAG headers for source ${sourceId}`);
                }
            } catch (err) {
                console.warn('[Transcode] Failed to load stalker source:', err.message);
            }
        }

        if (url.startsWith('stalker://')) {
            console.log(`[Transcode] Resolving stalker pseudo-URL: ${url}`);
            url = await resolveStalkerUrl(url);
            console.log(`[Transcode] Resolved to: ${url.substring(0, 50)}...`);
        }

        // Explicit intent-based disguise (no URL guessing!)
        const isStalkerSource = sourceType === 'stalker';
        const isLiveStream = !!isLive;

        let customHeaders = '';
        let sessionUserAgent;

        if (isStalkerSource) {
            // Rule A: Pure Stalker - Full MAG250 with X-User-Agent
            sessionUserAgent = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 sb.aftergrad.confic Qt/4.7.4 Safari/533.3';
            customHeaders = 'X-User-Agent: model=MAG250;version=2.18.02-r3\r\n';
        } else if (isLiveStream) {
            // Rule B: Xtream Live TV - AppleCoreMedia master key
            sessionUserAgent = 'AppleCoreMedia/1.0.0.19L362 (Apple TV; U; CPU OS 15_4 like Mac OS X; en_US)';
        } else {
            // Rule C: Xtream VODs & Series - Media Player UA
            sessionUserAgent = 'VLC/3.0.21 LibVLC/3.0.21';
        }

        console.log(`[Transcode] Source: ${isStalkerSource ? 'STALKER' : 'XTREAM'} | Type: ${isLiveStream ? 'LIVE' : 'VOD'} | UA: ${sessionUserAgent.substring(0, 40)}...`);

        const session = await transcodeSession.createSession(url, {
            ffmpegPath,
            userAgent: sessionUserAgent,
            customHeaders: customHeaders,
            stalkerHeaders,
            seekOffset: seekOffset || 0,
            hwEncoder: settings.hwEncoder || 'software',
            maxResolution: settings.maxResolution || '1080p',
            quality: settings.quality || 'medium',
            audioMixPreset: settings.audioMixPreset || 'auto',
            upscaleEnabled: settings.upscaleEnabled || false,
            upscaleMethod: settings.upscaleMethod || 'hardware',
            upscaleTarget: settings.upscaleTarget || '1080p',
            videoMode: videoMode,
            videoCodec: videoCodec,
            audioCodec: audioCodec,
            audioChannels: audioChannels,
            audioIdx: Number.isInteger(audioIdx) ? audioIdx : 0,
            isLive: isLiveStream
        });

        await session.start();

        // Wait for playlist to be ready (first segments generated)
        const ready = await session.waitForPlaylist(15000);

        if (!ready) {
            await transcodeSession.removeSession(session.id);
            return res.status(500).json({ error: 'Transcoding failed to start', reason: 'Playlist not generated in time' });
        }

        res.json({
            sessionId: session.id,
            playlistUrl: `/api/transcode/${session.id}/stream.m3u8`,
            status: session.status
        });

    } catch (err) {
        console.error('[Transcode] Session creation failed:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to create session', details: err.message });
        }
    }
});

/**
 * Get HLS playlist for a session
 * GET /api/transcode/:sessionId/stream.m3u8
 */
router.get('/:sessionId/stream.m3u8', async (req, res) => {
    const { sessionId } = req.params;
    const session = transcodeSession.getSession(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const playlist = await session.getPlaylist();
    if (!playlist) {
        return res.status(404).json({ error: 'Playlist not ready' });
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(playlist);
});

/**
 * Get a segment file for a session
 * GET /api/transcode/:sessionId/:segment.ts
 */
router.get('/:sessionId/:segment', async (req, res) => {
    const { sessionId, segment } = req.params;

    // Only handle .ts files
    if (!segment.endsWith('.ts')) {
        return res.status(404).json({ error: 'Invalid segment' });
    }

    const session = transcodeSession.getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const segmentPath = await session.getSegment(segment);
    if (!segmentPath) {
        return res.status(404).json({ error: 'Segment not found' });
    }

    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache forever (immutable)
    res.sendFile(segmentPath);
});

/**
 * Stop and cleanup a session
 * DELETE /api/transcode/:sessionId
 */
router.delete('/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    try {
        await transcodeSession.removeSession(sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove session', details: err.message });
    }
});

/**
 * List all active sessions (for debugging)
 * GET /api/transcode/sessions
 */
router.get('/sessions', (req, res) => {
    res.json(transcodeSession.getAllSessions());
});

/**
 * Direct transcode stream (backward compatible, no seeking)
 * GET /api/transcode?url=...
 * * Transcodes audio to AAC for browser compatibility while passing video through.
 * This fixes playback issues with Dolby/AC3/EAC3 audio that browsers can't decode.
 */
router.get('/', async (req, res) => {
    try {
        let { url, audioIdx, audioChannels, isLive } = req.query;
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        // Resolve relative URLs (e.g., /api/proxy/stream?...) to absolute for FFmpeg
        if (url.startsWith('/')) {
            const port = req.app.get('port') || req.socket.localPort || 3000;
            url = `http://127.0.0.1:${port}${url}`;
        }

        const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

        const isStalkerSource = req.query.sourceType === 'stalker';
        const isLiveQuery = req.query.isLive === '1';

        let customHeaders = '';
        if (isStalkerSource) {
            customHeaders = 'X-User-Agent: model=MAG250;version=2.18.02-r3\r\n';
        } else if (!isLiveQuery) {
            try {
                const parsedUrl = new URL(url);
                customHeaders = `Referer: ${parsedUrl.protocol}//${parsedUrl.host}/\r\n`;
            } catch (e) {
                console.error("[Transcode] Failed to parse URL for referer header");
            }
        }

        // 2. Set the appropriate User-Agent using the same explicit intent matrix
        let userAgent;
        if (isStalkerSource) {
            userAgent = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 sb.aftergrad.confic Qt/4.7.4 Safari/533.3';
        } else if (isLiveQuery) {
            // AppleCoreMedia master key for Xtream Live
            userAgent = 'AppleCoreMedia/1.0.0.19L362 (Apple TV; U; CPU OS 15_4 like Mac OS X; en_US)';
        } else {
            userAgent = 'VLC/3.0.21 LibVLC/3.0.21';
        }

        // If it's a stalker URL, resolve it first
        if (url.startsWith('stalker://')) {
            console.log(`[Transcode] Resolving stalker pseudo-URL: ${url}`);
            url = await resolveStalkerUrl(url);
        }

        const normalizedAudioIdx = Number.isInteger(Number(audioIdx)) ? Number(audioIdx) : 0;
        const normalizedAudioChannels = Number.isFinite(Number(audioChannels)) ? Number(audioChannels) : 0;
        const needsDownmix = normalizedAudioChannels > 2;

        // FFmpeg arguments for transcoding
        // Optimized for VOD content with incompatible audio (Dolby/AC3/EAC3)
        // Also works for live streams with ad stitching (Pluto TV, etc.)
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-user_agent', userAgent,
            ...(customHeaders ? ['-headers', customHeaders] : []),
            // Faster startup - reduced probe/analyze for quicker first bytes
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            // Error resilience: generate timestamps, discard corrupt packets
            '-fflags', '+genpts+discardcorrupt+nobuffer',
            // Ignore errors in stream and continue
            '-err_detect', 'ignore_err',
            // Limit max demux delay to prevent buffering issues
            '-max_delay', '2000000',
            // Reconnect settings for network drops (useful for live streams)
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '3',
            // Prevent Range/HEAD requests that some providers reject with 405
            '-seekable', '0',
            '-i', url,
            // Map video/audio streams. Live TV uses auto-select to handle ad stitching
            // and track layout changes. VOD uses strict mapping.
            ...(isLive === '1'
                ? ['-map', '0:v?', '-map', '0:a?']
                : ['-map', '0:v:0?', '-map', `0:a:${normalizedAudioIdx}?`]),
            '-sn',
            '-dn',
            // Video: passthrough (no re-encoding = fast!)
            '-c:v', 'copy',
            // Audio: Transcode to browser-compatible AAC
            '-c:a', 'aac',
            '-ac', '2',
            '-ar', '48000',
            '-b:a', needsDownmix ? '256k' : '192k',
            // Handle async audio/video using async filter
            '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
            // Timestamp handling
            '-fps_mode', 'passthrough',
            '-async', '1',
            '-max_muxing_queue_size', '2048',
            // Fragmented MP4 for streaming (browser-compatible)
            '-f', 'mp4',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
            '-flush_packets', '1', // Send data immediately
            '-' // Output to stdout
        ];

        console.log(`[Transcode] Full command: ${ffmpegPath} ${args.join(' ')}`);

        let ffmpeg;
        try {
            ffmpeg = spawn(ffmpegPath, args);
        } catch (spawnErr) {
            console.error('[Transcode] Failed to spawn FFmpeg:', spawnErr);
            return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
        }

        // Collect stderr for error reporting
        let stderrBuffer = '';

        // Set headers for fragmented MP4
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Pipe stdout to response
        ffmpeg.stdout.pipe(res);

        ffmpeg.stdout.on('error', (err) => {
            if (err.code !== 'EPIPE') {
                console.error('[Transcode] FFmpeg stdout error:', err);
            }
        });

        res.on('error', (err) => {
            console.error('[Transcode] Response stream error:', err);
            ffmpeg.kill('SIGKILL');
        });

        // Log stderr (useful for debugging transcoding failures)
        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            stderrBuffer += msg;
            console.log(`[FFmpeg] ${msg}`);
        });

        // Cleanup on client disconnect
        req.on('close', () => {
            console.log('[Transcode] Client disconnected, killing FFmpeg process');
            ffmpeg.kill('SIGKILL');
        });

        // Handle process exit
        ffmpeg.on('exit', (code) => {
            if (code !== null && code !== 0 && code !== 255) { // 255 is often returned on kill
                console.error(`[Transcode] FFmpeg exited with code ${code}`);
            }
        });

        // Handle spawn errors
        ffmpeg.on('error', (err) => {
            console.error('[Transcode] Failed to spawn FFmpeg:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Transcoding failed to start' });
            }
        });
    } catch (err) {
        console.error('[Transcode] Direct transcode failed:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Transcoding failed', details: err.message });
        }
    }
});

module.exports = router;