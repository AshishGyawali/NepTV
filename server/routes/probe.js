const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { isLicenseMode } = require('../authMode');
const { resolveStalkerUrl } = require('../services/stalkerResolver');
const { requireLicenseAuth } = require('../auth');

// License server mode: enforce auth + IP lock on probe routes
if (isLicenseMode) {
    router.use(requireLicenseAuth({ checkDevice: true }));
}

/**
 * Probe endpoint - detects stream codecs and container
 * GET /api/probe?url=...
 * 
 * Returns:
 * {
 *   video: "h264",
 *   audio: "aac",
 *   container: "mpegts",
 *   compatible: true,
 *   needsRemux: false,
 *   needsTranscode: false
 * }
 */

// Probe cache (URL → result)
const probeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Browser-compatible codecs
const BROWSER_VIDEO_CODECS = ['h264', 'avc', 'avc1'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];

/**
 * Probe stream with ffprobe
 */
function probeStream(url, ffprobePath, userAgent = null, customHeaders = null, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-user_agent', userAgent || 'VLC/3.0.16 LibVLC/3.0.16',
            ...(customHeaders ? ['-headers', customHeaders] : []),
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            url
        ];

        const proc = spawn(ffprobePath, args);
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Probe timeout'));
        }, timeout);

        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (e) {
                reject(new Error('Failed to parse ffprobe output'));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Analyze probe result and determine compatibility
 */
function analyzeProbeResult(probeResult, url) {
    const streams = probeResult.streams || [];
    const format = probeResult.format || {};

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStream = streams.find(s => s.codec_type === 'audio');

    const videoCodec = videoStream?.codec_name?.toLowerCase() || 'unknown';
    const audioCodec = audioStream?.codec_name?.toLowerCase() || 'unknown';
    const container = format.format_name?.toLowerCase() || 'unknown';

    // Check codec compatibility
    const videoOk = BROWSER_VIDEO_CODECS.some(c => videoCodec.includes(c));
    const audioOk = BROWSER_AUDIO_CODECS.some(c => audioCodec.includes(c));

    // Browser-safe containers
    // Note: We exclude 'webm' because ffprobe reports MKV as "matroska,webm", 
    // and H.264/AAC in MKV/WebM is not universally supported. Best to remux to MP4.
    const BROWSER_CONTAINERS = ['hls', 'mp4', 'mov'];
    const containerOk = BROWSER_CONTAINERS.some(c => container.includes(c));

    // Check if it's a raw TS stream (not HLS)
    const isRawTs = (container.includes('mpegts') || url.endsWith('.ts')) && !url.includes('.m3u8');

    // Extract subtitle tracks
    const subtitles = streams
        .filter(s => s.codec_type === 'subtitle' && s.codec_name !== 'timed_id3' && s.codec_name !== 'bin_data')
        .map(s => ({
            index: s.index,
            language: s.tags?.language || 'und',
            title: s.tags?.title || s.tags?.language || `Track ${s.index}`,
            codec: s.codec_name
        }));

    // Determine what processing is needed
    // 4. MKV files often cause OOM/decoding issues in browser fMP4 remux, 
    // so we force them to "needsTranscode" which uses HLS (more robust).
    // The frontend will still use "copy" mode if codecs are compatible.
    const isMkv = container.includes('matroska') || container.includes('webm') || url.endsWith('.mkv');

    // 1. Incompatible audio/video OR MKV -> Transcode (or HLS Copy)
    const needsTranscode = !audioOk || !videoOk || isMkv;

    // 2. Compatible audio/video but incompatible container (non-MKV) -> Remux (fMP4 pipe)
    const needsRemux = !needsTranscode && (!containerOk || isRawTs);

    const compatible = !needsTranscode && !needsRemux;

    return {
        video: videoCodec,
        audio: audioCodec,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        audioChannels: audioStream?.channels || 0, // For Smart Audio Copy
        container: container,
        compatible: compatible,
        needsRemux: needsRemux,
        needsTranscode: needsTranscode,
        subtitles: subtitles
    };
}

router.get('/', async (req, res) => {
    let { url, ua, sourceType, sourceId } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Resolve relative URLs (e.g., /api/proxy/stream?...) to absolute for ffprobe
    if (url.startsWith('/')) {
        const port = req.app.get('port') || req.socket.localPort || 3000;
        url = `http://127.0.0.1:${port}${url}`;
    }

    const ffprobePath = req.app.locals.ffprobePath;
    const cacheKey = `${url}${ua ? `|${ua}` : ''}`;

    if (!ffprobePath) {
        // No ffprobe available - assume needs transcoding to be safe
        console.log('[Probe] FFprobe not available, assuming transcode needed');
        return res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true
        });
    }

    // Check cache
    const cached = probeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[Probe] Cache hit for: ${url.substring(0, 50)}...`);
        return res.json(cached.result);
    }

    const isStalker = sourceType === 'stalker' || url.startsWith('stalker://');
    const isLive = req.query.isLive === '1' || req.query.isLive === 'true';

    // === THE XTREAM FIREWALL BYPASS ===
    if (!isStalker && isLive && url.includes('.m3u8')) {
        url = url.replace('.m3u8', '.ts');
        console.log('[Probe] Bypassing HLS Firewall: Rewrote .m3u8 to .ts');
    }

    // UA matrix
    let probeUserAgent;
    if (ua) {
        probeUserAgent = ua; // Explicit UA from frontend overrides everything
    } else if (isStalker) {
        probeUserAgent = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 sb.aftergrad.confic Qt/4.7.4 Safari/533.3';
    } else {
        // Universal IPTV Player Disguise for all Xtream traffic
        probeUserAgent = 'IPTVSmartersPro';
    }

    try {
        if (url.startsWith('stalker://')) {
            console.log(`[Probe] Resolving stalker pseudo-URL: ${url}`);
            url = await resolveStalkerUrl(url);
            console.log(`[Probe] Resolved to: ${url.substring(0, 50)}...`);
        }

        let customHeaders = '';
        if (isStalker) {
            customHeaders = 'X-User-Agent: model=MAG250;version=2.18.02-r3\r\n';
        }

        console.log(`[Probe] Probing: ${url.substring(0, 80)}... (UA: ${probeUserAgent})`);

        const probeResult = await probeStream(url, ffprobePath, probeUserAgent, customHeaders);
        const analysis = analyzeProbeResult(probeResult, url);

        // Cache result
        probeCache.set(cacheKey, { result: analysis, timestamp: Date.now() });

        console.log(`[Probe] Result: video=${analysis.video}, audio=${analysis.audio}, ` +
            `container=${analysis.container}, compatible=${analysis.compatible}, ` +
            `needsRemux=${analysis.needsRemux}, needsTranscode=${analysis.needsTranscode}`);

        res.json(analysis);
    } catch (err) {
        console.error('[Probe] Failed:', err.message);

        // On error, assume transcode needed to be safe
        res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true,
            error: err.message
        });
    }
});

module.exports = router;
