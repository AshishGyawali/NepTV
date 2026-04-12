const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');
const { requireLicenseAuth } = require('../auth');

// License server mode: enforce auth + IP lock on remux routes
if (process.env.LICENSE_SERVER_URL) {
    router.use(requireLicenseAuth({ checkDevice: true }));
}

/**
 * Remux stream (container conversion only)
 * GET /api/remux?url=...
 * 
 * Remuxes MPEG-TS to fragmented MP4 for browser playback.
 * This is a lightweight operation - no video/audio re-encoding.
 * Use this for raw .ts streams that browsers can't play directly.
 * 
 * Note: This does NOT fix Dolby/AC3 audio issues - use /api/transcode for that.
 */
router.get('/', async (req, res) => {
    let { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Resolve relative URLs (e.g., /api/proxy/stream?...) to absolute for FFmpeg
    if (url.startsWith('/')) {
        const port = req.app.get('port') || req.socket.localPort || 3000;
        url = `http://127.0.0.1:${port}${url}`;
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

    // 1. Capture explicit intent AND source type
    const streamType = req.query.streamType || 'unknown';
    const isStalker = req.query.sourceType === 'stalker';

    // === THE XTREAM FIREWALL BYPASS ===
    // Must match the prober exactly!
    if (!isStalker && streamType === 'live' && url.includes('.m3u8')) {
        url = url.replace('.m3u8', '.ts');
        console.log('[Remux] Bypassing HLS Firewall: Rewrote .m3u8 to .ts');
    }

    // 2. Build the matching disguise
    let userAgent;
    if (isStalker) {
        userAgent = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 sb.aftergrad.confic Qt/4.7.4 Safari/533.3';
    } else {
        userAgent = 'IPTVSmartersPro';
    }

    console.log(`[Remux] Source: ${isStalker ? 'STALKER' : 'XTREAM'} | Type: ${streamType.toUpperCase()} | UA: ${userAgent}`);
    console.log(`[Remux] Starting remux for: ${url}`);

    // 3. Build the pristine FFmpeg Command (single -user_agent, no duplicates)
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        '-fflags', '+genpts+discardcorrupt+igndts+nobuffer',
        '-err_detect', 'ignore_err',
        '-max_delay', '5000000',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-seekable', '0',
        '-i', url,
        '-map', '0:v',
        '-map', '0:a',
        '-sn', '-dn',
        '-c', 'copy',
        '-bsf:v', 'dump_extra',
        '-bsf:a', 'aac_adtstoasc',
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-' // Output to stdout
    ];

    console.log(`[Remux] Full command: ${ffmpegPath} ${args.join(' ')}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Remux] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Log stderr (useful for debugging)
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        // Only log warnings/errors, not progress
        if (msg.includes('Warning') || msg.includes('Error') || msg.includes('error')) {
            console.log(`[Remux FFmpeg] ${msg}`);
        }
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        console.log('[Remux] Client disconnected, killing FFmpeg process');
        ffmpeg.kill('SIGKILL');
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) {
            console.error(`[Remux] FFmpeg exited with code ${code}`);
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Remux] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Remux failed to start' });
        }
    });
});

module.exports = router;
