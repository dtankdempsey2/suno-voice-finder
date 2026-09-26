// ==UserScript==
// @name         Suno Public Voice Finder
// @namespace    suno-voice-finder
// @version      0.7.3
// @description  Compact Voice and Discover searches with remix tags, language/model filters, and CSV export
// @match        https://suno.com/*
// @match        https://www.suno.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(() => {
    'use strict';

    const w = unsafeWindow;

    const POSITION_STORAGE_KEY =
        'sunoVoiceFinderPanelPosition';

    const NAV_ID =
        'suno-voice-finder-nav';

    const PANEL_ID =
        'suno-public-voice-finder';

    /*
     * Safety guardrail.
     *
     * This prevents a very long browsing session from
     * growing the results list indefinitely.
     */
    const MAX_VOICES = 500;
    const MAX_DISCOVER_SONGS = 5000;
    const DISCOVER_PAGE_SIZE = 100;
    const SONG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    /*
     * How often we check whether Suno rebuilt the sidebar.
     *
     * This replaces the old full-page MutationObserver.
     */
    const SIDEBAR_CHECK_INTERVAL = 2500;
    const AUTO_SCROLL_INTERVAL = 7000;
    const SEARCH_URL = 'https://studio-api-prod.suno.com/api/search/';
    const SEARCH_SIZE = 1000;
    const SEARCH_SORTS = [
        ['most_relevant', 'Most relevant'],
        ['trending', 'Trending'],
        ['play_count', 'Most played'],
        ['oldest', 'Oldest'],
        ['most_recent', 'Most recent']
    ];

    /* Suno's currently displayed filter labels. Only the v6 backend value
     * is established by the supplied request sample. Other model values use
     * their UI labels verbatim until a matching request confirms the tokens. */
    const LANGUAGE_OPTIONS = ["Arabic", "Bengali", "Chinese", "Czech", "Dutch", "English", "Finnish", "French", "German", "Greek", "Gujarati", "Hebrew", "Hindi", "Hungarian", "Indonesian", "Italian", "Japanese", "Kazakh", "Korean", "Malay", "Persian", "Polish", "Portuguese", "Panjabi", "Russian", "Spanish", "Swedish", "Tagalog", "Tamil", "Telugu", "Thai", "Turkish", "Ukrainian", "Urdu", "Vietnamese"];
    const MODEL_OPTIONS = ["v3.0", "v3.5", "v4.0", "v4.5", "v4.5+", "v5", "v5.5", "v6", "Studio"];
    const filtersByTab = {
        voice: { languages: new Set(), model_versions: new Set() },
        discover: { languages: new Set(), model_versions: new Set() }
    };

    function validatedSelections(raw, allowed) {
        if (!Array.isArray(raw)) return new Set();
        const valid = new Set(allowed);
        return new Set(raw.filter(value => typeof value === 'string' && valid.has(value)));
    }

    function searchFiltersForTab(tab) {
        const filters = filtersByTab[tab];
        return {
            ...(filters.languages.size ? { languages: [...filters.languages] } : {}),
            ...(filters.model_versions.size ? { model_versions: [...filters.model_versions] } : {})
        };
    }

    function updateFilterSummaries(panel = document.getElementById(PANEL_ID)) {
        if (!panel) return;
        const filters = filtersByTab[activeTab];
        const langs = panel.querySelector('[data-suno-filter-summary="languages"]');
        const models = panel.querySelector('[data-suno-filter-summary="model_versions"]');
        if (langs) langs.textContent = filters.languages.size
            ? `Lang (${filters.languages.size})` : 'Lang · Any';
        if (models) models.textContent = filters.model_versions.size
            ? `Model (${filters.model_versions.size})` : 'Model · Any';
    }

    function renderFilterDropdown(key, title, options, selected, busy) {
        return `<details data-suno-filter="${key}" style="position:relative;flex:1;min-width:0;">
            <summary data-suno-filter-summary="${key}" aria-label="${title} filter" style="list-style:none;cursor:pointer;padding:5px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid #555;border-radius:6px;background:#202020;color:#fff;font-size:10px;">
                ${title}${selected.size ? ` (${selected.size})` : ' · Any'}
            </summary>
            <div class="suno-filter-menu" style="position:absolute;left:0;right:0;top:calc(100% + 3px);z-index:30;max-height:185px;overflow-y:auto;overscroll-behavior:contain;background:#202020;border:1px solid #666;border-radius:7px;box-shadow:0 6px 18px #0009;">
                <button type="button" class="suno-filter-clear" data-filter="${key}" ${busy ? 'disabled' : ''} style="display:block;position:sticky;top:0;width:100%;padding:8px;border:0;border-bottom:1px solid #555;background:#282828;color:#cbb9ff;text-align:left;cursor:pointer;font-size:11px;">Clear selection · Any</button>
                ${options.map((value, index) => `<label style="display:flex;gap:7px;align-items:center;padding:6px;cursor:pointer;font-size:11px;">
                    <input class="suno-filter-checkbox" data-filter="${key}" type="checkbox" value="${escapeHTML(value)}" ${selected.has(value) ? 'checked' : ''} ${busy ? 'disabled' : ''} style="accent-color:#7c4dff;">
                    <span>${escapeHTML(value)}</span>
                </label>`).join('')}
            </div>
        </details>`;
    }

    let searchTerm = '';
    let searchRank = 'most_relevant';
    let searchTemplate = null;
    let searchController = null;
    let searchStatus = '';
    let activeTab = 'voice';
    const discoveredSongs = new Map();
    let discoverSearchTerm = '';
    let discoverSearchRank = 'most_relevant';
    let discoverSearchStatus = '';
    let discoverController = null;
    let discoverVisible = DISCOVER_PAGE_SIZE;
    let discoverRemixFilter = 'all'; // Client-side view/export filter; never sent as an unverified API parameter.
    const listScrollTop = { voice: 0, discover: 0 };
    const GENRE_HANDOFF_KEY = 'sunoVoiceFinderGenreHandoff';
    let genreNavigationStarted = false;
    let pendingGenreSearch = false;

    /*
     * ============================================================
     * STATE
     * ============================================================
     */

    const found = new Map();

    let panelOpen = false;
    let monitoring = false;

    let renderQueued = false;

    let autoScrollEnabled = false;
    let autoScrollTimer = null;
    let autoScrollTarget = null;

    /*
     * ============================================================
     * SUNO API DETECTION
     * ============================================================
     */

    function isSunoApiUrl(url) {
        try {
            const parsed = new URL(
                String(url),
                window.location.href
            );

            const isSunoHost =
                parsed.hostname === 'suno.com' ||
                parsed.hostname.endsWith('.suno.com');

            return (
                isSunoHost &&
                parsed.pathname.startsWith('/api/')
            );

        } catch {
            return false;
        }
    }

    function getSourceName(url) {
        try {
            const parsed = new URL(
                String(url),
                window.location.href
            );

            return (
                parsed.pathname
                    .replace(/^\/api\//, '')
                    .replace(/\/+$/, '') ||
                'api'
            );

        } catch {
            return 'api';
        }
    }

    /*
     * ============================================================
     * STRICT CHEAP PREFILTER
     * ============================================================
     *
     * Previously we parsed any response mentioning:
     *
     * "persona_type"
     *
     * Now the response must specifically contain:
     *
     * "persona_type": "vox"
     *
     * or:
     *
     * "is_voice_persona": true
     *
     * This prevents huge unrelated API responses from being
     * JSON.parsed and recursively traversed.
     */

    const VOX_PATTERN =
        /"persona_type"\s*:\s*"vox"/;

    const VOICE_PERSONA_PATTERN =
        /"is_voice_persona"\s*:\s*true/;

    function textMayContainVoice(text) {
        if (
            !text ||
            typeof text !== 'string'
        ) {
            return false;
        }

        return (
            VOX_PATTERN.test(text) ||
            VOICE_PERSONA_PATTERN.test(text)
        );
    }

    /*
     * ============================================================
     * VOICE DETECTION
     * ============================================================
     */

    function isVoicePersona(obj) {
        return (
            obj &&
            typeof obj === 'object' &&

            typeof obj.id === 'string' &&

            obj.is_public === true &&

            obj.is_trashed !== true &&

            obj.is_hidden !== true &&

            (
                obj.persona_type === 'vox' ||
                obj.is_voice_persona === true
            )
        );
    }

    /*
     * ============================================================
     * RECURSIVE SCAN
     * ============================================================
     */

    function scan(obj, source = 'api') {
        if (
            !monitoring ||
            !panelOpen ||
            !obj ||
            typeof obj !== 'object'
        ) {
            return;
        }

        if (
            isVoicePersona(obj)
        ) {
            addVoice(
                obj,
                source
            );
        }

        if (Array.isArray(obj)) {

            for (const item of obj) {
                scan(
                    item,
                    source
                );
            }

        } else {

            for (
                const value
                of Object.values(obj)
            ) {
                if (
                    value &&
                    typeof value === 'object'
                ) {
                    scan(
                        value,
                        source
                    );
                }
            }
        }
    }

    /*
     * ============================================================
     * ADD / MERGE VOICE
     * ============================================================
     */

    function addVoice(
        persona,
        source
    ) {
        const existing =
            found.get(persona.id);

        /*
         * Existing voice:
         * merge any additional endpoint/source info.
         */
        if (existing) {
            const oldSourceCount =
                existing.sources.size;

            let changed = false;

            existing.sources.add(
                source
            );

            if (
                existing.sources.size !==
                oldSourceCount
            ) {
                changed = true;
            }

            if (
                (
                    !existing.name ||
                    existing.name ===
                        'Unnamed voice'
                ) &&
                persona.name
            ) {
                existing.name =
                    persona.name;

                changed = true;
            }

            if (
                !existing.creator &&
                (
                    persona.user_handle ||
                    persona.user_display_name
                )
            ) {
                existing.creator =
                    persona.user_handle ||
                    persona.user_display_name;

                changed = true;
            }

            if (
                !existing.image &&
                (
                    persona.image_s3_id ||
                    persona.user_image_url
                )
            ) {
                existing.image =
                    persona.image_s3_id ||
                    persona.user_image_url;

                changed = true;
            }

            if (changed) {
                queueRender();
            }

            return;
        }

        /*
         * Hard limit for brand-new results.
         */
        if (
            found.size >= MAX_VOICES
        ) {
            return;
        }

        const voice = {
            id:
                persona.id,

            name:
                persona.name ||
                'Unnamed voice',

            creator:
                persona.user_handle ||
                persona.user_display_name ||
                '',

            image:
                persona.image_s3_id ||
                persona.user_image_url ||
                '',

            url:
                `https://suno.com/voice/${persona.id}`,

            sources:
                new Set([source])
        };

        found.set(
            persona.id,
            voice
        );

        console.log(
            '%c[Suno Voice Finder] 🎤 Found',
            'color:#b79cff;font-weight:bold',
            voice.name,
            voice.url,
            `via ${source}`
        );

        queueRender();
    }

    /*
     * ============================================================
     * BATCH UI RENDERING
     * ============================================================
     *
     * Multiple voices arriving together only cause one UI
     * refresh instead of rebuilding the entire panel repeatedly.
     */

    function queueRender() {
        if (renderQueued) {
            return;
        }

        renderQueued = true;

        setTimeout(
            () => {
                renderQueued = false;

                updateNavButton();

                if (panelOpen) {
                    renderPanel();
                }
            },
            100
        );
    }

    /*
     * ============================================================
     * SIDEBAR
     * ============================================================
     */

    function getHomeButton() {
        return (
            document.querySelector(
                'a[href="/discover"]'
            ) ||
            document.querySelector(
                'a[href="https://suno.com/discover"]'
            )
        );
    }

    function getSidebar() {
        const home =
            getHomeButton();

        if (!home) {
            return null;
        }

        return (
            home.closest(
                '[data-collapsed][data-show-content]'
            ) ||
            null
        );
    }

    function ensureNavButton() {
        const existing =
            document.getElementById(
                NAV_ID
            );

        if (existing) {
            updateNavButton();
            return existing;
        }

        const home =
            getHomeButton();

        if (!home) {
            return null;
        }

        const button =
            document.createElement(
                'button'
            );

        button.id =
            NAV_ID;

        button.type =
            'button';

        button.setAttribute(
            'tabindex',
            '0'
        );

        /*
         * Copy Suno's current Home styling.
         */
        button.className =
            home.className;

        button.style.position =
            'relative';

        button.innerHTML = `
            <span
                aria-hidden="true"
                class="hxc-btn-overlay-slot hxc-btn-border"
            ></span>

            <span
                class="hxc-btn-content"
                style="
                    width:100%;
                    justify-content:flex-start;
                "
            >

                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="1em"
                    height="1em"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    class="hxc-btn-icon"
                >
                    <path
                        d="
                            M12 14.5
                            a3.5 3.5 0 0 0 3.5-3.5
                            V6
                            a3.5 3.5 0 1 0-7 0
                            v5
                            a3.5 3.5 0 0 0 3.5 3.5
                            Z

                            M6.5 10.5
                            a1 1 0 0 1 2 0
                            V11
                            a3.5 3.5 0 0 0 7 0
                            v-.5
                            a1 1 0 1 1 2 0
                            V11
                            a5.5 5.5 0 0 1-4.5 5.405
                            V19
                            h2
                            a1 1 0 1 1 0 2
                            H9
                            a1 1 0 1 1 0-2
                            h2
                            v-2.595
                            A5.5 5.5 0 0 1 6.5 11
                            Z
                        "
                    ></path>
                </svg>

                <span
                    class="
                        overflow-hidden
                        whitespace-nowrap
                        transition-opacity
                        duration-200
                        group-data-[show-content=false]/sidebar:opacity-0
                    "
                >
                    Voice Finder
                </span>

                <span
                    id="suno-voice-nav-count"
                    class="
                        group-data-[show-content=false]/sidebar:hidden
                    "
                    style="
                        margin-left:auto;
                        min-width:22px;
                        height:20px;
                        padding:0 6px;
                        border-radius:999px;
                        display:inline-flex;
                        align-items:center;
                        justify-content:center;
                        background:rgba(255,255,255,.08);
                        font-size:11px;
                        font-weight:600;
                        line-height:1;
                    "
                >
                    0
                </span>

            </span>
        `;

        button.addEventListener(
            'click',
            event => {
                event.preventDefault();
                event.stopPropagation();

                if (panelOpen) {
                    closePanel();
                } else {
                    openPanel();
                }
            }
        );

        /*
         * Home
         * Voice Finder
         * Explore
         */
        home.insertAdjacentElement(
            'afterend',
            button
        );

        updateNavButton();

        return button;
    }

    function updateNavButton() {
        const button =
            document.getElementById(
                NAV_ID
            );

        if (!button) {
            return;
        }

        const count =
            button.querySelector(
                '#suno-voice-nav-count'
            );

        if (count) {
            count.textContent =
                String(found.size);
        }

        if (panelOpen) {

            button.setAttribute(
                'data-active',
                ''
            );

            button.removeAttribute(
                'data-inactive'
            );

            button.setAttribute(
                'aria-pressed',
                'true'
            );

        } else {

            button.removeAttribute(
                'data-active'
            );

            button.setAttribute(
                'data-inactive',
                ''
            );

            button.setAttribute(
                'aria-pressed',
                'false'
            );
        }
    }

    /*
     * ============================================================
     * LOW-COST SIDEBAR WATCHER
     * ============================================================
     *
     * No MutationObserver.
     *
     * We simply check every 2.5 seconds whether Suno rebuilt the
     * sidebar and removed our button.
     */

    function startSidebarWatcher() {
        function check() {
            if (
                !document.getElementById(
                    NAV_ID
                )
            ) {
                ensureNavButton();
            }
        }

        /*
         * Initial attempt.
         */
        check();

        setInterval(
            check,
            SIDEBAR_CHECK_INTERVAL
        );
    }

    /*
     * ============================================================
     * PANEL POSITION
     * ============================================================
     */

    function loadSavedPosition() {
        try {
            const value =
                JSON.parse(
                    localStorage.getItem(
                        POSITION_STORAGE_KEY
                    )
                );

            if (
                value &&
                Number.isFinite(value.x) &&
                Number.isFinite(value.y)
            ) {
                return value;
            }

        } catch {}

        return null;
    }

    function savePanelPosition(
        x,
        y
    ) {
        try {
            localStorage.setItem(
                POSITION_STORAGE_KEY,
                JSON.stringify({
                    x,
                    y
                })
            );
        } catch {}
    }

    function getPanelDimensions() {
        const sidebar =
            getSidebar();

        if (sidebar) {
            const rect =
                sidebar.getBoundingClientRect();

            return {
                width:
                    Math.max(
                        260,
                        Math.round(
                            rect.width
                        )
                    ),

                height:
                    Math.max(
                        300,
                        Math.min(
                            window.innerHeight - 16,
                            Math.round(
                                rect.height
                            ) - 16
                        )
                    )
            };
        }

        return {
            width:
                280,

            height:
                Math.max(
                    300,
                    window.innerHeight - 16
                )
        };
    }

    function clampPosition(
        width,
        height,
        x,
        y
    ) {
        const maxX =
            Math.max(
                0,
                window.innerWidth - width
            );

        const maxY =
            Math.max(
                0,
                window.innerHeight - height
            );

        return {
            x:
                Math.max(
                    0,
                    Math.min(
                        x,
                        maxX
                    )
                ),

            y:
                Math.max(
                    0,
                    Math.min(
                        y,
                        maxY
                    )
                )
        };
    }

    function getDefaultPanelPosition(
        width,
        height
    ) {
        const sidebar =
            getSidebar();

        let x = 8;
        let y = 8;

        if (sidebar) {
            const rect =
                sidebar.getBoundingClientRect();

            x =
                rect.right + 8;

            y =
                Math.max(
                    8,
                    rect.top + 8
                );
        }

        return clampPosition(
            width,
            height,
            x,
            y
        );
    }

    /*
     * ============================================================
     * PANEL ELEMENT
     * ============================================================
     */

    function getPanel() {
        let panel =
            document.getElementById(
                PANEL_ID
            );

        if (!panel) {
            panel =
                document.createElement(
                    'div'
                );

            panel.id =
                PANEL_ID;

            Object.assign(
                panel.style,
                {
                    position:
                        'fixed',

                    display:
                        'none',

                    zIndex:
                        '2147483647',

                    overflow:
                        'hidden',

                    background:
                        'var(--color-background-primary, #111)',

                    color:
                        'var(--color-foreground-primary, #fff)',

                    border:
                        '1px solid var(--color-border-secondary, #333)',

                    borderRadius:
                        '12px',

                    boxShadow:
                        '0 8px 35px rgba(0,0,0,.45)',

                    font:
                        'inherit'
                }
            );

            document.documentElement
                .appendChild(
                    panel
                );
        }

        return panel;
    }

    function positionPanel() {
        const panel =
            getPanel();

        const dimensions =
            getPanelDimensions();

        panel.style.width =
            `${dimensions.width}px`;

        panel.style.height =
            `${dimensions.height}px`;

        let position =
            loadSavedPosition();

        if (position) {

            position =
                clampPosition(
                    dimensions.width,
                    dimensions.height,
                    position.x,
                    position.y
                );

        } else {

            position =
                getDefaultPanelPosition(
                    dimensions.width,
                    dimensions.height
                );
        }

        panel.style.left =
            `${position.x}px`;

        panel.style.top =
            `${position.y}px`;

        panel.style.right =
            'auto';

        panel.style.bottom =
            'auto';
    }

    /*
     * ============================================================
     * OPEN / CLOSE
     * ============================================================
     */

    function openPanel() {
        panelOpen = true;

        /*
         * API monitoring starts ONLY here.
         */
        monitoring = true;

        positionPanel();

        const panel =
            getPanel();

        panel.style.display =
            'flex';

        renderPanel();
        updateNavButton();

        console.log(
            '[Suno Voice Finder] Monitoring ON'
        );
    }

    function closePanel() {
        const panel =
            getPanel();

        const rect =
            panel.getBoundingClientRect();

        if (
            Number.isFinite(rect.left) &&
            Number.isFinite(rect.top)
        ) {
            savePanelPosition(
                rect.left,
                rect.top
            );
        }

        /*
         * Important:
         * shut monitoring down immediately.
         */
        monitoring = false;
        panelOpen = false;
        stopAutoScroll();
        cancelManualSearch();
        cancelDiscoverSearch();
        pendingGenreSearch = false;

        panel.style.display =
            'none';

        updateNavButton();

        console.log(
            '[Suno Voice Finder] Monitoring OFF'
        );
    }

    /*
     * ============================================================
     * DRAGGING
     * ============================================================
     */

    function makePanelDraggable(
        panel,
        handle
    ) {
        let dragging = false;

        let startPointerX = 0;
        let startPointerY = 0;

        let startX = 0;
        let startY = 0;

        handle.style.touchAction =
            'none';

        handle.addEventListener(
            'pointerdown',
            event => {

                if (
                    event.pointerType === 'mouse' &&
                    event.button !== 0
                ) {
                    return;
                }

                if (
                    event.target.closest(
                        'button, a'
                    )
                ) {
                    return;
                }

                dragging = true;

                startPointerX =
                    event.clientX;

                startPointerY =
                    event.clientY;

                const rect =
                    panel.getBoundingClientRect();

                startX =
                    rect.left;

                startY =
                    rect.top;

                try {
                    handle.setPointerCapture(
                        event.pointerId
                    );
                } catch {}
            }
        );

        handle.addEventListener(
            'pointermove',
            event => {
                if (!dragging) {
                    return;
                }

                const dimensions =
                    getPanelDimensions();

                const x =
                    startX +
                    (
                        event.clientX -
                        startPointerX
                    );

                const y =
                    startY +
                    (
                        event.clientY -
                        startPointerY
                    );

                const position =
                    clampPosition(
                        dimensions.width,
                        dimensions.height,
                        x,
                        y
                    );

                panel.style.left =
                    `${position.x}px`;

                panel.style.top =
                    `${position.y}px`;
            }
        );

        function finish(event) {
            if (!dragging) {
                return;
            }

            dragging = false;

            try {
                handle.releasePointerCapture(
                    event.pointerId
                );
            } catch {}

            const rect =
                panel.getBoundingClientRect();

            savePanelPosition(
                rect.left,
                rect.top
            );
        }

        handle.addEventListener(
            'pointerup',
            finish
        );

        handle.addEventListener(
            'pointercancel',
            finish
        );
    }

    /*
     * ============================================================
     * HTML HELPERS
     * ============================================================
     */

    function escapeHTML(value) {
        return String(
            value ?? ''
        )
            .replaceAll(
                '&',
                '&amp;'
            )
            .replaceAll(
                '<',
                '&lt;'
            )
            .replaceAll(
                '>',
                '&gt;'
            )
            .replaceAll(
                '"',
                '&quot;'
            )
            .replaceAll(
                "'",
                '&#039;'
            );
    }

    /*
     * ============================================================
     * VOICE CARD
     * ============================================================
     */

    function renderVoice(voice) {
        const sourceCount =
            voice.sources.size;

        const sourceTitle =
            [...voice.sources]
                .join('\n');

        const sourceLabel =
            sourceCount === 1
                ? '1 endpoint'
                : `${sourceCount} endpoints`;

        const image =
            voice.image
                ? `
                    <img
                        src="${escapeHTML(
                            voice.image
                        )}"
                        style="
                            width:40px;
                            height:40px;
                            border-radius:50%;
                            object-fit:cover;
                            flex-shrink:0;
                            background:#222;
                        "
                    >
                `
                : `
                    <div
                        style="
                            width:40px;
                            height:40px;
                            border-radius:50%;
                            display:flex;
                            align-items:center;
                            justify-content:center;
                            flex-shrink:0;
                            background:rgba(255,255,255,.06);
                        "
                    >
                        🎤
                    </div>
                `;

        return `
            <div
                style="
                    padding:11px 12px;
                    border-top:
                        1px solid
                        var(--color-border-secondary, #333);
                "
            >
                <div
                    style="
                        display:flex;
                        gap:10px;
                        align-items:flex-start;
                    "
                >

                    ${image}

                    <div
                        style="
                            flex:1;
                            min-width:0;
                        "
                    >

                        <div
                            title="${escapeHTML(
                                voice.name
                            )}"
                            style="
                                font-size:13px;
                                font-weight:600;
                                white-space:nowrap;
                                overflow:hidden;
                                text-overflow:ellipsis;
                            "
                        >
                            ${escapeHTML(
                                voice.name
                            )}
                        </div>

                        ${
                            voice.creator
                                ? `
                                    <div
                                        style="
                                            margin-top:2px;
                                            opacity:.65;
                                            font-size:11px;
                                        "
                                    >
                                        @${escapeHTML(
                                            voice.creator
                                        )}
                                    </div>
                                `
                                : ''
                        }

                        <div
                            title="${escapeHTML(
                                sourceTitle
                            )}"
                            style="
                                margin-top:3px;
                                opacity:.45;
                                font-size:10px;
                            "
                        >
                            Found via
                            ${escapeHTML(
                                sourceLabel
                            )}
                        </div>

                        <div
                            style="
                                display:flex;
                                flex-wrap:wrap;
                                gap:6px;
                                margin-top:7px;
                            "
                        >

                            <a
                                href="${escapeHTML(
                                    voice.url
                                )}"
                                target="_blank"
                                rel="noopener noreferrer"
                                style="
                                    padding:5px 8px;
                                    border-radius:6px;
                                    background:#7c4dff;
                                    color:white;
                                    font-size:11px;
                                    font-weight:600;
                                    text-decoration:none;
                                "
                            >
                                Open Voice
                            </a>

                            <button
                                class="suno-copy-voice"
                                data-url="${escapeHTML(
                                    voice.url
                                )}"
                                style="
                                    padding:5px 8px;
                                    border-radius:6px;
                                    border:
                                        1px solid
                                        var(--color-border-secondary, #444);
                                    background:
                                        rgba(255,255,255,.04);
                                    color:inherit;
                                    cursor:pointer;
                                    font-size:11px;
                                "
                            >
                                Copy URL
                            </button>

                        </div>

                    </div>

                </div>
            </div>
        `;
    }

    /*
     * ============================================================
     * AUTO SCROLL
     * ============================================================
     */

    function findScrollTarget() {
        const page = document.scrollingElement || document.documentElement;

        if (page && page.scrollHeight > page.clientHeight + 100) {
            return page;
        }

        // Find Suno's internal scroller only when enabling or replacing
        // a target. Never select our voice list or Suno's sidebar.
        const sidebar = getSidebar();
        let best = null;
        let bestScrollableHeight = 0;

        for (const element of document.querySelectorAll('main, [role="main"], div')) {
            if (
                element.closest(`#${PANEL_ID}, #${NAV_ID}, nav, [role="navigation"]`) ||
                sidebar?.contains(element) ||
                element.clientHeight === 0 ||
                element.clientWidth === 0
            ) {
                continue;
            }

            const scrollableHeight = element.scrollHeight - element.clientHeight;
            if (scrollableHeight <= 100 || scrollableHeight <= bestScrollableHeight) {
                continue;
            }

            const style = getComputedStyle(element);
            if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') {
                continue;
            }

            const rect = element.getBoundingClientRect();
            if (rect.bottom <= 0 || rect.top >= window.innerHeight ||
                rect.right <= 0 || rect.left >= window.innerWidth) {
                continue;
            }

            best = element;
            bestScrollableHeight = scrollableHeight;
        }

        return best;
    }

    function performAutoScroll() {
        if (!autoScrollEnabled || !panelOpen || document.hidden) {
            return;
        }

        if (!autoScrollTarget || !document.contains(autoScrollTarget)) {
            autoScrollTarget = findScrollTarget();
        }

        if (!autoScrollTarget) {
            return;
        }

        // Read the current height on every tick so newly loaded results
        // are included. Jump directly to the bottom to trigger more loading.
        const bottom = Math.max(
            0,
            autoScrollTarget.scrollHeight - autoScrollTarget.clientHeight
        );
        const isPage = autoScrollTarget === document.scrollingElement ||
            autoScrollTarget === document.documentElement ||
            autoScrollTarget === document.body;

        try {
            (isPage ? window : autoScrollTarget).scrollTo({
                top: bottom,
                left: autoScrollTarget.scrollLeft,
                behavior: 'instant'
            });
        } catch {
            autoScrollTarget.scrollTop = bottom;
        }
    }

    function startAutoScroll() {
        if (!panelOpen || autoScrollTimer !== null) {
            return;
        }

        autoScrollEnabled = true;
        autoScrollTarget = findScrollTarget();
        autoScrollTimer = setInterval(performAutoScroll, AUTO_SCROLL_INTERVAL);
    }

    function stopAutoScroll() {
        autoScrollEnabled = false;
        if (autoScrollTimer !== null) {
            clearInterval(autoScrollTimer);
            autoScrollTimer = null;
        }
        autoScrollTarget = null;
    }

    function toggleAutoScroll() {
        if (autoScrollEnabled) {
            stopAutoScroll();
        } else {
            startAutoScroll();
        }
        renderPanel();
    }

    /* Manual searches reuse successful Suno API requests observed in this
     * tab. Authorization stays in memory and on the same Suno API origin. */
    function genrePageUrl(term) {
        const origin = new URL(window.location.href).origin;
        const base = origin === 'https://www.suno.com' ? origin : 'https://suno.com';
        return `${base}/genre/${encodeURIComponent(term.trim())}`;
    }

    function currentSearchTerm() {
        return activeTab === 'voice' ? searchTerm : discoverSearchTerm;
    }

    function setCurrentSearchStatus(message) {
        if (activeTab === 'voice') searchStatus = message;
        else discoverSearchStatus = message;
    }

    function openGenreForSearch() {
        if (genreNavigationStarted) {
            setCurrentSearchStatus('Waiting for Suno to finish loading this genre. Try again when it is ready.');
            updateSearchControls();
            return;
        }
        const term = currentSearchTerm().trim();
        const url = genrePageUrl(term);
        try {
            // Only public result data crosses navigation; never store authorization headers.
            sessionStorage.setItem(GENRE_HANDOFF_KEY, JSON.stringify({
                expires: Date.now() + 120000,
                url, term,
                activeTab,
                rank: activeTab === 'voice' ? searchRank : discoverSearchRank,
                voiceTerm: searchTerm,
                voiceRank: searchRank,
                voiceLanguages: [...filtersByTab.voice.languages],
                voiceModels: [...filtersByTab.voice.model_versions],
                discoverTerm: discoverSearchTerm,
                discoverRank: discoverSearchRank,
                discoverLanguages: [...filtersByTab.discover.languages],
                discoverModels: [...filtersByTab.discover.model_versions],
                discoverRemixFilter,
                voices: [...found.values()].map(voice => ({
                    id: voice.id, name: voice.name, creator: voice.creator,
                    image: voice.image, sources: [...voice.sources]
                })),
                songs: [...discoveredSongs.values()]
            }));
            genreNavigationStarted = true;
            setCurrentSearchStatus('Opening genre…');
            stopAutoScroll();
            updateSearchControls();
            window.location.assign(url);
        } catch {
            genreNavigationStarted = false;
            try { sessionStorage.removeItem(GENRE_HANDOFF_KEY); } catch {}
            setCurrentSearchStatus('Could not open the genre while preserving results. Allow tab storage, then try again.');
            updateSearchControls();
        }
    }

    function restoreGenreHandoff() {
        try {
            const value = JSON.parse(sessionStorage.getItem(GENRE_HANDOFF_KEY));
            if (!value) return;
            sessionStorage.removeItem(GENRE_HANDOFF_KEY);
            const current = new URL(window.location.href);
            const target = new URL(value.url);
            if (!['https://suno.com', 'https://www.suno.com'].includes(target.origin) ||
                current.origin !== target.origin ||
                current.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '') ||
                !Number.isFinite(value.expires) || value.expires <= Date.now() ||
                typeof value.term !== 'string' || !value.term.trim()) return;
            activeTab = value.activeTab === 'discover' ? 'discover' : 'voice';
            searchTerm = typeof value.voiceTerm === 'string' ? value.voiceTerm : (activeTab === 'voice' ? value.term : '');
            searchRank = validRank(value.voiceRank || (activeTab === 'voice' && value.rank));
            discoverSearchTerm = typeof value.discoverTerm === 'string' ? value.discoverTerm : (activeTab === 'discover' ? value.term : '');
            discoverSearchRank = validRank(value.discoverRank || (activeTab === 'discover' && value.rank));
            filtersByTab.voice.languages = validatedSelections(value.voiceLanguages, LANGUAGE_OPTIONS);
            filtersByTab.voice.model_versions = validatedSelections(value.voiceModels, MODEL_OPTIONS);
            filtersByTab.discover.languages = validatedSelections(value.discoverLanguages, LANGUAGE_OPTIONS);
            filtersByTab.discover.model_versions = validatedSelections(value.discoverModels, MODEL_OPTIONS);
            discoverRemixFilter = ['all', 'enabled', 'disabled', 'unknown'].includes(value.discoverRemixFilter)
                ? value.discoverRemixFilter : 'all';
            for (const voice of (Array.isArray(value.voices) ? value.voices : []).slice(0, MAX_VOICES)) {
                if (!voice || typeof voice.id !== 'string') continue;
                found.set(voice.id, {
                    id: voice.id,
                    name: typeof voice.name === 'string' ? voice.name : 'Unnamed voice',
                    creator: typeof voice.creator === 'string' ? voice.creator : '',
                    image: typeof voice.image === 'string' ? voice.image : '',
                    url: `https://suno.com/voice/${voice.id}`,
                    sources: new Set((Array.isArray(voice.sources) ? voice.sources : []).filter(s => typeof s === 'string'))
                });
            }
            for (const song of (Array.isArray(value.songs) ? value.songs : []).slice(0, MAX_DISCOVER_SONGS)) {
                if (!song || typeof song.id !== 'string' || !SONG_ID_PATTERN.test(song.id)) continue;
                discoveredSongs.set(song.id, {
                    ...song, url: `https://suno.com/song/${song.id}`,
                    remixStatus: ['enabled', 'disabled', 'unknown'].includes(song.remixStatus) ? song.remixStatus : 'unknown',
                    remixEvidence: typeof song.remixEvidence === 'string' ? song.remixEvidence : ''
                });
            }
            genreNavigationStarted = true;
            pendingGenreSearch = true;
            panelOpen = true;
            monitoring = true;
            setCurrentSearchStatus('Loading genre…');
        } catch {}
    }

    function validRank(rank) {
        return SEARCH_SORTS.some(([value]) => value === rank) ? rank : 'most_relevant';
    }

    function isStudioApiUrl(url) {
        try {
            const parsed = new URL(String(url), window.location.href);
            return parsed.origin === 'https://studio-api-prod.suno.com' && parsed.pathname.startsWith('/api/');
        } catch { return false; }
    }

    function captureTemplate(url, method, headers, credentials) {
        if (!isStudioApiUrl(url)) return null;
        if (isSearchUrl(url) && String(method).toUpperCase() === 'POST') {
            return { ...requestTemplate(headers, credentials), fromSearch: true };
        }
        // Genre pages may load feeds instead of /search/. Reuse only the
        // authorization header, and only against this same Suno API origin.
        const copy = new w.Headers(headers);
        if (!copy.has('authorization') || searchTemplate) return null;
        return requestTemplate({ authorization: copy.get('authorization') }, credentials);
    }

    function csvCell(value) {
        let text = String(value ?? '');
        // Prevent untrusted song titles, tags and creator names becoming spreadsheet formulas.
        if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
    }

    function downloadCSV(rows, filename) {
        const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
        const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.documentElement.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }

    function exportVoices() {
        if (!found.size) return;
        const rows = [['Voice ID', 'Name', 'Creator', 'Voice URL', 'Image URL', 'Sources']];
        for (const voice of found.values()) {
            rows.push([voice.id, voice.name, voice.creator, voice.url, voice.image, [...voice.sources].join('; ')]);
        }
        downloadCSV(rows, `Suno-Voices-${new Date().toISOString().slice(0, 10)}.csv`);
    }

    function getDiscoverVisibleSongs() {
        const songs = [...discoveredSongs.values()];
        return discoverRemixFilter === 'all' ? songs :
            songs.filter(song => song.remixStatus === discoverRemixFilter);
    }

    function countDiscoverRemixStatuses() {
        const counts = { enabled: 0, disabled: 0, unknown: 0 };
        for (const song of discoveredSongs.values()) {
            counts[['enabled', 'disabled', 'unknown'].includes(song.remixStatus)
                ? song.remixStatus : 'unknown']++;
        }
        return counts;
    }

    function exportDiscoverSongs() {
        // Export the whole selected subset, NOT only the first 100 rendered cards.
        const songs = getDiscoverVisibleSongs();
        if (!songs.length) return;
        const rows = [[
            'Song ID', 'Title', 'Creator', 'Creator Handle', 'Song URL', 'Image URL',
            'Plays', 'Likes', 'Created At', 'Tags', 'Remix Permission',
            'Permission Evidence', 'Search Term', 'Search Sort'
        ]];
        for (const song of songs) {
            rows.push([
                song.id, song.title, song.creator, song.handle, song.url, song.image,
                song.plays, song.likes, song.created, song.tags,
                song.remixStatus === 'enabled' ? 'Enabled' :
                    song.remixStatus === 'disabled' ? 'Disabled' : 'Unknown',
                song.remixEvidence || '', song.term, song.rank
            ]);
        }
        const suffix = discoverRemixFilter === 'all' ? '' : `-${discoverRemixFilter}`;
        downloadCSV(rows, `Suno-Discover-Songs${suffix}-${new Date().toISOString().slice(0, 10)}.csv`);
    }

    // The /api/search/ response can return songs directly or nested in content_item.
    // Require a real song UUID, title and song-shaped fields; never interpret persona IDs as songs.
    function isPublicSong(obj) {
        return !!(obj && !Array.isArray(obj) && typeof obj === 'object' &&
            typeof obj.id === 'string' && SONG_ID_PATTERN.test(obj.id) &&
            typeof obj.title === 'string' && obj.title.trim() &&
            obj.is_public === true && obj.is_hidden !== true && obj.is_trashed !== true &&
            (obj.entity_type === 'song_schema' || obj.content_type === 'clip' ||
                typeof obj.audio_url === 'string' || Array.isArray(obj.media_urls) ||
                typeof obj.video_url === 'string' || (obj.metadata && typeof obj.metadata === 'object')));
    }

    /*
     * This marks in-Suno remix availability; it is not a general license
     * to sample/download/redistribute a creator's audio outside Suno.
     * Never interpret metadata.is_remix ("this song is a remix") as permission.
     */
    function songRemixPermission(clip) {
        const declared = clip.metadata?.can_remix;
        if (declared === true) return { status: 'enabled', evidence: 'metadata.can_remix' };
        if (declared === false) return { status: 'disabled', evidence: 'metadata.can_remix' };
        if (clip.can_remix === true) return { status: 'enabled', evidence: 'can_remix' };
        if (clip.can_remix === false) return { status: 'disabled', evidence: 'can_remix' };

        // If the explicit metadata flag is missing, native action availability
        // can be a useful fallback. Do not guess based on "is_remix" or publicity.
        const remixActions = Array.isArray(clip.action_config?.actions)
            ? clip.action_config.actions.filter(action =>
                ['remix_cover', 'remix_extend', 'remix_reuse_style'].includes(action?.action_type))
            : [];
        if (remixActions.some(action => action.visible === true && action.disabled === false)) {
            return { status: 'enabled', evidence: 'remix action available' };
        }
        if (remixActions.length && remixActions.every(action =>
            action.disabled === true || action.visible === false)) {
            return { status: 'disabled', evidence: 'remix actions unavailable' };
        }
        return { status: 'unknown', evidence: 'not provided by search response' };
    }

    function songFromClip(clip, term, rank) {
        const remix = songRemixPermission(clip);
        return {
            id: clip.id,
            title: clip.title.trim(),
            creator: clip.display_name || clip.user_display_name || clip.handle || '',
            handle: clip.handle || clip.user_handle || '',
            url: `https://suno.com/song/${clip.id}`,
            image: clip.image_url || clip.image_large_url || '',
            plays: Number.isFinite(clip.play_count) ? clip.play_count : '',
            likes: Number.isFinite(clip.upvote_count) ? clip.upvote_count : '',
            created: clip.created_at || '',
            tags: typeof clip.display_tags === 'string' ? clip.display_tags :
                typeof clip.metadata?.tags === 'string' ? clip.metadata.tags.slice(0, 500) : '',
            term, rank,
            remixStatus: remix.status,
            remixEvidence: remix.evidence
        };
    }

    function renderDiscoverSong(song) {
        const image = song.image
            ? `<img src="${escapeHTML(song.image)}" loading="lazy" style="width:38px;height:38px;border-radius:6px;object-fit:cover;flex-shrink:0;" alt="">`
            : '<span style="width:38px;height:38px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">🎵</span>';
        const creator = song.handle ? `@${song.handle}` : song.creator;
        const titleCharacters = Array.from(song.title);
        const visibleTitle = titleCharacters.length > 34
            ? titleCharacters.slice(0, 33).join('').trimEnd() + '…' : song.title;
        const remix = song.remixStatus === 'enabled'
            ? { label: '● Remix ON', color: '#8ae6a2', bg: 'rgba(70,211,105,.13)' }
            : song.remixStatus === 'disabled'
                ? { label: '🔒 Remix OFF', color: '#e6b0a8', bg: 'rgba(220,110,90,.10)' }
                : { label: '◌ Unknown', color: '#bbbbbb', bg: 'rgba(255,255,255,.06)' };
        return `<div style="padding:8px 9px;border-top:1px solid var(--color-border-secondary,#333);display:flex;gap:8px;align-items:flex-start;">
            ${image}<div style="min-width:0;flex:1;">
            <div style="display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;">
                <span title="${escapeHTML(song.title)}" style="flex:1;min-width:0;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help;">${escapeHTML(visibleTitle)}</span>
                <span title="${escapeHTML((song.remixEvidence || 'Not reported') + ' · Suno in-app remix availability only; not a general audio reuse license')}"
                    style="flex-shrink:0;white-space:nowrap;padding:2px 4px;border-radius:5px;background:${remix.bg};color:${remix.color};font-size:9px;font-weight:600;line-height:1.25;">${remix.label}</span>
            </div>
            <div style="font-size:10px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHTML(creator)}">${escapeHTML(creator)}</div>
            <div style="font-size:9px;opacity:.55;margin:2px 0;">${escapeHTML(song.plays)} plays${song.likes !== '' ? ` · ${escapeHTML(song.likes)} likes` : ''}</div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:5px;">
            <a href="${escapeHTML(song.url)}" target="_blank" rel="noopener noreferrer" style="padding:4px 7px;border-radius:6px;background:#7c4dff;color:white;font-size:10px;font-weight:600;text-decoration:none;">Open Song</a>
            <button type="button" class="suno-copy-url" data-url="${escapeHTML(song.url)}" style="padding:4px 7px;border-radius:6px;border:1px solid var(--color-border-secondary,#444);background:rgba(255,255,255,.04);color:inherit;cursor:pointer;font-size:10px;">Copy URL</button>
            </div></div></div>`;
    }

    function isSearchUrl(url) {
        try {
            const parsed = new URL(String(url), window.location.href);
            return parsed.origin === 'https://studio-api-prod.suno.com' &&
                parsed.pathname === '/api/search/';
        } catch {
            return false;
        }
    }

    function requestTemplate(headers, credentials) {
        const copy = new w.Headers(headers);
        for (const name of [...copy.keys()]) {
            if (/^(cookie|host|origin|referer|content-length|connection|baggage|traceparent|tracestate|sentry-trace)$/i.test(name) ||
                /^(sec-|proxy-)/i.test(name)) {
                copy.delete(name);
            }
        }
        copy.set('content-type', 'application/json');
        return { headers: copy, credentials };
    }

    function rememberSearch(template) {
        if (!panelOpen || !template) return;
        if (!searchTemplate || template.fromSearch) searchTemplate = template;
        if (!searchController && !discoverController) setCurrentSearchStatus('');
        updateSearchControls();
        if (pendingGenreSearch) {
            setTimeout(() => {
                if (pendingGenreSearch && panelOpen && searchTemplate && !searchController && !discoverController) {
                    pendingGenreSearch = false;
                    if (activeTab === 'discover') runDiscoverSearch();
                    else runManualSearch();
                }
            }, 0);
        }
    }

    function updateSearchControls() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel || !panelOpen) return;
        const discover = activeTab === 'discover';
        const busy = searchController !== null || discoverController !== null;
        const term = discover ? discoverSearchTerm : searchTerm;
        const button = panel.querySelector('#suno-search-submit');
        if (button) {
            button.disabled = busy || !term.trim();
            button.textContent = busy ? 'Searching…' : (discover ? 'Load songs' : 'Load voices');
            button.style.opacity = button.disabled ? '.5' : '1';
        }
        for (const id of ['suno-search-term', 'suno-search-sort', 'suno-voice-clear']) {
            const element = panel.querySelector(`#${id}`);
            if (element) element.disabled = busy;
        }
        panel.querySelectorAll('.suno-filter-checkbox, .suno-filter-clear').forEach(el => {
            el.disabled = busy;
        });
        updateFilterSummaries(panel);
        const exportButton = panel.querySelector('#suno-voice-export');
        if (exportButton) {
            exportButton.disabled = discover ? getDiscoverVisibleSongs().length === 0 : found.size === 0;
            exportButton.style.opacity = exportButton.disabled ? '.4' : '1';
            exportButton.title = discover
                ? (discoverRemixFilter === 'all' ? 'Export all collected songs as CSV'
                    : `Export all ${discoverRemixFilter} songs as CSV (across all pages)`)
                : 'Export voices as CSV';
            exportButton.setAttribute('aria-label', exportButton.title);
        }
        const status = panel.querySelector('#suno-search-status');
        if (status) {
            status.textContent = (discover ? discoverSearchStatus : searchStatus) || (searchTemplate
                ? (discover ? 'Ready · up to 1,000 songs per search · CSV exports all.'
                    : 'Ready · up to 1,000 songs · extracts public voices.')
                : 'First search opens genre page; later searches stay here.');
            status.title = status.textContent;
        }
    }

    function cancelManualSearch() {
        if (!searchController) return;
        searchController.abort();
        searchController = null;
        searchStatus = 'Search canceled.';
    }

    function cancelDiscoverSearch() {
        if (!discoverController) return;
        discoverController.abort();
        discoverController = null;
        discoverSearchStatus = 'Search canceled.';
    }

    async function runManualSearch() {
        if (!panelOpen || searchController || discoverController || !searchTerm.trim()) return;
        if (!searchTemplate) {
            openGenreForSearch();
            return;
        }
        pendingGenreSearch = false;

        const term = searchTerm.trim();
        const rank = SEARCH_SORTS.some(([value]) => value === searchRank)
            ? searchRank : 'most_relevant';
        const template = searchTemplate;
        const controller = new w.AbortController();
        searchController = controller;
        searchStatus = 'Searching…';
        // Manual loading and auto scrolling should not produce overlapping work.
        stopAutoScroll();
        renderPanel();
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, 45000);

        try {
            const response = await originalFetch.call(w, SEARCH_URL, {
                method: 'POST',
                headers: new w.Headers(template.headers),
                credentials: template.credentials,
                mode: 'cors',
                redirect: 'error',
                signal: controller.signal,
                body: JSON.stringify({ search_queries: [{
                    name: 'tag_song',
                    search_type: 'tag_song',
                    term,
                    from_index: 0,
                    size: SEARCH_SIZE,
                    rank_by: rank,
                    is_public: true,
                    ...searchFiltersForTab('voice')
                }] })
            });

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    if (searchTemplate === template) searchTemplate = null;
                    throw new Error('Search was not authorized. Use Suno with Finder open to refresh your session, then try again.');
                }
                if (response.status === 429) {
                    throw new Error('Suno asked us to slow down. Wait before trying again; no retry was sent.');
                }
                throw new Error(`Search failed (HTTP ${response.status}). No retry was sent.`);
            }

            const contentType = response.headers.get('content-type') || '';
            if (!/application\/json|\+json/i.test(contentType)) {
                throw new Error('Suno returned an unexpected response. Let Suno finish loading, then try again.');
            }
            const data = await response.json();
            if (controller.signal.aborted || !panelOpen || searchController !== controller) return;

            const ids = new Set();
            let added = 0;
            let inspected = 0;
            const stack = [data];
            // Yield between chunks so a large response does not block Close.
            while (stack.length) {
                if (controller.signal.aborted || !panelOpen || searchController !== controller) return;
                const item = stack.pop();
                if (!item || typeof item !== 'object') continue;
                if (isVoicePersona(item) && !ids.has(item.id)) {
                    ids.add(item.id);
                    const existed = found.has(item.id);
                    addVoice(item, 'search');
                    if (!existed && found.has(item.id)) added++;
                }
                for (const value of Object.values(item)) {
                    if (value && typeof value === 'object') stack.push(value);
                }
                if (++inspected % 500 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            searchStatus = `${ids.size} public voices in response · ${added} new.`;
            if (found.size >= MAX_VOICES) {
                searchStatus += ` List limit: ${MAX_VOICES}. Clear results to collect more.`;
            }
        } catch (error) {
            if (searchController !== controller) return;
            searchStatus = timedOut ? 'Search timed out. No retry was sent.'
                : controller.signal.aborted ? 'Search canceled.'
                : error instanceof SyntaxError ? 'Suno returned invalid JSON. No retry was sent.'
                : error.message || 'Search failed. No retry was sent.';
        } finally {
            clearTimeout(timeout);
            if (searchController === controller) {
                searchController = null;
                updateSearchControls();
            }
        }
    }

    async function runDiscoverSearch() {
        if (!panelOpen || discoverController || searchController || !discoverSearchTerm.trim()) return;
        if (!searchTemplate) {
            openGenreForSearch();
            return;
        }
        pendingGenreSearch = false;
        const term = discoverSearchTerm.trim();
        const rank = validRank(discoverSearchRank);
        const template = searchTemplate;
        const controller = new w.AbortController();
        discoverController = controller;
        discoverSearchStatus = 'Searching up to 1,000 songs…';
        stopAutoScroll();
        renderPanel();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
        try {
            // Exactly one request, using the working Voice search's payload and captured same-origin authorization.
            const response = await originalFetch.call(w, SEARCH_URL, {
                method: 'POST',
                headers: new w.Headers(template.headers),
                credentials: template.credentials,
                mode: 'cors',
                redirect: 'error',
                signal: controller.signal,
                body: JSON.stringify({ search_queries: [{
                    name: 'tag_song', search_type: 'tag_song', term,
                    from_index: 0, size: SEARCH_SIZE, rank_by: rank, is_public: true,
                    ...searchFiltersForTab('discover')
                }] })
            });
            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    if (searchTemplate === template) searchTemplate = null;
                    throw new Error('Search was not authorized. Use Suno with Finder open to refresh the session, then try again.');
                }
                if (response.status === 429) throw new Error('Suno asked us to slow down. No retry was sent.');
                throw new Error(`Search failed (HTTP ${response.status}). No retry was sent.`);
            }
            if (!/application\/json|\+json/i.test(response.headers.get('content-type') || '')) {
                throw new Error('Suno returned a non-JSON response. No retry was sent.');
            }
            const data = await response.json();
            if (controller.signal.aborted || !panelOpen || discoverController !== controller) return;
            const seen = new Set();
            const stack = [data];
            let scanned = 0;
            let added = 0;
            // Keep only compact song metadata, not full prompts, lyrics or the 1,000-song response.
            while (stack.length) {
                if (controller.signal.aborted || !panelOpen || discoverController !== controller) return;
                const item = stack.pop();
                if (!item || typeof item !== 'object') continue;
                if (isPublicSong(item) && !seen.has(item.id)) {
                    seen.add(item.id);
                    const existed = discoveredSongs.has(item.id);
                    if (existed || discoveredSongs.size < MAX_DISCOVER_SONGS) {
                        const song = songFromClip(item, term, rank);
                        if (existed && song.remixStatus === 'unknown') {
                            const previous = discoveredSongs.get(item.id);
                            if (previous?.remixStatus && previous.remixStatus !== 'unknown') {
                                song.remixStatus = previous.remixStatus;
                                song.remixEvidence = previous.remixEvidence;
                            }
                        }
                        discoveredSongs.set(item.id, song);
                        if (!existed) added++;
                    }
                }
                if (Array.isArray(item)) {
                    for (const value of item) if (value && typeof value === 'object') stack.push(value);
                } else {
                    for (const value of Object.values(item)) {
                        if (value && typeof value === 'object') stack.push(value);
                    }
                }
                if (++scanned % 500 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
            const remixCounts = countDiscoverRemixStatuses();
            discoverSearchStatus = `${seen.size} public songs in response · ${added} new · ${discoveredSongs.size} collected · ${remixCounts.enabled} remix ON.`;
            if (remixCounts.unknown) discoverSearchStatus += ` ${remixCounts.unknown} unknown (no conclusive remix field).`;
            if (discoveredSongs.size >= MAX_DISCOVER_SONGS) {
                discoverSearchStatus += ` Collection limit: ${MAX_DISCOVER_SONGS}. Export and clear to collect more.`;
            }
        } catch (error) {
            if (discoverController !== controller) return;
            discoverSearchStatus = timedOut ? 'Search timed out. No retry was sent.'
                : controller.signal.aborted ? 'Search canceled.'
                : error instanceof SyntaxError ? 'Suno returned invalid JSON. No retry was sent.'
                : error.message || 'Search failed. No retry was sent.';
        } finally {
            clearTimeout(timeout);
            if (discoverController === controller) {
                discoverController = null;
                renderPanel();
            }
        }
    }


    /*
     * ============================================================
     * PANEL RENDER
     * ============================================================
     */

    function renderPanel() {
        if (!panelOpen) {
            return;
        }

        const panel =
            getPanel();

        const voices = [...found.values()];
        const discover = activeTab === 'discover';
        const songs = discover ? getDiscoverVisibleSongs() : [];
        const remixCounts = discover ? countDiscoverRemixStatuses() : null;
        const busy = searchController !== null || discoverController !== null;
        const focused = panel.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused?.id;
        const selection = focusedId === 'suno-search-term'
            ? [focused.selectionStart, focused.selectionEnd] : null;
        const listTop = panel.querySelector('#suno-voice-list')?.scrollTop ?? listScrollTop[activeTab];
        listScrollTop[activeTab] = listTop;
        const openFilterMenus = new Set([...panel.querySelectorAll('details[data-suno-filter]')]
            .filter(el => el.open).map(el => el.dataset.sunoFilter));
        const filterScrollTops = Object.fromEntries([...panel.querySelectorAll('details[data-suno-filter]')]
            .map(el => [el.dataset.sunoFilter, el.querySelector('.suno-filter-menu')?.scrollTop || 0]));

        panel.innerHTML = `
            <div
                style="
                    display:flex;
                    flex-direction:column;
                    width:100%;
                    height:100%;
                    min-height:0;
                "
            >

                <div role="tablist" aria-label="Voice Finder sections" style="display:flex;gap:5px;padding:5px 9px 0;flex-shrink:0;">
                    <button type="button" role="tab" data-suno-tab="voice" aria-selected="${!discover}"
                        style="flex:1;min-width:0;border:1px solid var(--color-border-secondary,#444);border-bottom:${discover ? '1px solid var(--color-border-secondary,#444)' : '2px solid #7c4dff'};border-radius:7px 7px 0 0;background:${discover ? 'rgba(255,255,255,.035)' : 'rgba(124,77,255,.16)'};color:inherit;padding:5px 4px;cursor:pointer;font-size:11px;font-weight:${discover ? 400 : 700};">
                        🎤 Voice <span style="opacity:.65">${found.size}</span></button>
                    <button type="button" role="tab" data-suno-tab="discover" aria-selected="${discover}"
                        style="flex:1;min-width:0;border:1px solid var(--color-border-secondary,#444);border-bottom:${discover ? '2px solid #7c4dff' : '1px solid var(--color-border-secondary,#444)'};border-radius:7px 7px 0 0;background:${discover ? 'rgba(124,77,255,.16)' : 'rgba(255,255,255,.035)'};color:inherit;padding:5px 4px;cursor:pointer;font-size:11px;font-weight:${discover ? 700 : 400};">
                        🔎 Discover <span style="opacity:.65">${discoveredSongs.size}</span></button>
                </div>

                <div
                    id="suno-voice-drag-handle"
                    style="
                        flex-shrink:0;
                        display:flex;
                        align-items:center;
                        justify-content:space-between;
                        gap:8px;
                        padding:7px 9px;
                        cursor:move;
                        user-select:none;
                        border-bottom:
                            1px solid
                            var(--color-border-secondary, #333);
                    "
                >

                    <div
                        style="
                            min-width:0;
                        "
                    >

                        <div
                            style="
                                display:flex;
                                align-items:center;
                                gap:7px;
                                font-size:12px;
                                font-weight:600;
                                min-width:0;
                                white-space:nowrap;
                                overflow:hidden;
                            "
                        >
                            ${discover ? '🔎 Discover' : '🎤 Voice Finder'}

                            <span
                                style="
                                    opacity:.55;
                                    font-size:10px;
                                "
                            >
                                (${discover ? (discoverRemixFilter === 'all' ? discoveredSongs.size : `${songs.length}/${discoveredSongs.size}`) : voices.length})
                            </span>
                        </div>

                        <div
                            style="
                                display:flex;
                                align-items:center;
                                gap:5px;
                                margin-top:2px;
                                font-size:9px;
                                opacity:.6;
                            "
                        >

                            <span
                                style="
                                    display:inline-block;
                                    width:7px;
                                    height:7px;
                                    border-radius:50%;
                                    background:#46d369;
                                "
                            ></span>

                            Monitoring ON

                            ${
                                discover
                                    ? (discoveredSongs.size >= MAX_DISCOVER_SONGS ? ` · Limit reached (${MAX_DISCOVER_SONGS})` : '')
                                    : (found.size >= MAX_VOICES ? ` · Limit reached (${MAX_VOICES})` : '')
                            }

                        </div>

                        ${!discover ? `<div style="display:flex;align-items:center;gap:7px;margin-top:4px;">
                            <button
                                id="suno-auto-scroll-toggle"
                                type="button"
                                role="switch"
                                aria-checked="${autoScrollEnabled}"
                                aria-label="Auto Scroll"
                                title="Jump to the bottom of Suno results every 7 seconds"
                                style="
                                    position:relative;
                                    flex-shrink:0;
                                    width:34px;
                                    height:18px;
                                    padding:0;
                                    border:0;
                                    border-radius:999px;
                                    cursor:pointer;
                                    background:${autoScrollEnabled ? '#46d369' : 'rgba(255,255,255,.18)'};
                                "
                            >
                                <span aria-hidden="true" style="
                                    position:absolute;
                                    width:14px;
                                    height:14px;
                                    top:2px;
                                    left:${autoScrollEnabled ? '18px' : '2px'};
                                    border-radius:50%;
                                    background:white;
                                "></span>
                            </button>
                            <span style="font-size:10px;opacity:.65;">
                                Auto Scroll${autoScrollEnabled ? ' · every 7s' : ''}
                            </span>
                        </div>` : ''}

                    </div>

                    <div
                        style="
                            display:flex;
                            align-items:center;
                            gap:5px;
                            flex-shrink:0;
                        "
                    >

                        <button id="suno-voice-export" type="button" title="${discover ? 'Export collected songs as CSV' : 'Export voices as CSV'}" aria-label="Export CSV"
                            style="width:25px;height:27px;padding:3px;border:1px solid var(--color-border-secondary, #444);border-radius:6px;background:rgba(255,255,255,.04);color:inherit;cursor:pointer;">
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"></path>
                            </svg>
                        </button>
                        <button
                            id="suno-voice-clear"
                            style="
                                padding:5px 8px;
                                border-radius:6px;
                                border:
                                    1px solid
                                    var(--color-border-secondary, #444);
                                background:
                                    rgba(255,255,255,.04);
                                color:inherit;
                                cursor:pointer;
                                font-size:11px;
                            "
                        >
                            Clear
                        </button>

                        <button
                            id="suno-voice-close"
                            title="Close Voice Finder"
                            style="
                                width:30px;
                                height:30px;
                                border:0;
                                border-radius:7px;
                                background:transparent;
                                color:inherit;
                                cursor:pointer;
                                font-size:20px;
                                line-height:1;
                            "
                        >
                            ×
                        </button>

                    </div>

                </div>

                <form id="suno-search-form" style="flex-shrink:0;padding:7px 9px 6px;border-bottom:1px solid var(--color-border-secondary, #333);">
                    <input id="suno-search-term" type="text" autocomplete="off"
                        aria-label="${discover ? 'Discover songs by genre or tag' : 'Search voices by genre'}"
                        placeholder="${discover ? 'Genre / tag, e.g. trap' : 'Genre, e.g. trap'}" value="${escapeHTML(discover ? discoverSearchTerm : searchTerm)}"
                        style="box-sizing:border-box;width:100%;min-width:0;padding:5px 7px;border:1px solid #555;border-radius:6px;background:#202020;color:#fff;font-size:11px;">
                    <div style="display:flex;gap:5px;margin-top:5px;">
                        <select id="suno-search-sort" aria-label="Search sort order"
                            style="flex:1;min-width:0;padding:5px;border:1px solid #555;border-radius:6px;background:#202020;color:#fff;font-size:10px;">
                            ${SEARCH_SORTS.map(([value, label]) => `<option value="${value}" ${value === (discover ? discoverSearchRank : searchRank) ? 'selected' : ''}>${label}</option>`).join('')}
                        </select>
                        <button id="suno-search-submit" type="submit" style="flex-shrink:0;padding:5px 8px;border:0;border-radius:6px;background:#7c4dff;color:white;font-size:10px;cursor:pointer;">${discover ? 'Load songs' : 'Load voices'}</button>
                    </div>
                    <div style="display:flex;gap:5px;margin-top:5px;align-items:stretch;">
                        ${renderFilterDropdown('languages', 'Lang', LANGUAGE_OPTIONS, filtersByTab[activeTab].languages, busy)}
                        ${renderFilterDropdown('model_versions', 'Model', MODEL_OPTIONS, filtersByTab[activeTab].model_versions, busy)}
                        ${discover ? `<select id="suno-discover-remix-filter" aria-label="Filter collected songs by Suno remix availability"
                            title="Filters collected songs and CSV export, not the Suno search request. Remix ON means in-app availability, not an audio reuse license."
                            style="flex:1;min-width:0;padding:5px 3px;border:1px solid #555;border-radius:6px;background:#202020;color:#fff;font-size:10px;">
                            <option value="all" ${discoverRemixFilter === 'all' ? 'selected' : ''}>Remix · Any</option>
                            <option value="enabled" ${discoverRemixFilter === 'enabled' ? 'selected' : ''}>● Remix ON</option>
                            <option value="disabled" ${discoverRemixFilter === 'disabled' ? 'selected' : ''}>🔒 Remix OFF</option>
                            <option value="unknown" ${discoverRemixFilter === 'unknown' ? 'selected' : ''}>◌ Unknown</option>
                        </select>` : ''}
                    </div>
                    ${discover ? `<div title="Remix filter applies to collected results and CSV, not to the Suno search request. Suno in-app remix permission is not a general audio reuse license."
                        style="font-size:9px;opacity:.65;margin-top:4px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ● ${remixCounts.enabled} ON · 🔒 ${remixCounts.disabled} OFF · ◌ ${remixCounts.unknown} unknown · ${songs.length}/${discoveredSongs.size} shown
                    </div>` : ''}
                    <div id="suno-search-status" role="status" aria-live="polite"
                        style="font-size:9px;line-height:1.25;opacity:.7;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;"></div>
                </form>

                <div
                    id="suno-voice-list"
                    style="
                        flex:1;
                        min-height:0;
                        overflow-y:auto;
                        overflow-x:hidden;
                    "
                >
                    ${discover
                        ? (songs.length ? songs.slice(0, discoverVisible).map(renderDiscoverSong).join('') :
                            `<div style="padding:18px 14px;opacity:.6;font-size:12px;line-height:1.5;">${discoveredSongs.size
                                ? 'No collected songs match the selected Remix filter. Switch to Any to see everything.'
                                : 'Search for a genre to load up to 1,000 public songs. Songs are separate from your Voice list.'}</div>`)
                        : (voices.length ? voices.map(renderVoice).join('') :
                            '<div style="padding:18px 14px;opacity:.6;font-size:12px;line-height:1.5;">Voice Finder is monitoring. Browse or search Suno and public voices will appear here.</div>')
                    }
                    ${discover && songs.length > discoverVisible ? `
                        <div style="padding:12px;text-align:center;">
                            <div style="font-size:10px;opacity:.65;margin-bottom:8px;">Showing ${Math.min(discoverVisible, songs.length)} of ${songs.length} matching songs · CSV exports all matching</div>
                            <button id="suno-discover-more" type="button" style="border:1px solid #555;border-radius:7px;background:#242424;color:white;padding:8px 12px;cursor:pointer;">Show next ${Math.min(DISCOVER_PAGE_SIZE, songs.length-discoverVisible)}</button>
                        </div>` : ''}
                </div>

            </div>
        `;

        for (const menu of panel.querySelectorAll('details[data-suno-filter]')) {
            if (openFilterMenus.has(menu.dataset.sunoFilter)) menu.open = true;
            const list = menu.querySelector('.suno-filter-menu');
            if (list) list.scrollTop = filterScrollTops[menu.dataset.sunoFilter] || 0;
        }
        panel.querySelectorAll('.suno-filter-checkbox').forEach(input => {
            input.addEventListener('change', () => {
                const selected = filtersByTab[activeTab][input.dataset.filter];
                if (input.checked) selected.add(input.value);
                else selected.delete(input.value);
                updateFilterSummaries(panel);
            });
        });
        panel.querySelectorAll('.suno-filter-clear').forEach(button => {
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (searchController || discoverController) return;
                const key = button.dataset.filter;
                filtersByTab[activeTab][key].clear();
                const menu = button.closest('details');
                menu?.querySelectorAll('.suno-filter-checkbox').forEach(input => { input.checked = false; });
                updateFilterSummaries(panel);
            });
        });
        panel.querySelectorAll('details[data-suno-filter]').forEach(menu => {
            menu.addEventListener('click', event => {
                if (event.target.closest('summary') && (searchController || discoverController)) {
                    event.preventDefault();
                }
            });
        });

        panel.querySelector('#suno-voice-export').addEventListener('click', event => {
            event.stopPropagation();
            if (activeTab === 'discover') exportDiscoverSongs();
            else exportVoices();
        });
        panel.querySelector('#suno-search-term').addEventListener('input', event => {
            if (activeTab === 'discover') discoverSearchTerm = event.target.value;
            else searchTerm = event.target.value;
            updateSearchControls();
        });
        panel.querySelector('#suno-search-sort').addEventListener('change', event => {
            if (activeTab === 'discover') discoverSearchRank = event.target.value;
            else searchRank = event.target.value;
        });
        panel.querySelector('#suno-discover-remix-filter')?.addEventListener('change', event => {
            discoverRemixFilter = ['all', 'enabled', 'disabled', 'unknown'].includes(event.target.value)
                ? event.target.value : 'all';
            discoverVisible = DISCOVER_PAGE_SIZE;
            listScrollTop.discover = 0;
            renderPanel();
        });
        panel.querySelector('#suno-search-form').addEventListener('submit', event => {
            event.preventDefault();
            event.stopPropagation();
            if (activeTab === 'discover') runDiscoverSearch();
            else runManualSearch();
        });
        panel.querySelectorAll('[data-suno-tab]').forEach(tabButton => {
            tabButton.addEventListener('click', () => {
                const next = tabButton.dataset.sunoTab;
                if (next === activeTab || busy) return;
                listScrollTop[activeTab] = panel.querySelector('#suno-voice-list')?.scrollTop || 0;
                stopAutoScroll();
                activeTab = next;
                renderPanel();
            });
        });
        panel.querySelector('#suno-discover-more')?.addEventListener('click', () => {
            listScrollTop.discover = panel.querySelector('#suno-voice-list')?.scrollTop || 0;
            discoverVisible = Math.min(getDiscoverVisibleSongs().length, discoverVisible + DISCOVER_PAGE_SIZE);
            renderPanel();
        });
        updateSearchControls();
        panel.querySelector('#suno-voice-list').scrollTop = listScrollTop[activeTab];
        const restoreFocus = focusedId ? panel.querySelector(`#${focusedId}`) : null;
        if (restoreFocus && !restoreFocus.disabled) {
            restoreFocus.focus({ preventScroll: true });
            if (selection) restoreFocus.setSelectionRange(...selection);
        }

        const handle =
            panel.querySelector(
                '#suno-voice-drag-handle'
            );

        if (handle) {
            makePanelDraggable(
                panel,
                handle
            );
        }

        panel.querySelector('#suno-auto-scroll-toggle')?.addEventListener(
            'click',
            event => {
                event.stopPropagation();
                toggleAutoScroll();
            }
        );

        /*
         * Clear.
         */
        panel.querySelector(
            '#suno-voice-clear'
        )?.addEventListener(
            'click',
            event => {
                event.stopPropagation();

                if (
                    (activeTab === 'discover' ? discoveredSongs.size === 0 : found.size === 0) ||
                    searchController !== null || discoverController !== null
                ) {
                    return;
                }

                const confirmed =
                    window.confirm(
                        activeTab === 'discover'
                            ? `Clear all ${discoveredSongs.size} collected songs?`
                            : `Clear all ${found.size} collected voices?`
                    );

                if (!confirmed) {
                    return;
                }

                if (activeTab === 'discover') {
                    discoveredSongs.clear();
                    discoverVisible = DISCOVER_PAGE_SIZE;
                    listScrollTop.discover = 0;
                    discoverSearchStatus = '';
                } else {
                    found.clear();
                    listScrollTop.voice = 0;
                    searchStatus = '';
                }

                console.log(
                    '[Suno Voice Finder] Current tab results cleared'
                );

                updateNavButton();
                renderPanel();
            }
        );

        /*
         * Close.
         */
        panel.querySelector(
            '#suno-voice-close'
        )?.addEventListener(
            'click',
            event => {
                event.stopPropagation();
                closePanel();
            }
        );

        /*
         * Copy URL.
         */
        panel
            .querySelectorAll(
                '.suno-copy-voice, .suno-copy-url'
            )
            .forEach(
                button => {
                    button.addEventListener(
                        'click',
                        async () => {
                            const url =
                                button.dataset.url;

                            try {
                                await navigator
                                    .clipboard
                                    .writeText(
                                        url
                                    );

                                const old =
                                    button.textContent;

                                button.textContent =
                                    'Copied ✓';

                                setTimeout(
                                    () => {
                                        button.textContent =
                                            old;
                                    },
                                    1200
                                );

                            } catch (
                                error
                            ) {
                                console.error(
                                    '[Suno Voice Finder] Copy failed',
                                    error
                                );
                            }
                        }
                    );
                }
            );
    }

    /*
     * ============================================================
     * FETCH INTERCEPTOR
     * ============================================================
     */

    restoreGenreHandoff();

    const originalFetch =
        w.fetch;

    w.fetch =
        async function(
            ...args
        ) {
            let template = null;
            if (panelOpen && monitoring) {
                try {
                    const input = args[0];
                    const init = args[1] || {};
                    const url = typeof input === 'string' ? input : input?.url || input?.href;
                    const method = String(init.method || input?.method || 'GET').toUpperCase();
                    template = captureTemplate(url, method,
                        init.headers !== undefined ? init.headers : input?.headers,
                        init.credentials || input?.credentials || 'same-origin');
                } catch {}
            }
            const response =
                await originalFetch.apply(
                    this,
                    args
                );

            /*
             * Finder closed?
             *
             * Absolutely nothing else happens.
             */
            if (
                !monitoring ||
                !panelOpen
            ) {
                return response;
            }

            if (response.ok && isStudioApiUrl(response.url)) rememberSearch(template);

            try {
                const request =
                    args[0];

                let url = '';

                if (
                    typeof request ===
                        'string'
                ) {
                    url = request;

                } else if (
                    request?.url
                ) {
                    url =
                        request.url;

                } else if (
                    request?.href
                ) {
                    url =
                        request.href;
                }

                if (
                    !isSunoApiUrl(url)
                ) {
                    return response;
                }

                const contentType =
                    response.headers
                        .get(
                            'content-type'
                        )
                        ?.toLowerCase() ||
                    '';

                if (
                    !contentType.includes(
                        'application/json'
                    ) &&
                    !contentType.includes(
                        '+json'
                    )
                ) {
                    return response;
                }

                const source =
                    getSourceName(
                        url
                    );

                response
                    .clone()
                    .text()
                    .then(
                        text => {
                            /*
                             * Finder might have been closed while
                             * this response was being read.
                             */
                            if (
                                !monitoring ||
                                !panelOpen
                            ) {
                                return;
                            }

                            /*
                             * Critical performance check.
                             */
                            if (
                                !textMayContainVoice(
                                    text
                                )
                            ) {
                                return;
                            }

                            let data;

                            try {
                                data =
                                    JSON.parse(
                                        text
                                    );

                            } catch {
                                return;
                            }

                            scan(
                                data,
                                source
                            );
                        }
                    )
                    .catch(
                        () => {}
                    );

            } catch (
                error
            ) {
                console.error(
                    '[Suno Voice Finder] Fetch interceptor error',
                    error
                );
            }

            return response;
        };

    /*
     * ============================================================
     * XHR INTERCEPTOR
     * ============================================================
     */

    const xhrPrototype =
        w.XMLHttpRequest.prototype;

    const originalOpen =
        xhrPrototype.open;

    const originalSend =
        xhrPrototype.send;
    const originalSetRequestHeader = xhrPrototype.setRequestHeader;
    const xhrSearchRequests = new WeakMap();

    xhrPrototype.setRequestHeader = function(name, value) {
        const result = originalSetRequestHeader.call(this, name, value);
        const search = xhrSearchRequests.get(this);
        if (search) search.headers.append(name, value);
        return result;
    };

    xhrPrototype.open =
        function(
            method,
            url,
            ...rest
        ) {
            const result = originalOpen.call(this, method, url, ...rest);
            this.__sunoVoiceFinderUrl = String(url);
            xhrSearchRequests.delete(this);
            if (panelOpen && monitoring && isStudioApiUrl(url)) {
                xhrSearchRequests.set(this, { headers: new w.Headers(), method });
            }
            return result;
        };

    xhrPrototype.send =
        function(
            ...args
        ) {
            /*
             * Finder closed at send time?
             *
             * Do not even attach a listener.
             */
            if (!monitoring) {
                return originalSend.apply(
                    this,
                    args
                );
            }

            const url =
                this.__sunoVoiceFinderUrl ||
                '';

            const search = xhrSearchRequests.get(this);
            const template = search ? captureTemplate(url, search.method, search.headers,
                this.withCredentials ? 'include' : 'same-origin') : null;
            xhrSearchRequests.delete(this);

            if (
                isSunoApiUrl(url)
            ) {
                this.addEventListener(
                    'loadend',
                    function() {
                        if (
                            !monitoring ||
                            !panelOpen
                        ) {
                            return;
                        }

                        try {
                            if (this.status >= 200 && this.status < 300 && isStudioApiUrl(this.responseURL)) {
                                rememberSearch(template);
                            }
                            const contentType =
                                (
                                    this.getResponseHeader(
                                        'content-type'
                                    ) ||
                                    ''
                                )
                                    .toLowerCase();

                            if (
                                !contentType.includes(
                                    'application/json'
                                ) &&
                                !contentType.includes(
                                    '+json'
                                )
                            ) {
                                return;
                            }

                            const source =
                                getSourceName(
                                    url
                                );

                            let data;

                            /*
                             * If responseType=json, the browser
                             * already parsed it.
                             *
                             * Avoid JSON.stringify() here because
                             * that would duplicate large responses.
                             */
                            if (
                                this.responseType ===
                                    'json'
                            ) {
                                data =
                                    this.response;

                                if (!data) {
                                    return;
                                }

                                /*
                                 * Browser already paid the JSON
                                 * parsing cost, so directly scan.
                                 */
                                scan(
                                    data,
                                    source
                                );

                                return;
                            }

                            const text =
                                this.responseText ||
                                '';

                            /*
                             * Raw-text responses get the strict
                             * cheap prefilter.
                             */
                            if (
                                !textMayContainVoice(
                                    text
                                )
                            ) {
                                return;
                            }

                            try {
                                data =
                                    JSON.parse(
                                        text
                                    );

                            } catch {
                                return;
                            }

                            scan(
                                data,
                                source
                            );

                        } catch {}
                    },
                    { once: true }
                );
            }

            return originalSend.apply(
                this,
                args
            );
        };

    /*
     * ============================================================
     * RESIZE
     * ============================================================
     */

    window.addEventListener(
        'resize',
        () => {
            if (!panelOpen) {
                return;
            }

            const panel =
                getPanel();

            const dimensions =
                getPanelDimensions();

            const rect =
                panel.getBoundingClientRect();

            panel.style.width =
                `${dimensions.width}px`;

            panel.style.height =
                `${dimensions.height}px`;

            const position =
                clampPosition(
                    dimensions.width,
                    dimensions.height,
                    rect.left,
                    rect.top
                );

            panel.style.left =
                `${position.x}px`;

            panel.style.top =
                `${position.y}px`;

            savePanelPosition(
                position.x,
                position.y
            );
        }
    );

    /*
     * ============================================================
     * START
     * ============================================================
     */

    function start() {
        if (
            !document.documentElement
        ) {
            setTimeout(
                start,
                50
            );

            return;
        }

        startSidebarWatcher();
        if (panelOpen) openPanel();

        console.log(
            '%c[Suno Voice Finder + Discover v0.7.3] loaded — monitoring OFF until opened',
            'color:#b79cff;font-weight:bold'
        );
    }

    start();

})();
