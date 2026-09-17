// ==UserScript==
// @name         Suno Public Voice Finder
// @namespace    suno-voice-finder
// @version      0.6.1
// @description  Discovers public Suno voice/persona URLs from Suno API responses
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
    let searchTerm = '';
    let searchRank = 'most_relevant';
    let searchTemplate = null;
    let searchController = null;
    let searchStatus = '';
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

    function openGenreForSearch() {
        if (genreNavigationStarted) {
            searchStatus = 'Waiting for Suno to finish loading this genre. Try Load voices again when it is ready.';
            updateSearchControls();
            return;
        }
        const url = genrePageUrl(searchTerm);
        try {
            // Only public result data crosses this navigation. Never save headers.
            sessionStorage.setItem(GENRE_HANDOFF_KEY, JSON.stringify({
                expires: Date.now() + 120000,
                url,
                term: searchTerm.trim(),
                rank: searchRank,
                voices: [...found.values()].map(voice => ({
                    id: voice.id, name: voice.name, creator: voice.creator,
                    image: voice.image, sources: [...voice.sources]
                }))
            }));
            genreNavigationStarted = true;
            searchStatus = 'Opening genre…';
            stopAutoScroll();
            updateSearchControls();
            window.location.assign(url);
        } catch {
            genreNavigationStarted = false;
            try { sessionStorage.removeItem(GENRE_HANDOFF_KEY); } catch {}
            searchStatus = 'Could not open the genre while preserving your results. Allow tab storage, then try again.';
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
            if (!['https://suno.com', 'https://www.suno.com'].includes(target.origin) || current.origin !== target.origin ||
                current.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '') ||
                !Number.isFinite(value.expires) || value.expires <= Date.now() ||
                typeof value.term !== 'string' || !value.term.trim()) return;
            searchTerm = value.term;
            searchRank = SEARCH_SORTS.some(([key]) => key === value.rank) ? value.rank : 'most_relevant';
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
            genreNavigationStarted = true;
            pendingGenreSearch = true;
            panelOpen = true;
            monitoring = true;
            searchStatus = 'Loading genre…';
        } catch {}
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

    function exportVoices() {
        if (!found.size) return;
        function cell(value) {
            let text = String(value ?? '');
            // Keep untrusted names from becoming spreadsheet formulas.
            if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
            return '"' + text.replaceAll('"', '""') + '"';
        }
        const rows = [['Voice ID', 'Name', 'Creator', 'Voice URL', 'Image URL', 'Sources']];
        for (const voice of found.values()) {
            rows.push([voice.id, voice.name, voice.creator, voice.url, voice.image, [...voice.sources].join('; ')]);
        }
        const csv = '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
        const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = `Suno-Voices-${new Date().toISOString().slice(0, 10)}.csv`;
        document.documentElement.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
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
        if (!searchController) searchStatus = '';
        updateSearchControls();
        if (pendingGenreSearch) {
            setTimeout(() => {
                if (pendingGenreSearch && panelOpen && searchTemplate && !searchController) {
                    pendingGenreSearch = false;
                    runManualSearch();
                }
            }, 0);
        }
    }

    function updateSearchControls() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const busy = searchController !== null;
        const button = panel.querySelector('#suno-search-submit');
        if (button) {
            button.disabled = busy || !searchTerm.trim();
            button.textContent = busy ? 'Searching…' : 'Load voices';
            button.style.opacity = button.disabled ? '.5' : '1';
        }
        for (const id of ['suno-search-term', 'suno-search-sort', 'suno-voice-clear']) {
            const element = panel.querySelector(`#${id}`);
            if (element) element.disabled = busy;
        }
        const exportButton = panel.querySelector('#suno-voice-export');
        if (exportButton) {
            exportButton.disabled = found.size === 0;
            exportButton.style.opacity = exportButton.disabled ? '.4' : '1';
        }
        const status = panel.querySelector('#suno-search-status');
        if (status) {
            status.textContent = searchStatus || (searchTemplate
                ? 'Ready · requests up to 1,000 songs per search.'
                : 'First search opens the genre page. Later searches stay here.');
        }
    }

    function cancelManualSearch() {
        if (!searchController) return;
        searchController.abort();
        searchController = null;
        searchStatus = 'Search canceled.';
    }

    async function runManualSearch() {
        if (!panelOpen || searchController || !searchTerm.trim()) return;
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
                    is_public: true
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

        const voices =
            [...found.values()];
        const focused = panel.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused?.id;
        const selection = focusedId === 'suno-search-term'
            ? [focused.selectionStart, focused.selectionEnd] : null;
        const listTop = panel.querySelector('#suno-voice-list')?.scrollTop || 0;

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

                <div
                    id="suno-voice-drag-handle"
                    style="
                        flex-shrink:0;
                        display:flex;
                        align-items:center;
                        justify-content:space-between;
                        gap:8px;
                        padding:12px;
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
                                font-size:14px;
                                font-weight:600;
                            "
                        >
                            🎤 Voice Finder

                            <span
                                style="
                                    opacity:.55;
                                    font-size:11px;
                                "
                            >
                                (${voices.length})
                            </span>
                        </div>

                        <div
                            style="
                                display:flex;
                                align-items:center;
                                gap:5px;
                                margin-top:3px;
                                font-size:10px;
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
                                found.size >=
                                MAX_VOICES
                                    ? ` · Limit reached (${MAX_VOICES})`
                                    : ''
                            }

                        </div>

                        <div style="display:flex;align-items:center;gap:7px;margin-top:8px;">
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
                        </div>

                    </div>

                    <div
                        style="
                            display:flex;
                            align-items:center;
                            gap:5px;
                            flex-shrink:0;
                        "
                    >

                        <button id="suno-voice-export" type="button" title="Export voices as CSV" aria-label="Export voices as CSV"
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

                <form id="suno-search-form" style="flex-shrink:0;padding:10px 12px;border-bottom:1px solid var(--color-border-secondary, #333);">
                    <label for="suno-search-term" style="display:block;font-size:11px;margin-bottom:5px;">Genre:</label>
                    <input id="suno-search-term" type="text" autocomplete="off"
                        placeholder="Enter a genre, e.g. trap" value="${escapeHTML(searchTerm)}"
                        style="box-sizing:border-box;width:100%;min-width:0;padding:7px;border:1px solid #555;border-radius:6px;background:#202020;color:#fff;font-size:12px;">
                    <div style="display:flex;gap:6px;margin-top:7px;">
                        <select id="suno-search-sort" aria-label="Search sort order"
                            style="flex:1;min-width:0;padding:6px;border:1px solid #555;border-radius:6px;background:#202020;color:#fff;font-size:11px;">
                            ${SEARCH_SORTS.map(([value, label]) => `<option value="${value}" ${value === searchRank ? 'selected' : ''}>${label}</option>`).join('')}
                        </select>
                        <button id="suno-search-submit" type="submit" style="padding:7px 9px;border:0;border-radius:6px;background:#7c4dff;color:white;font-size:11px;cursor:pointer;">Load voices</button>
                    </div>
                    <div id="suno-search-status" role="status" aria-live="polite"
                        style="font-size:10px;line-height:1.4;opacity:.7;margin-top:7px;"></div>
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
                    ${
                        voices.length
                            ? voices
                                .map(
                                    renderVoice
                                )
                                .join('')
                            : `
                                <div
                                    style="
                                        padding:18px 14px;
                                        opacity:.55;
                                        font-size:12px;
                                        line-height:1.5;
                                    "
                                >
                                    Voice Finder is monitoring.

                                    <br><br>

                                    Browse, search, or scroll Suno
                                    and public voices will appear here.
                                </div>
                            `
                    }
                </div>

            </div>
        `;

        panel.querySelector('#suno-voice-export').addEventListener('click', event => {
            event.stopPropagation();
            exportVoices();
        });
        panel.querySelector('#suno-search-term').addEventListener('input', event => {
            searchTerm = event.target.value;
            updateSearchControls();
        });
        panel.querySelector('#suno-search-sort').addEventListener('change', event => {
            searchRank = event.target.value;
        });
        panel.querySelector('#suno-search-form').addEventListener('submit', event => {
            event.preventDefault();
            event.stopPropagation();
            runManualSearch();
        });
        updateSearchControls();
        panel.querySelector('#suno-voice-list').scrollTop = listTop;
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
                    found.size === 0 || searchController !== null
                ) {
                    return;
                }

                const confirmed =
                    window.confirm(
                        `Clear all ${found.size} collected voices?`
                    );

                if (!confirmed) {
                    return;
                }

                found.clear();
                searchStatus = '';

                console.log(
                    '[Suno Voice Finder] Results cleared'
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
                '.suno-copy-voice'
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
            '%c[Suno Voice Finder v0.6.1] loaded — monitoring OFF until opened',
            'color:#b79cff;font-weight:bold'
        );
    }

    start();

})();