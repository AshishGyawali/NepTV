/**
 * InfoPopup - Netflix-style detail popup for Movies & Series
 * Fetches metadata from TMDB (cast, genres, streaming, backdrop, etc.)
 */

const InfoPopup = (() => {
    const TMDB_KEY = '3b204e4d99c6c8d79fcdced68ca99e1e';
    const TMDB_IMG = 'https://image.tmdb.org/t/p';
    const cache = new Map();

    let overlay = null;
    let currentCleanup = null;

    function getOverlay() {
        if (!overlay) {
            overlay = document.getElementById('info-popup-overlay');
        }
        return overlay;
    }

    function close() {
        const el = getOverlay();
        if (!el) return;
        el.classList.remove('active');
        setTimeout(() => { el.innerHTML = ''; }, 300);
        document.body.style.overflow = '';
        if (currentCleanup) { currentCleanup(); currentCleanup = null; }
    }

    // ── TMDB helpers ──

    function normTitle(t) {
        if (!t) return '';
        let c = t.trim();
        // strip leading provider tags like "NF - ", "[A+] "
        c = c.replace(/^(?:\[[A-Z0-9+]{1,5}\]\s*|[A-Z][A-Z0-9+]{0,4}\s*[-–:]\s*)+/i, '');
        // strip trailing pipe content
        c = c.replace(/\s*\|.*$/, '');
        // strip quality/language tags
        c = c.replace(/\b(?:4K|HD|FHD|UHD|720p|1080p|2160p|HDRip|WEBRip|WEB[- ]?DL|Blu[- ]?Ray)\b/gi, '');
        c = c.replace(/\b(?:Dual Audio|Multi Audio|Dubbed|Uncut|Extended|Remastered)\b/gi, '');
        c = c.replace(/\b(?:Hindi|English|Tamil|Telugu|Malayalam|Kannada|Punjabi|Bengali|Marathi|Gujarati|Urdu)\s+(?:Dub|Dubbed)\b/gi, '');
        // strip parenthetical metadata
        c = c.replace(/\s*[\(\[\{][^\)\]\}]{1,24}[\)\]\}]/g, '');
        // strip trailing year
        c = c.replace(/\s*\(?\d{4}\)?\s*$/, '');
        c = c.replace(/\s+/g, ' ').trim().replace(/^[-:|\\/]+|[-:|\\/]+$/g, '');
        return c;
    }

    function titleSimilarity(a, b) {
        const na = normTitle(a).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        const nb = normTitle(b).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        if (!na || !nb) return 0;
        if (na === nb) return 1;
        if (na.replace(/ /g, '') === nb.replace(/ /g, '')) return 0.95;
        if (na.includes(nb) || nb.includes(na)) return 0.85;
        const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
        let overlap = 0;
        ta.forEach(t => { if (tb.has(t)) overlap++; });
        return (2 * overlap) / (ta.size + tb.size);
    }

    async function tmdbSearch(title, year, isSeries) {
        const cacheKey = `search:${title}:${year}:${isSeries}`;
        if (cache.has(cacheKey)) return cache.get(cacheKey);

        const type = isSeries ? 'tv' : 'movie';
        const candidates = [normTitle(title), title];
        const seen = new Set();
        let bestId = null, bestScore = -1;

        for (const q of candidates) {
            if (!q || seen.has(q.toLowerCase())) continue;
            seen.add(q.toLowerCase());

            for (const useYear of (year ? [true, false] : [false])) {
                let url = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(q)}&language=en-US&page=1&include_adult=false`;
                if (useYear && year) {
                    url += isSeries ? `&first_air_date_year=${year}` : `&year=${year}`;
                }
                try {
                    const res = await fetch(url);
                    const data = await res.json();
                    if (!data.results) continue;
                    for (const r of data.results.slice(0, 8)) {
                        const rTitle = isSeries ? (r.name || r.original_name) : (r.title || r.original_title);
                        let score = titleSimilarity(title, rTitle);
                        const rYear = (isSeries ? r.first_air_date : r.release_date || '').substring(0, 4);
                        if (year && rYear === year) score += 0.15;
                        else if (year && rYear && Math.abs(+year - +rYear) <= 1) score += 0.05;
                        if (useYear) score += 0.02;
                        if (score > bestScore) { bestScore = score; bestId = r.id; }
                    }
                } catch (e) { /* ignore */ }
            }
        }

        const result = bestScore >= 0.4 ? bestId : null;
        cache.set(cacheKey, result);
        return result;
    }

    async function tmdbDetails(id, isSeries) {
        const type = isSeries ? 'tv' : 'movie';
        const cacheKey = `details:${type}:${id}`;
        if (cache.has(cacheKey)) return cache.get(cacheKey);

        try {
            const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits,watch/providers`;
            const res = await fetch(url);
            const data = await res.json();
            cache.set(cacheKey, data);
            return data;
        } catch (e) {
            return null;
        }
    }

    async function tmdbSeasonDetails(tvId, seasonNum) {
        const cacheKey = `season:${tvId}:${seasonNum}`;
        if (cache.has(cacheKey)) return cache.get(cacheKey);
        try {
            const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${seasonNum}?api_key=${TMDB_KEY}&language=en-US`;
            const res = await fetch(url);
            const data = await res.json();
            cache.set(cacheKey, data);
            return data;
        } catch (e) {
            return null;
        }
    }

    // ── Provider normalization & dedup ──

    function normalizeProvider(name) {
        if (!name) return '';
        const n = name.trim().replace(/\s*\(?\s*with\s+ads\s*\)?\s*$/i, '').toLowerCase();
        if (n.includes('netflix')) return 'Netflix';
        if (n.includes('amazon prime') || n.includes('prime video')) return 'Amazon Prime Video';
        if (n.includes('hulu')) return 'Hulu';
        if (n.includes('disney')) return 'Disney+';
        if (n.includes('hbo max') || n === 'max') return 'HBO Max';
        if (n.includes('paramount')) return 'Paramount+';
        if (n.includes('peacock')) return 'Peacock';
        if (n.includes('youtube')) return 'YouTube';
        if (n.includes('apple')) return 'Apple TV';
        if (n.includes('google') && n.includes('play')) return 'Google Play Movies';
        return name.trim();
    }

    function buildStreamingLink(provider, title, isSeries) {
        const q = encodeURIComponent(title);
        const map = {
            'Netflix': `https://www.netflix.com/search?q=${q}`,
            'Amazon Prime Video': `https://www.primevideo.com/search/ref=atv_sr_sxt?phrase=${q}`,
            'Apple TV': `https://tv.apple.com/search?term=${q}`,
            'Google Play Movies': `https://play.google.com/store/search?q=${q}&c=movies`,
            'YouTube': `https://www.youtube.com/results?search_query=${q}`,
            'Hulu': `https://www.hulu.com/search?q=${q}`,
            'Disney+': `https://www.disneyplus.com/search?q=${q}`,
            'HBO Max': `https://www.hbomax.com/search?q=${q}`,
            'Paramount+': `https://www.paramountplus.com/search?q=${q}`,
            'Peacock': `https://www.peacocktv.com/search?q=${q}`,
        };
        return map[provider] || '';
    }

    function getProviderLogoUrl(id) {
        return id ? `${TMDB_IMG}/w92${id}` : '';
    }

    function extractProviders(watchProviders, title, isSeries) {
        if (!watchProviders || !watchProviders.results) return [];
        // prefer US, then GB, then first available
        const region = watchProviders.results.US || watchProviders.results.GB || Object.values(watchProviders.results)[0];
        if (!region) return [];

        const seen = new Set();
        const out = [];
        const types = ['flatrate', 'ads', 'free', 'buy', 'rent'];
        for (const t of types) {
            if (!region[t]) continue;
            for (const p of region[t]) {
                if (out.length >= 3) break;
                const norm = normalizeProvider(p.provider_name);
                if (seen.has(norm)) continue;
                seen.add(norm);
                out.push({
                    name: norm,
                    logo: getProviderLogoUrl(p.logo_path),
                    link: buildStreamingLink(norm, title, isSeries)
                });
            }
            if (out.length >= 3) break;
        }
        return out;
    }

    // ── Duration formatting ──

    function fmtRuntime(mins) {
        if (!mins) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    // ── Render helpers ──

    function renderGenres(genres) {
        if (!genres || !genres.length) return '';
        return `<div class="info-popup-genres">${genres.map(g =>
            `<span class="info-popup-genre">${g.name}</span>`
        ).join('')}</div>`;
    }

    function renderProviders(providers) {
        if (!providers || !providers.length) return '';
        return `
            <div class="info-popup-section-title">STREAMING ON</div>
            <div class="info-popup-providers">${providers.map(p => {
                const inner = `
                    ${p.logo ? `<img src="${p.logo}" alt="${p.name}" class="info-popup-provider-logo">` : ''}
                    <span>${p.name}</span>
                `;
                return p.link
                    ? `<a href="${p.link}" target="_blank" rel="noopener" class="info-popup-provider">${inner}</a>`
                    : `<span class="info-popup-provider">${inner}</span>`;
            }).join('')}</div>
        `;
    }

    function renderCast(credits) {
        if (!credits || !credits.cast || !credits.cast.length) return '';
        const actors = credits.cast.slice(0, 8);
        return `
            <div class="info-popup-section-title">CAST</div>
            <div class="info-popup-cast">${actors.map(a => `
                <div class="info-popup-cast-item">
                    <div class="info-popup-cast-photo">
                        ${a.profile_path
                            ? `<img src="${TMDB_IMG}/w185${a.profile_path}" alt="${a.name}" loading="lazy">`
                            : `<div class="info-popup-cast-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>`
                        }
                    </div>
                    <div class="info-popup-cast-name" title="${a.name}">${a.name}</div>
                    <div class="info-popup-cast-char" title="${a.character || ''}">${a.character || ''}</div>
                </div>
            `).join('')}</div>
        `;
    }

    // ── MOVIE popup ──

    async function showMovie(movie, { onPlay, onFavorite, isFavorite }) {
        const el = getOverlay();
        if (!el) return;

        const title = movie.name || '';
        const year = movie.year || movie.releaseDate?.substring(0, 4) || '';
        const rating = movie.rating || '';
        const poster = movie.stream_icon || movie.cover || '/img/placeholder.png';

        const plot = movie.plot || '';

        // Show popup immediately with known data
        el.innerHTML = buildMovieHTML({ title, year, rating, poster, isFavorite, plot });
        el.classList.add('active');
        document.body.style.overflow = 'hidden';

        attachCloseHandlers(el);
        attachPlayHandler(el, onPlay);
        attachFavoriteHandler(el, onFavorite, isFavorite, movie);

        // Fetch TMDB data in background
        const tmdbId = await tmdbSearch(title, year, false);
        if (tmdbId) {
            const details = await tmdbDetails(tmdbId, false);
            if (details) {
                updateMovieWithTmdb(el, details, title, poster);
            }
        }
    }

    function buildMovieHTML({ title, year, rating, poster, isFavorite, plot }) {
        const escapedTitle = escHtml(title);
        return `
        <div class="info-popup-modal" role="dialog">
            <div class="info-popup-hero">
                <div class="info-popup-backdrop" id="info-popup-backdrop"></div>
                <button class="info-popup-close" aria-label="Close">${Icons.close}</button>
                <div class="info-popup-hero-inner">
                    <div class="info-popup-poster-wrap">
                        <img class="info-popup-poster" src="${poster}" alt="${escapedTitle}"
                             onerror="this.onerror=null;this.src='/img/placeholder.png'">
                    </div>
                    <div class="info-popup-header">
                        <h2 class="info-popup-title">${escapedTitle}</h2>
                        <div class="info-popup-meta">
                            ${rating ? `<span class="info-popup-pill rating"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg> ${rating}/10</span>` : ''}
                            ${year ? `<span class="info-popup-pill">${year}</span>` : ''}
                            <span class="info-popup-pill" id="info-popup-runtime"></span>
                        </div>
                        <div class="info-popup-actions">
                            <button class="info-popup-play" id="info-popup-play-btn">
                                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>
                                Play
                            </button>
                            <button class="info-popup-add ${isFavorite ? 'active' : ''}" id="info-popup-fav-btn" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
                                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="info-popup-body">
                <p class="info-popup-overview" id="info-popup-overview">${escHtml(plot)}</p>
                <div id="info-popup-genres"></div>
                <div id="info-popup-providers"></div>
                <div id="info-popup-cast"></div>
            </div>
        </div>`;
    }

    function updateMovieWithTmdb(el, details, title, fallbackPoster) {
        // Backdrop
        if (details.backdrop_path) {
            const bd = el.querySelector('#info-popup-backdrop');
            if (bd) bd.style.backgroundImage = `url(${TMDB_IMG}/w1280${details.backdrop_path})`;
        }
        // Poster upgrade
        if (details.poster_path) {
            const img = el.querySelector('.info-popup-poster');
            if (img) img.src = `${TMDB_IMG}/w342${details.poster_path}`;
        }
        // Runtime
        if (details.runtime) {
            const rt = el.querySelector('#info-popup-runtime');
            if (rt) { rt.textContent = fmtRuntime(details.runtime); rt.style.display = ''; }
        }
        // Overview (use TMDB if longer)
        if (details.overview) {
            const ov = el.querySelector('#info-popup-overview');
            if (ov && (!ov.textContent || details.overview.length > ov.textContent.length)) {
                ov.textContent = details.overview;
            }
        }
        // Genres
        const gEl = el.querySelector('#info-popup-genres');
        if (gEl) gEl.innerHTML = renderGenres(details.genres);
        // Providers
        const pEl = el.querySelector('#info-popup-providers');
        if (pEl) pEl.innerHTML = renderProviders(extractProviders(details['watch/providers'], title, false));
        // Cast
        const cEl = el.querySelector('#info-popup-cast');
        if (cEl) cEl.innerHTML = renderCast(details.credits);
    }

    // ── SERIES popup ──

    async function showSeries(series, { onPlayEpisode, onFavorite, isFavorite, sources }) {
        const el = getOverlay();
        if (!el) return;

        const title = series.name || '';
        const year = series.year || series.releaseDate?.substring(0, 4) || '';
        const rating = series.rating || '';
        const poster = series.cover || '/img/placeholder.png';

        el.innerHTML = buildSeriesHTML({ title, year, rating, poster, isFavorite, plot: series.plot || '' });
        el.classList.add('active');
        document.body.style.overflow = 'hidden';

        attachCloseHandlers(el);
        attachFavoriteHandler(el, onFavorite, isFavorite, series);

        // Fetch TMDB
        const tmdbId = await tmdbSearch(title, year, true);

        let tmdbDetails_ = null;
        if (tmdbId) {
            tmdbDetails_ = await tmdbDetails(tmdbId, true);
            if (tmdbDetails_) {
                updateSeriesWithTmdb(el, tmdbDetails_, title);
            }
        }

        buildEpisodesSection(el, series, tmdbId, onPlayEpisode, sources);
    }

    function buildSeriesHTML({ title, year, rating, poster, isFavorite, plot }) {
        const escapedTitle = escHtml(title);
        return `
        <div class="info-popup-modal nf-series-modal" role="dialog">
            <div class="nf-info-section" id="nf-info-section">
                <div class="info-popup-hero">
                    <div class="info-popup-backdrop" id="info-popup-backdrop"></div>
                    <button class="info-popup-close" aria-label="Close">${Icons.close}</button>
                    <div class="info-popup-hero-inner">
                        <div class="info-popup-poster-wrap">
                            <img class="info-popup-poster" src="${poster}" alt="${escapedTitle}"
                                 onerror="this.onerror=null;this.src='/img/placeholder.png'">
                        </div>
                        <div class="info-popup-header">
                            <h2 class="info-popup-title">${escapedTitle}</h2>
                            <div class="info-popup-meta">
                                ${rating ? `<span class="info-popup-pill rating"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg> ${rating}/10</span>` : ''}
                                ${year ? `<span class="info-popup-pill">${year}</span>` : ''}
                                <span class="info-popup-pill" id="info-popup-seasons-count"></span>
                            </div>
                            <div class="info-popup-status" id="info-popup-ep-count"></div>
                            <div class="info-popup-actions">
                                <button class="info-popup-play" id="info-popup-play-btn" disabled>
                                    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>
                                    Play
                                </button>
                                <button class="info-popup-add ${isFavorite ? 'active' : ''}" id="info-popup-fav-btn" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
                                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="info-popup-body">
                    <p class="info-popup-overview" id="info-popup-overview">${escHtml(plot)}</p>
                    <div id="info-popup-genres"></div>
                    <div id="info-popup-providers"></div>
                    <div id="info-popup-cast"></div>
                </div>
            </div>
            <div class="nf-episodes-section">
                <div class="nf-episodes-header">
                    <h3 class="nf-episodes-title">Episodes</h3>
                    <span class="nf-episodes-caption" id="nf-episodes-caption"></span>
                </div>
                <div class="nf-season-bar" id="nf-season-bar">
                    <span class="nf-season-label">Season</span>
                    <select class="season-select" id="nf-season-select"></select>
                </div>
                <div class="nf-ep-scroll" id="nf-ep-scroll">
                    <div class="nf-ep-list" id="nf-ep-list">
                        <div style="padding:22px;color:#777;">Loading episodes...</div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    function updateSeriesWithTmdb(el, details, title) {
        if (details.backdrop_path) {
            const bd = el.querySelector('#info-popup-backdrop');
            if (bd) bd.style.backgroundImage = `url(${TMDB_IMG}/w1280${details.backdrop_path})`;
        }
        if (details.poster_path) {
            const img = el.querySelector('.info-popup-poster');
            if (img) img.src = `${TMDB_IMG}/w342${details.poster_path}`;
        }
        if (details.number_of_seasons) {
            const sc = el.querySelector('#info-popup-seasons-count');
            if (sc) { sc.textContent = `${details.number_of_seasons} Season${details.number_of_seasons > 1 ? 's' : ''}`; sc.style.display = ''; }
        }
        if (details.overview) {
            const ov = el.querySelector('#info-popup-overview');
            if (ov && (!ov.textContent || details.overview.length > ov.textContent.length)) {
                ov.textContent = details.overview;
            }
        }
        const gEl = el.querySelector('#info-popup-genres');
        if (gEl) gEl.innerHTML = renderGenres(details.genres);
        const pEl = el.querySelector('#info-popup-providers');
        if (pEl) pEl.innerHTML = renderProviders(extractProviders(details['watch/providers'], title, true));
        const cEl = el.querySelector('#info-popup-cast');
        if (cEl) cEl.innerHTML = renderCast(details.credits);
    }

    function normalizeSeriesEpisodes(seriesInfo) {
        if (!seriesInfo) return null;
        let episodes = seriesInfo.episodes;
        if (!episodes) return null;

        if (!Array.isArray(episodes) && typeof episodes === 'object') {
            const keys = Object.keys(episodes);
            if (keys.length > 0 && Array.isArray(episodes[keys[0]])) {
                return episodes;
            }
            if (keys.length === 0) return null;
        }

        if (Array.isArray(episodes)) {
            const grouped = {};
            episodes.forEach(ep => {
                const sNum = ep.season || ep.season_number || '1';
                if (!grouped[sNum]) grouped[sNum] = [];
                grouped[sNum].push(ep);
            });
            return grouped;
        }

        return null;
    }

    async function buildEpisodesSection(el, series, tmdbId, onPlayEpisode, sources) {
        const select = el.querySelector('#nf-season-select');
        const epList = el.querySelector('#nf-ep-list');
        const epCountEl = el.querySelector('#info-popup-ep-count');
        const captionEl = el.querySelector('#nf-episodes-caption');
        const playBtn = el.querySelector('#info-popup-play-btn');
        let firstEpisodeData = null;
        let currentSeriesInfo = null;
        let activeSeriesId = null;

        const renderEpisodes = async (seasonEps, targetSeasonNum, displayLabel, seriesId) => {
            if (epCountEl) epCountEl.textContent = `${seasonEps.length} episode${seasonEps.length !== 1 ? 's' : ''}`;
            if (captionEl) captionEl.textContent = displayLabel;

            let tmdbEps = null;
            if (tmdbId && targetSeasonNum) {
                const seasonData = await tmdbSeasonDetails(tmdbId, targetSeasonNum);
                if (seasonData && seasonData.episodes) tmdbEps = seasonData.episodes;
            }

            epList.innerHTML = seasonEps.map((ep, idx) => {
                const epNum = ep.episode_num || ep.episode_number || (idx + 1);
                const epTitle = ep.title || ep.name || `Episode ${epNum}`;
                const tmdbEp = tmdbEps ? tmdbEps.find(e => e.episode_number === +epNum) : null;
                const thumb = tmdbEp && tmdbEp.still_path ? `${TMDB_IMG}/w300${tmdbEp.still_path}` : '';

                return `
                <button class="nf-ep-row" data-ep-id="${ep.id}" data-spec-series-id="${seriesId}" data-source-id="${series.sourceId}"
                        data-container="${ep.container_extension || ep.container || 'mp4'}" data-season="${targetSeasonNum}" data-ep-num="${epNum}">
                    <span class="nf-ep-num">${String(epNum).padStart(2, '0')}</span>
                    <div class="nf-ep-thumb">
                        ${thumb
                            ? `<img src="${thumb}" alt="" loading="lazy"><div class="nf-thumb-play"><svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M8 5v14l11-7z"/></svg></div>`
                            : `<span class="nf-ep-thumb-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg></span>`
                        }
                    </div>
                    <div class="nf-ep-info">
                        <div class="nf-ep-title">${escHtml(epTitle)}</div>
                        <div class="nf-ep-sxex">S${String(targetSeasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}</div>
                    </div>
                    <div class="nf-ep-play-btn">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </button>`;
            }).join('');

            if (seasonEps.length > 0) {
                firstEpisodeData = seasonEps[0];
                if (playBtn) playBtn.disabled = false;
            }

            epList.querySelectorAll('.nf-ep-row').forEach(row => {
                row.addEventListener('click', () => {
                    const epId = row.dataset.epId;
                    const srcId = parseInt(row.dataset.sourceId);
                    const container = row.dataset.container || 'mp4';
                    const sNum = row.dataset.season;
                    const eNum = row.dataset.epNum;
                    const specId = row.dataset.specSeriesId;
                    close();
                    if (specId) series.specSeriesId = specId;
                    onPlayEpisode(epId, srcId, container, sNum, eNum, series, currentSeriesInfo, sources);
                });
            });
        };

        if (playBtn) {
            playBtn.onclick = () => {
                if (!firstEpisodeData) return;
                const epNum = firstEpisodeData.episode_num || firstEpisodeData.episode_number || '1';
                close();
                if (activeSeriesId) series.specSeriesId = activeSeriesId;
                onPlayEpisode(
                    firstEpisodeData.id,
                    series.sourceId,
                    firstEpisodeData.container_extension || firstEpisodeData.container || 'mp4',
                    1, 
                    epNum, series, currentSeriesInfo, sources
                );
            };
        }

        if (series.seasonsList && series.seasonsList.length > 1) {
            window.probedCache = window.probedCache || {};
            const cacheKeyPrefix = `xtream_${series.sourceId}_`;

            const tryLoadEpisodes = async (seriesId) => {
                try {
                    const res = await fetch(`/api/proxy/xtream/${series.sourceId}/series_info?series_id=${seriesId}`);
                    const info = await res.json();
                    const episodes = normalizeSeriesEpisodes(info);
                    if (!episodes || Object.keys(episodes).length === 0) return [];
                    return Object.values(episodes).flat();
                } catch (err) {
                    return [];
                }
            };

            async function runPreFlightProbe() {
                epList.innerHTML = '<div class="text-center py-4" style="color:#aaa;"><i class="bi bi-hourglass-split me-2"></i>Locating episodes across seasons...</div>';
                
                // === SIMPLE DEBUG - shows the raw seasonsList structure ===    
                console.log("=== FULL seasonsList STRUCTURE ===", series.seasonsList);    
                
                let firstWorkingId = null;    
                const optionsHTML = [];    
                
                for (const season of series.seasonsList) {        
                    const seriesId = season.series_id || season.id || season.serie_id;        
                    if (!seriesId) continue;        
                    
                    const cacheKey = cacheKeyPrefix + seriesId;        
                    let episodes = window.probedCache[cacheKey] !== undefined             
                        ? window.probedCache[cacheKey]             
                        : await tryLoadEpisodes(seriesId);        
                        
                    window.probedCache[cacheKey] = episodes;        
                    console.log(`[DEBUG] name="${season.name}" | id=${seriesId} | episodes=${episodes.length}`);        
                    
                    const label = window.extractSeasonLabel ? window.extractSeasonLabel(season.name, series.displayName) : season.name;
                    const isEmpty = episodes.length === 0;        
                    optionsHTML.push(`<option value="${seriesId}" ${isEmpty ? 'data-empty="true"' : ''}>${label}${isEmpty ? ' (Empty)' : ''}</option>`);        
                    
                    if (!firstWorkingId && !isEmpty) firstWorkingId = seriesId;    
                }    
                
                select.innerHTML = optionsHTML.join('');    
                
                if (firstWorkingId) {        
                    select.value = firstWorkingId;        
                    const eps = window.probedCache[cacheKeyPrefix + firstWorkingId];
                    const label = select.options[select.selectedIndex]?.textContent || 'Episodes';
                    const m = label.match(/\d+/);
                    const sNum = m ? parseInt(m[0]) : 1;
                    renderEpisodes(eps, sNum, label.replace(' (Empty)', ''), firstWorkingId);    
                } else {        
                    epList.innerHTML = `            
                        <div class="text-center py-5">                
                            <i class="bi bi-emoji-dizzy fs-1 text-warning d-block mb-3"></i>                
                            <p class="text-warning fw-bold">Figuring out</p>                
                            <small class="text-muted">The provider has listed this season, but no media files are attached.</small>            
                        </div>`;    
                }
            }

            select.addEventListener('change', async (e) => {
                const targetId = e.target.value;
                const eps = window.probedCache[cacheKeyPrefix + targetId] || [];
                const label = select.options[select.selectedIndex]?.textContent || 'Episodes';
                const m = label.match(/\d+/);
                const sNum = m ? parseInt(m[0]) : 1;
                if (eps.length === 0) {
                    epList.innerHTML = '<div style="padding:22px; text-align:center;"><p style="color:#aaa;">No episodes available.</p></div>';
                } else {
                    renderEpisodes(eps, sNum, label.replace(' (Empty)', ''), targetId);
                }
            });

            runPreFlightProbe();

        } else {
            select.innerHTML = '<option>Loading...</option>';
            const loadNormal = async () => {
                try {
                    const res = await fetch(`/api/proxy/xtream/${series.sourceId}/series_info?series_id=${series.series_id}`);
                    const info = await res.json();
                    const episodes = normalizeSeriesEpisodes(info);
                    if (!episodes || Object.keys(episodes).length === 0) {
                        epList.innerHTML = '<p style="padding:22px;color:#777;">No episodes found</p>';
                        select.innerHTML = '';
                        return;
                    }
                    currentSeriesInfo = info;
                    activeSeriesId = series.series_id;
                    
                    const seasons = Object.keys(episodes).sort((a,b)=>+a - +b);
                    select.innerHTML = '';
                    seasons.forEach(sNum => {
                        const opt = document.createElement('option');
                        opt.value = sNum;
                        opt.textContent = `Season ${sNum}`;
                        select.appendChild(opt);
                    });
                    
                    const doRenderSeason = (sNum) => {
                        renderEpisodes(episodes[sNum], sNum, `Season ${sNum}`, series.series_id);
                    };
                    
                    select.addEventListener('change', (e) => doRenderSeason(e.target.value));
                    if (seasons.length > 0) doRenderSeason(seasons[0]);
                } catch(e) {
                    epList.innerHTML = '<p style="padding:22px;color:#777;">Error loading episodes</p>';
                    select.innerHTML = '';
                }
            };
            loadNormal();
        }
    }

    // ── Shared handlers ──

    function attachCloseHandlers(el) {
        // Close button
        el.querySelector('.info-popup-close')?.addEventListener('click', close);
        // Click backdrop
        el.addEventListener('click', (e) => {
            if (e.target === el) close();
        });
        // Escape key
        const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
        currentCleanup = () => document.removeEventListener('keydown', onKey);
    }

    function attachPlayHandler(el, onPlay) {
        const btn = el.querySelector('#info-popup-play-btn');
        if (btn && onPlay) {
            btn.addEventListener('click', () => { close(); onPlay(); });
        }
    }

    function attachFavoriteHandler(el, onFavorite, initialFav, item) {
        const btn = el.querySelector('#info-popup-fav-btn');
        if (!btn || !onFavorite) return;
        let fav = initialFav;
        btn.addEventListener('click', () => {
            fav = !fav;
            btn.classList.toggle('active', fav);
            btn.title = fav ? 'Remove from Favorites' : 'Add to Favorites';
            onFavorite(item, fav);
        });
    }

    function escHtml(s) {
        if (!s) return '';
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    return { showMovie, showSeries, close };
})();

window.InfoPopup = InfoPopup;
