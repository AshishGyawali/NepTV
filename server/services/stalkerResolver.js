const { sources } = require('../db');
const { getDb } = require('../db/sqlite');
const stalkerApi = require('./stalkerApi');

async function resolveStalkerUrl(pseudoUrl) {
    if (!pseudoUrl.startsWith('stalker://')) {
        return pseudoUrl;
    }
    
    const match = pseudoUrl.match(/stalker:\/\/(\d+)\/([^\/]+)\/([^\/]+)/);
    if (!match) return pseudoUrl;

    const sourceId = parseInt(match[1]);
    const streamId = match[2];
    const type = match[3];

    const source = await sources.getById(sourceId);
    if (!source || source.type !== 'stalker') {
        throw new Error('Stalker source not found');
    }

    const db = getDb();
    const itemType = type === 'movie' ? 'movie' : type === 'series' ? 'series' : 'live';
    const item = db.prepare(
        'SELECT data FROM playlist_items WHERE source_id = ? AND item_id = ? AND type = ?'
    ).get(sourceId, streamId, itemType);

    if (!item) {
        throw new Error('Stream not found in DB');
    }

    const itemData = JSON.parse(item.data || '{}');
    const cmd = itemData.cmd;
    const parentCmd = itemData.parentCmd;
    const seriesNumber = itemData.seriesNumber;

    if (!cmd && !parentCmd) {
        throw new Error('No stream command found for this item');
    }

    const api = stalkerApi.createFromSource(source);
    
    let streamUrl;
    if (type === 'live') {
        streamUrl = await api.createLiveLink(cmd);
    } else if (type === 'series') {
        const effectiveCmd = cmd || parentCmd;
        const effectiveSeriesNum = !cmd ? seriesNumber : null;
        streamUrl = await api.createSeriesLink(effectiveCmd, effectiveSeriesNum);
    } else {
        streamUrl = await api.createVodLink(cmd);
    }
    
    return streamUrl;
}

module.exports = {
    resolveStalkerUrl
};
