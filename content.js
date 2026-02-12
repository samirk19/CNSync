(async function () {
    const browserAPI = typeof browser !== "undefined" ? browser : chrome;

    console.log("[CanvasNotion] Content script loaded on:", window.location.hostname);

    // Only run on Canvas pages
    const CANVAS_DOMAINS = ["instructure.com", "canvas.vt.edu", "canvas.virginia.edu"];
    if (!CANVAS_DOMAINS.some((d) => window.location.hostname.includes(d))) {
        console.log("[CanvasNotion] Not a Canvas page, exiting");
        return;
    }

    console.log("[CanvasNotion] Canvas page detected");

    // Prevent double-execution
    if (window.__canvasNotionLoaded) {
        console.log("[CanvasNotion] Already loaded, skipping");
        return;
    }
    window.__canvasNotionLoaded = true;

    // Check if Notion token is configured
    let notionToken;
    try {
        const result = await browserAPI.storage.local.get("notionToken");
        notionToken = result.notionToken;
    } catch (e) {
        console.error("[CanvasNotion] Failed to read storage:", e);
        return;
    }

    if (!notionToken) {
        console.log("[CanvasNotion] No Notion token configured, exiting");
        return;
    }
    console.log("[CanvasNotion] Notion token found");

    // Get Canvas user ID from API (content scripts can't access page JS)
    let canvasUserId;
    try {
        const resp = await fetch("/api/v1/users/self", { credentials: "same-origin" });
        if (!resp.ok) {
            console.log("[CanvasNotion] Not logged into Canvas (API returned", resp.status, ")");
            return;
        }
        const user = await resp.json();
        canvasUserId = String(user.id);
        console.log("[CanvasNotion] Canvas user ID:", canvasUserId);
    } catch (e) {
        console.error("[CanvasNotion] Failed to get Canvas user:", e);
        return;
    }

    // Check if this Canvas account is allowed to sync
    const domain = window.location.hostname;
    const accountAllowed = await checkAccountAllowed(domain, canvasUserId);
    if (!accountAllowed) {
        console.log("[CanvasNotion] Account not allowed, skipping sync");
        return;
    }

    // Listen for sync requests from popup/background (Phase 2)
    browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "DO_SYNC") {
            syncAssignments().then(sendResponse);
            return true;
        }
    });

    // Phase 1: Discover courses on page load (does NOT fetch assignments)
    await discoverCourses();

    // Watch for assignment submissions and re-sync (Phase 2)
    observeSubmissions();

    // =========================================================================
    // PHASE 1: Course Discovery
    // Fetches course list from Canvas and saves to local storage.
    // Does NOT fetch assignments. Does NOT call Notion.
    // =========================================================================
    async function discoverCourses() {
        try {
            console.log("[CanvasNotion] Phase 1: Discovering courses...");
            const courses = await canvasFetch(
                "/api/v1/courses?enrollment_state=active&per_page=100"
            );

            if (!Array.isArray(courses) || courses.length === 0) {
                console.log("[CanvasNotion] No active courses found");
                return;
            }

            const allCourses = courses
                .filter((c) => c.id && c.name)
                .map((c) => ({
                    id: String(c.id),
                    name: c.name,
                    course_code: c.course_code || "",
                }));

            await browserAPI.storage.local.set({
                discoveredCourses: allCourses,
                coursesDiscovered: true,
            });

            console.log(
                `[CanvasNotion] Phase 1 complete: ${allCourses.length} courses discovered`
            );

            // Notify background so popup can update if open
            browserAPI.runtime.sendMessage({ type: "COURSES_DISCOVERED" }).catch(() => {});
        } catch (err) {
            console.error("[CanvasNotion] Phase 1 error:", err);
        }
    }

    // =========================================================================
    // PHASE 2: Fetch Assignments + Push to Notion
    // Only runs when triggered by DO_SYNC (user clicked "Sync Now" or periodic alarm).
    // Reads selectedCourseIds from storage, fetches assignments for those courses,
    // stages data in storage, then sends to background for Notion upsert.
    // =========================================================================
    async function syncAssignments() {
        // Re-discover courses first to catch any new ones
        await discoverCourses();

        // Load selected course IDs (opt-in)
        let selectedCourseIds;
        try {
            const stored = await browserAPI.storage.local.get("selectedCourseIds");
            selectedCourseIds = stored.selectedCourseIds;
        } catch (e) {
            /* ignore */
        }

        if (!selectedCourseIds || selectedCourseIds.length === 0) {
            console.log("[CanvasNotion] No courses selected, skipping sync");
            return { error: "No courses selected" };
        }

        const selectedSet = new Set(selectedCourseIds);

        try {
            // Load discovered courses to get metadata
            const { discoveredCourses } = await browserAPI.storage.local.get(
                "discoveredCourses"
            );
            if (!discoveredCourses || discoveredCourses.length === 0) {
                return { error: "No courses discovered" };
            }

            console.log(
                `[CanvasNotion] Phase 2: Fetching assignments for ${selectedCourseIds.length} selected courses...`
            );

            const syncData = {
                institution_domain: domain,
                canvas_user_id: canvasUserId,
                courses: [],
            };

            // Fetch assignments only for selected courses
            for (const course of discoveredCourses) {
                if (!selectedSet.has(course.id)) continue;

                console.log(
                    `[CanvasNotion] Fetching assignments for: ${course.name}`
                );

                let assignments = [];
                try {
                    assignments = await canvasFetch(
                        `/api/v1/courses/${course.id}/assignments?include[]=submission&per_page=100`
                    );
                } catch (err) {
                    console.error(
                        `[CanvasNotion] Error fetching assignments for course ${course.name} (ID: ${course.id}):`,
                        err
                    );
                    console.warn(
                        `[CanvasNotion] Skipping course ${course.name}: ${err.message}`
                    );
                    continue;
                }

                if (!Array.isArray(assignments)) {
                    console.warn(
                        `[CanvasNotion] Unexpected response for course ${course.name}`
                    );
                    continue;
                }

                syncData.courses.push({
                    canvas_course_id: course.id,
                    name: course.name,
                    course_code: course.course_code || "",
                    assignments: assignments.map((a) => ({
                        canvas_assignment_id: String(a.id),
                        name: a.name,
                        due_at: a.due_at || null,
                        points_possible: a.points_possible || 0,
                        html_url: a.html_url || null,
                        submission: mapSubmission(a.submission),
                    })),
                });
            }

            const totalAssignments = syncData.courses.reduce(
                (n, c) => n + c.assignments.length,
                0
            );
            console.log(
                `[CanvasNotion] Phase 2: ${syncData.courses.length} courses, ${totalAssignments} assignments`
            );

            // Stage in local storage
            await browserAPI.storage.local.set({ stagedAssignments: syncData });

            // Send to background for Notion upsert
            const result = await browserAPI.runtime.sendMessage({
                type: "SYNC_TO_NOTION",
                data: syncData,
            });

            console.log("[CanvasNotion] Sync result:", JSON.stringify(result));
            return result;
        } catch (err) {
            console.error("[CanvasNotion] Phase 2 error:", err);
            return { error: err.message };
        }
    }

    // =========================================================================
    // Account allowlist — same pattern as StudyLink
    // =========================================================================
    async function checkAccountAllowed(domain, userId) {
        const stored = await browserAPI.storage.local.get("knownAccounts");
        const accounts = stored.knownAccounts || [];
        const existing = accounts.find(
            (a) => a.domain === domain && a.canvasUserId === userId
        );

        if (existing) {
            return existing.status === "allowed";
        }

        // First account ever — auto-allow silently
        if (accounts.length === 0) {
            accounts.push({ domain, canvasUserId: userId, status: "allowed" });
            await browserAPI.storage.local.set({ knownAccounts: accounts });
            console.log(
                "[CanvasNotion] First account registered:",
                `${domain}:${userId}`
            );
            return true;
        }

        // New unknown account — show confirmation banner on the Canvas page
        return new Promise((resolve) => {
            const banner = document.createElement("div");
            banner.id = "canvas-notion-account-banner";
            banner.style.cssText = `
                position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
                background: #4f46e5; color: white; padding: 12px 20px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 14px; display: flex; align-items: center; justify-content: space-between;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            `;
            banner.innerHTML = `
                <span>Canvas to Notion detected a different Canvas account on <b>${domain}</b>. Sync this account?</span>
                <span>
                    <button id="canvas-notion-allow" style="background:white;color:#4f46e5;border:none;padding:6px 16px;border-radius:6px;font-weight:600;cursor:pointer;margin-left:8px;">Allow</button>
                    <button id="canvas-notion-deny" style="background:rgba(255,255,255,0.2);color:white;border:1px solid rgba(255,255,255,0.4);padding:6px 16px;border-radius:6px;font-weight:600;cursor:pointer;margin-left:8px;">Deny</button>
                </span>
            `;
            document.body.prepend(banner);

            document
                .getElementById("canvas-notion-allow")
                .addEventListener("click", async () => {
                    accounts.push({ domain, canvasUserId: userId, status: "allowed" });
                    await browserAPI.storage.local.set({ knownAccounts: accounts });
                    banner.remove();
                    resolve(true);
                });

            document
                .getElementById("canvas-notion-deny")
                .addEventListener("click", async () => {
                    accounts.push({ domain, canvasUserId: userId, status: "denied" });
                    await browserAPI.storage.local.set({ knownAccounts: accounts });
                    banner.remove();
                    resolve(false);
                });
        });
    }

    // =========================================================================
    // Canvas API helpers
    // =========================================================================
    function mapSubmission(sub) {
        if (!sub) return { status: "unsubmitted" };

        let status = "unsubmitted";
        if (sub.missing) status = "missing";
        else if (sub.late) status = "late";
        else if (sub.workflow_state === "graded") status = "graded";
        else if (sub.workflow_state === "submitted") status = "submitted";

        return {
            status,
            submitted_at: sub.submitted_at || null,
        };
    }

    async function canvasFetch(path) {
        let allResults = [];
        let url = path;
        const seen = new Set();
        const MAX_PAGES = 20;
        let page = 0;

        while (url) {
            if (seen.has(url) || page >= MAX_PAGES) break;
            seen.add(url);
            page++;

            let response;
            try {
                response = await fetch(url, { credentials: "same-origin" });
            } catch (fetchErr) {
                console.error(`[CanvasNotion] Network error fetching ${url}:`, fetchErr);
                throw new Error(`Failed to fetch: ${fetchErr.message}`);
            }

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                console.error(
                    `[CanvasNotion] Canvas API error ${response.status} for ${url}:`,
                    errorText
                );
                throw new Error(
                    `Canvas API ${response.status} ${response.statusText} for ${url}`
                );
            }

            const data = await response.json();

            if (!Array.isArray(data)) break;

            allResults = allResults.concat(data);

            const linkHeader = response.headers.get("Link");
            url = parseLinkNext(linkHeader);
        }

        return allResults;
    }

    function parseLinkNext(header) {
        if (!header) return null;
        const parts = header.split(",");
        for (const part of parts) {
            const match = part.match(/<([^>]+)>;\s*rel="next"/);
            if (match) return match[1];
        }
        return null;
    }

    // =========================================================================
    // Submission observer — re-sync (Phase 2) when user submits an assignment
    // =========================================================================
    function observeSubmissions() {
        let syncTimer = null;
        const triggerDelayedSync = async () => {
            // Only re-sync if courses have been selected
            const { selectedCourseIds } = await browserAPI.storage.local.get(
                "selectedCourseIds"
            );
            if (!selectedCourseIds || selectedCourseIds.length === 0) return;

            if (syncTimer) clearTimeout(syncTimer);
            syncTimer = setTimeout(() => {
                console.log("[CanvasNotion] Submission detected, re-syncing...");
                syncAssignments();
            }, 3000);
        };

        // Watch for Canvas flash messages (submission success notifications)
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;
                    if (
                        node.classList?.contains("ic-flash-success") ||
                        node.querySelector?.(".ic-flash-success")
                    ) {
                        triggerDelayedSync();
                        return;
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Watch for SPA navigation to submission pages
        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                if (
                    /\/courses\/\d+\/assignments\/\d+\/submissions\/\d+/.test(
                        lastUrl
                    )
                ) {
                    triggerDelayedSync();
                }
            }
        });
        urlObserver.observe(document.body, { childList: true, subtree: true });
    }
})();
