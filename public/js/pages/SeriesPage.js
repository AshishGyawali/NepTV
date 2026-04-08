/**
 * Series Page Controller
 * Handles TV series browsing and playback
 */

// Utility function to clean up Xtream series names
function cleanSeriesName(name) {
    if (!name) return "";
    return name
        .replace(/\s*\(\d{4}\)/g, '')       // Removes (2024), (2023)
        .replace(/\s*\(US\)/i, '')          // Removes (US)
        .replace(/\s*S\d+/i, '')            // Removes S01, S2
        .replace(/^EN\s*-\s*/i, '')         // Removes "EN - " prefixes (like in your 56 Days screenshot)
        .trim();
}

class SeriesPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('series-grid');
        this.sourceSelect = document.getElementById('series-source-select');
        this.categorySelect = document.getElementById('series-category-select');
        this.searchInput = document.getElementById('series-search');
        this.detailsPanel = document.getElementById('series-details');
        this.seasonsContainer = document.getElementById('series-seasons');

        this.seriesList = [];
        this.categories = [];
        this.sources = [];
        this.currentBatch = 0;
        this.batchSize = 24;
        this.filteredSeries = [];
        this.isLoading = false;
        this.observer = null;
        this.hiddenCategoryIds = new Set();
        this.currentSeries = null;
        this.favoriteIds = new Set(); // Track favorite series IDs
        this.showFavoritesOnly = false;

        this.init();
    }

    init() {
        // Source change handler
        this.sourceSelect?.addEventListener('change', async () => {
            await this.loadCategories();
            await this.loadSeries();
        });

        // Category change handler
        this.categorySelect?.addEventListener('change', () => {
            this.loadSeries();
        });

        // Search with debounce
        let searchTimeout;
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.filterAndRender(), 300);
        });

        // Back button
        document.querySelector('.series-back-btn')?.addEventListener('click', () => {
            this.hideDetails();
        });

        // Set up IntersectionObserver for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.renderNextBatch();
            }
        }, { rootMargin: '200px' });

        // Favorites filter toggle
        const favBtn = document.getElementById('series-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.filterAndRender();
        });
    }

    async show() {
        // Hide details panel when showing page
        this.hideDetails();

        // Load sources if not loaded
        // Load sources if not loaded
        if (this.sources.length === 0) {
            await this.loadSources();
        }

        // Load favorites
        await this.loadFavorites();

        // Load series if empty
        if (this.seriesList.length === 0) {
            await this.loadCategories();
            await this.loadSeries();
        }
    }

    hide() {
        // Page is hidden
    }

    async loadFavorites() {
        try {
            const favs = await API.favorites.getAll(null, 'series');
            this.favoriteIds = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    async loadSources() {
        try {
            const allSources = await API.sources.getAll();
            this.sources = allSources.filter(s => (s.type === 'xtream' || s.type === 'stalker') && s.enabled);

            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';
            this.sources.forEach(s => {
                const option = document.createElement('option');
                option.value = s.id;
                option.textContent = s.name;
                this.sourceSelect.appendChild(option);
            });
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    async loadCategories() {
        try {
            this.categories = [];
            this.hiddenCategoryIds = new Set();
            this.categorySelect.innerHTML = '<option value="">All Categories</option>';

            const sourceId = this.sourceSelect.value;
            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            // Fetch hidden items for each source
            for (const source of sourcesToLoad) {
                try {
                    const hiddenItems = await API.channels.getHidden(source.id);
                    hiddenItems.forEach(h => {
                        if (h.item_type === 'series_category') {
                            this.hiddenCategoryIds.add(`${source.id}:${h.item_id}`);
                        }
                    });
                } catch (err) {
                    console.warn(`Failed to load hidden items from source ${source.id}`);
                }
            }

            for (const source of sourcesToLoad) {
                try {
                    const cats = await API.proxy.xtream.seriesCategories(source.id);
                    if (cats && Array.isArray(cats)) {
                        cats.forEach(c => {
                            // Skip hidden categories
                            if (!this.hiddenCategoryIds.has(`${source.id}:${c.category_id}`)) {
                                this.categories.push({ ...c, sourceId: source.id });
                            }
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load series categories from source ${source.id}:`, err.message);
                }
            }

            // Populate dropdown
            this.categories.forEach(c => {
                const option = document.createElement('option');
                option.value = `${c.sourceId}:${c.category_id}`;
                option.textContent = c.category_name;
                this.categorySelect.appendChild(option);
            });
        } catch (err) {
            console.error('Error loading categories:', err);
        }
    }

    async loadSeries() {
        this.isLoading = true;

        const hasStalker = this.sources.some(s => s.type === 'stalker');
        const loadingMsg = hasStalker
            ? 'Fetching series from portal... This may take a moment.'
            : 'Loading series...';

        this.container.innerHTML = `
            <div class="loading-container">
                <div class="loading-spinner"></div>
                <p class="loading-text">${loadingMsg}</p>
            </div>
        `;

        try {
            this.seriesList = [];

            const sourceId = this.sourceSelect.value;
            const categoryValue = this.categorySelect.value;

            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            for (const source of sourcesToLoad) {
                try {
                    // Parse category if selected
                    let catId = null;
                    if (categoryValue) {
                        const [catSourceId, categoryId] = categoryValue.split(':');
                        if (parseInt(catSourceId) === source.id) {
                            catId = categoryId;
                        } else if (sourceId) {
                            continue;
                        }
                    }

                    const series = await API.proxy.xtream.series(source.id, catId);
                    console.log(`[Series] Source ${source.id}, Category ${catId || 'ALL'}: Got ${series?.length || 0} series`);
                    if (series && Array.isArray(series)) {
                        series.forEach(s => {
                            // Skip series from hidden categories
                            if (this.hiddenCategoryIds.has(`${source.id}:${s.category_id}`)) {
                                return;
                            }
                            this.seriesList.push({
                                ...s,
                                sourceId: source.id,
                                id: `${source.id}:${s.series_id}`
                            });
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load series from source ${source.id}:`, err.message);
                }
            }

            console.log(`[Series] Total loaded: ${this.seriesList.length} series`);
            this.filterAndRender();
        } catch (err) {
            console.error('Error loading series:', err);
            this.container.innerHTML = '<div class="empty-state"><p>Error loading series</p></div>';
        } finally {
            this.isLoading = false;
        }
    }

    filterAndRender() {
        const searchTerm = this.searchInput?.value?.toLowerCase() || '';

        this.filteredSeries = this.seriesList.filter(s => {
            // Filter by favorites if enabled
            if (this.showFavoritesOnly) {
                const favKey = `${s.sourceId}:${s.series_id}`;
                if (!this.favoriteIds.has(favKey)) return false;
            }
            if (searchTerm && !s.name?.toLowerCase().includes(searchTerm)) {
                return false;
            }
            return true;
        });

        console.log(`[Series] Displaying ${this.filteredSeries.length} of ${this.seriesList.length} series`);

        const grouped = {};
        this.filteredSeries.forEach(series => {
            const cleanName = cleanSeriesName(series.name).toLowerCase();
            const key = `${series.sourceId}_${cleanName}`;
            if (!grouped[key]) {
                grouped[key] = {
                    ...series,
                    displayName: cleanSeriesName(series.name),
                    seasonsList: [series]
                };
            } else {
                if (!grouped[key].seasonsList.some(s => s.series_id === series.series_id)) {
                    grouped[key].seasonsList.push(series);
                }
            }
        });
        
        this.groupedSeries = Object.values(grouped).map(group => {
            group.seasonsList.sort((a,b) => a.name.localeCompare(b.name));
            return group;
        });

        this.currentBatch = 0;
        this.container.innerHTML = '';

        if (this.groupedSeries.length === 0) {
            this.container.innerHTML = '<div class="empty-state"><p>No series found</p></div>';
            return;
        }

        // Create loader element
        const loader = document.createElement('div');
        loader.className = 'series-loader';
        loader.innerHTML = '<div class="loading-spinner"></div>';
        this.container.appendChild(loader);

        // Render initial batches
        for (let i = 0; i < 5; i++) {
            this.renderNextBatch();
        }

        // Start observing loader
        this.observer.observe(loader);
    }

    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const batch = this.groupedSeries.slice(start, end);

        if (batch.length === 0) {
            const loader = this.container.querySelector('.series-loader');
            if (loader) loader.style.display = 'none';
            return;
        }

        const fragment = document.createDocumentFragment();

        batch.forEach(series => {
            const card = document.createElement('div');
            card.className = 'series-card';
            card.dataset.seriesId = series.series_id;
            card.dataset.sourceId = series.sourceId;

            const poster = series.cover || '/img/placeholder.png';
            const year = series.year || series.releaseDate?.substring(0, 4) || '';
            const rating = series.rating ? `${Icons.star} ${series.rating}` : '';

            const isFav = this.favoriteIds.has(`${series.sourceId}:${series.series_id}`);

            card.innerHTML = `
                <div class="series-poster">
                    <img src="${poster}" alt="${series.name}"
                         onerror="this.onerror=null;this.src='/img/placeholder.png'" loading="lazy">
                    <div class="series-play-overlay">
                        <span class="play-icon">${Icons.play}</span>
                    </div>
                    <button class="favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                        <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                    </button>
                    <button class="info-btn" title="More Info">${Icons.arrowDownCircle}</button>
                </div>
                <div class="series-card-info">
                    <div class="series-title">${series.displayName || cleanSeriesName(series.name)}</div>
                    <div class="series-meta">
                        ${year ? `<span>${year}</span>` : ''}
                        ${rating ? `<span>${rating}</span>` : ''}
                    </div>
                </div>
            `;

            card.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) {
                    const btn = e.target.closest('.favorite-btn');
                    this.toggleFavorite(series, btn);
                    e.stopPropagation();
                } else if (e.target.closest('.info-btn')) {
                    e.stopPropagation();
                    this.showInfoPopup(series);
                } else {
                    this.showInfoPopup(series);
                }
            });
            fragment.appendChild(card);
        });

        // Insert before loader
        const loader = this.container.querySelector('.series-loader');
        if (loader) {
            this.container.insertBefore(fragment, loader);
        } else {
            this.container.appendChild(fragment);
        }

        this.currentBatch++;

        // Hide loader if done
        if (end >= this.groupedSeries.length && loader) {
            loader.style.display = 'none';
        }
    }

    async showSeriesDetails(series) {
        this.currentSeries = series;

        // Show details panel
        this.container.classList.add('hidden');
        this.detailsPanel.classList.remove('hidden');

        // Set header info
        document.getElementById('series-poster').src = series.cover || '/img/placeholder.png';
        document.getElementById('series-title').textContent = series.displayName || cleanSeriesName(series.name);
        document.getElementById('series-plot').textContent = series.plot || '';

        // Build header with Part Selector if split-seasons
        this.seasonsContainer.innerHTML = '<div id="series-episodes-viewport"><div class="loading"><div class="loading-spinner"></div><div style="text-align:center; margin-top:10px; color:#aaa;">Locating episodes...</div></div></div>';
        
        let headerHtml = '';
        let workingSeriesId = series.series_id;
        let initialEpisodes = null;
        let probedCache = {};
        
        const fetchEpisodesData = async (seriesId) => {
            try {
                const info = await API.proxy.xtream.seriesInfo(series.sourceId, seriesId);
                if (!info || !info.episodes || Object.keys(info.episodes).length === 0) {
                    probedCache[seriesId] = null;
                    return null;
                }
                probedCache[seriesId] = info;
                return info;
            } catch (err) {
                probedCache[seriesId] = null;
                return null;
            }
        };

        if (series.seasonsList && series.seasonsList.length > 1) {
            // Sequential Probe
            for (const season of series.seasonsList) {
                const info = await fetchEpisodesData(season.series_id);
                if (info) {
                    workingSeriesId = season.series_id;
                    initialEpisodes = info;
                    break;
                }
                await new Promise(r => setTimeout(r, 100)); // micro-delay
            }

            headerHtml = `
            <div class="season-selector-wrapper" style="margin-bottom: 20px; display: flex; align-items: center; gap: 10px;">
                <span style="color: #aaa;">Season</span>
                <select id="series-part-select" class="dropdown-select" style="padding: 5px; border-radius: 4px; background: #2a2a2a; color: #fff; border: 1px solid #444;">
                    ${series.seasonsList.map(s => {
                        const label = window.extractSeasonLabel(s.name, series.displayName);
                        const isEmptyStr = (probedCache[s.series_id] === null) ? ' (Empty)' : '';
                        const isSelected = s.series_id === workingSeriesId ? 'selected' : '';
                        return `<option value="${s.series_id}" ${isSelected}>${label}${isEmptyStr}</option>`;
                    }).join('')}
                </select>
            </div>
            `;
        } else {
            // Normal fallback
            initialEpisodes = await fetchEpisodesData(series.series_id);
        }

        this.seasonsContainer.innerHTML = headerHtml + '<div id="series-episodes-viewport"></div>';
        const viewport = this.seasonsContainer.querySelector('#series-episodes-viewport');
        const selectEl = this.seasonsContainer.querySelector('#series-part-select');

        const renderGroup = (seasonName, episodes, seriesId) => {
            return `
            <div class="season-group">
                <div class="season-header">
                    <span class="season-expander">${Icons.chevronDown}</span>
                    <span class="season-name">${seasonName} (${episodes.length} episodes)</span>
                </div>
                <div class="episode-list">
                    ${episodes.map(ep => `
                        <div class="episode-item" data-episode-id="${ep.id}" data-spec-series-id="${seriesId}" data-source-id="${series.sourceId}" data-container="${ep.container_extension || 'mp4'}">
                            <span class="episode-number">E${ep.episode_num || ep.episode_number || ''}</span>
                            <span class="episode-title">${ep.title || `Episode ${ep.episode_num || ep.episode_number || ''}`}</span>
                            <span class="episode-duration">${ep.duration || ''}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        };

        const loadPart = async (seriesId) => {
            viewport.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
            
            let info = probedCache[seriesId];
            if (info === undefined) {
                info = await fetchEpisodesData(seriesId);
            }

            if (!info) {
                viewport.innerHTML = '<div style="padding: 20px; text-align: center;"><p class="hint" style="color: #aaa;">No episodes available.</p><p style="color: #666; font-size: 0.9em; margin-top: 5px;">The provider has listed this season, but no media files are attached.</p></div>';
                return;
            }

            this.currentSeriesInfo = info;
            let html = '';

            if (series.seasonsList && series.seasonsList.length > 1) {
                const flatEps = Object.values(info.episodes).flat();
                let displayLabel = "Episodes";
                if (selectEl) {
                    const opt = selectEl.options[selectEl.selectedIndex];
                    displayLabel = opt ? opt.text.replace(' (Empty)', '') : "Episodes";
                }
                html += renderGroup(displayLabel, flatEps, seriesId);
            } else {
                const seasons = Object.keys(info.episodes).sort((a, b) => parseInt(a) - parseInt(b));
                seasons.forEach(sNum => {
                    html += renderGroup(`Season ${sNum}`, info.episodes[sNum], seriesId);
                });
            }
            
            viewport.innerHTML = html;

            viewport.querySelectorAll('.season-header').forEach(header => {
                header.addEventListener('click', () => {
                    header.closest('.season-group').classList.toggle('collapsed');
                });
            });

            viewport.querySelectorAll('.episode-item').forEach(ep => {
                ep.addEventListener('click', () => this.playEpisode(ep));
            });
        };

        if (selectEl) {
            selectEl.addEventListener('change', (e) => loadPart(e.target.value));
        }
        
        loadPart(workingSeriesId);
    }

    hideDetails() {
        this.detailsPanel.classList.add('hidden');
        this.container.classList.remove('hidden');
        this.currentSeries = null;
    }

    async playEpisode(episodeEl) {
        const episodeId = episodeEl.dataset.episodeId;
        const sourceId = parseInt(episodeEl.dataset.sourceId);
        const container = episodeEl.dataset.container || 'mp4';

        // Get season and episode number from the episode element context
        const seasonGroup = episodeEl.closest('.season-group');
        const seasonHeader = seasonGroup?.querySelector('.season-name')?.textContent || '';
        const seasonMatch = seasonHeader.match(/Season (\d+)/);
        const seasonNum = seasonMatch ? seasonMatch[1] : '1';
        const episodeNum = episodeEl.querySelector('.episode-number')?.textContent?.replace('E', '') || '1';

        try {
            // Get stream URL for episode (use 'series' type)
            const source = this.sources.find(s => s.id === sourceId);
            const isStalker = source && source.type === 'stalker';
            const result = isStalker
                ? { url: `stalker://${sourceId}/${episodeId}/series` }
                : await API.proxy.xtream.getStreamUrl(sourceId, episodeId, 'series', container);

            if (result && result.url) {
                // Play in dedicated Watch page
                if (this.app.pages.watch) {
                    const episodeTitle = episodeEl.querySelector('.episode-title')?.textContent || `Episode ${episodeNum}`;

                    this.app.pages.watch.play({
                        type: 'series',
                        id: episodeId,
                        title: this.currentSeries?.displayName || cleanSeriesName(this.currentSeries?.name || 'Series'),
                        subtitle: `S${seasonNum} E${episodeNum} - ${episodeTitle}`,
                        poster: this.currentSeries?.cover,
                        description: this.currentSeries?.plot || '',
                        year: this.currentSeries?.year,
                        rating: this.currentSeries?.rating,
                        sourceId: sourceId,
                        seriesId: episodeEl.dataset.specSeriesId || this.currentSeries?.series_id,
                        seriesInfo: this.currentSeriesInfo,
                        currentSeason: seasonNum,
                        currentEpisode: episodeNum,
                        containerExtension: container
                    }, result.url);
                }
            }
        } catch (err) {
            console.error('Error playing episode:', err);
        }
    }

    showInfoPopup(series) {
        const favKey = `${series.sourceId}:${series.series_id}`;
        const isFav = this.favoriteIds.has(favKey);

        InfoPopup.showSeries(series, {
            isFavorite: isFav,
            sources: this.sources,
            onPlayEpisode: (epId, srcId, container, seasonNum, epNum, seriesObj, seriesInfo) => {
                this.playEpisodeFromPopup(epId, srcId, container, seasonNum, epNum, seriesObj, seriesInfo);
            },
            onFavorite: (item, nowFav) => {
                const key = `${item.sourceId}:${item.series_id}`;
                if (nowFav) {
                    this.favoriteIds.add(key);
                    API.favorites.add(item.sourceId, item.series_id, 'series').catch(() => this.favoriteIds.delete(key));
                } else {
                    this.favoriteIds.delete(key);
                    API.favorites.remove(item.sourceId, item.series_id, 'series').catch(() => this.favoriteIds.add(key));
                }
                const card = this.container.querySelector(`.series-card[data-series-id="${item.series_id}"][data-source-id="${item.sourceId}"]`);
                if (card) {
                    const btn = card.querySelector('.favorite-btn');
                    const iconSpan = btn?.querySelector('.fav-icon');
                    if (btn) { btn.classList.toggle('active', nowFav); btn.title = nowFav ? 'Remove from Favorites' : 'Add to Favorites'; }
                    if (iconSpan) iconSpan.innerHTML = nowFav ? Icons.favorite : Icons.favoriteOutline;
                }
            }
        });
    }

    async playEpisodeFromPopup(episodeId, sourceId, container, seasonNum, episodeNum, seriesObj, seriesInfo) {
        try {
            const source = this.sources.find(s => s.id === sourceId);
            const isStalker = source && source.type === 'stalker';
            const result = isStalker
                ? { url: `stalker://${sourceId}/${episodeId}/series` }
                : await API.proxy.xtream.getStreamUrl(sourceId, episodeId, 'series', container);

            if (result && result.url && this.app.pages.watch) {
                const episodes = seriesInfo?.episodes?.[seasonNum] || [];
                const ep = episodes.find(e => String(e.id) === String(episodeId));
                const episodeTitle = ep?.title || `Episode ${episodeNum}`;

                this.app.pages.watch.play({
                    type: 'series',
                    id: episodeId,
                    title: seriesObj?.displayName || cleanSeriesName(seriesObj?.name || 'Series'),
                    subtitle: `S${seasonNum} E${episodeNum} - ${episodeTitle}`,
                    poster: seriesObj?.cover,
                    description: seriesObj?.plot || '',
                    year: seriesObj?.year,
                    rating: seriesObj?.rating,
                    sourceId: sourceId,
                    seriesId: seriesObj?.series_id,
                    seriesInfo: seriesInfo,
                    currentSeason: seasonNum,
                    currentEpisode: episodeNum,
                    containerExtension: container
                }, result.url);
            }
        } catch (err) {
            console.error('Error playing episode from popup:', err);
        }
    }

    async toggleFavorite(series, btn) {
        const favKey = `${series.sourceId}:${series.series_id}`;
        const isFav = this.favoriteIds.has(favKey);
        const iconSpan = btn.querySelector('.fav-icon');

        try {
            // Optimistic update
            if (isFav) {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                btn.title = 'Add to Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
                await API.favorites.remove(series.sourceId, series.series_id, 'series');
            } else {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                btn.title = 'Remove from Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
                await API.favorites.add(series.sourceId, series.series_id, 'series');
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            // Revert on error
            if (isFav) {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
            } else {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
            }
        }
    }
}

window.SeriesPage = SeriesPage;
