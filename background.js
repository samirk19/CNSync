import { NotionClient } from "./notion-api.js";

const browserAPI = typeof browser !== "undefined" ? browser : chrome;
const SYNC_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const CANVAS_URL_PATTERNS = [
    "https://*.instructure.com/*",
    "https://canvas.vt.edu/*",
    "https://canvas.virginia.edu/*",
];
const CANVAS_REGEX = /\.instructure\.com|canvas\.vt\.edu|canvas\.virginia\.edu/;

let lastSyncTime = 0;

// Periodic sync every 4 hours
browserAPI.alarms.create("canvas-notion-sync", { periodInMinutes: 240 });

browserAPI.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== "canvas-notion-sync") return;

    const { selectedCourseIds } = await browserAPI.storage.local.get("selectedCourseIds");
    if (!selectedCourseIds || selectedCourseIds.length === 0) {
        console.log("[CanvasNotion] Periodic sync skipped — no courses selected yet");
        return;
    }

    // Try content script first (same-origin fetch, no token needed)
    const tabs = await browserAPI.tabs.query({ url: CANVAS_URL_PATTERNS });

    if (tabs.length > 0) {
        lastSyncTime = 0;
        try {
            await browserAPI.tabs.sendMessage(tabs[0].id, { type: "DO_SYNC" });
            return;
        } catch {
            // Content script not loaded — fall through to token fallback
        }
    }

    // No Canvas tab or content script failed — try token-based background sync
    await attemptBackgroundSync();
});

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "SYNC_TO_NOTION") {
        handleNotionSync(message.data).then(sendResponse);
        return true;
    }
    if (message.type === "MANUAL_SYNC") {
        lastSyncTime = 0;
        handleManualSync().then(sendResponse);
        return true;
    }
    if (message.type === "SETUP_DATABASE") {
        setupDatabase(message.parentPageId).then(sendResponse);
        return true;
    }
    if (message.type === "GET_PAGES") {
        getAccessiblePages().then(sendResponse);
        return true;
    }
    if (message.type === "VALIDATE_TOKEN") {
        validateToken(message.token).then(sendResponse);
        return true;
    }
    if (message.type === "COURSES_DISCOVERED") {
        console.log("[CanvasNotion] Courses discovered notification received");
        return false;
    }
});

async function handleManualSync() {
    // Try content script on active Canvas tab first
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url?.match(CANVAS_REGEX)) {
        try {
            return await browserAPI.tabs.sendMessage(tabs[0].id, { type: "DO_SYNC" });
        } catch {
            // Content script not loaded — fall through
        }
    }

    // Try any Canvas tab
    const canvasTabs = await browserAPI.tabs.query({ url: CANVAS_URL_PATTERNS });
    if (canvasTabs.length > 0) {
        try {
            return await browserAPI.tabs.sendMessage(canvasTabs[0].id, { type: "DO_SYNC" });
        } catch {
            // fall through
        }
    }

    // No Canvas tab — try token-based background sync
    const { canvasApiToken, canvasBaseUrl } = await browserAPI.storage.local.get([
        "canvasApiToken",
        "canvasBaseUrl",
    ]);

    if (canvasApiToken && canvasBaseUrl) {
        console.log("[CanvasNotion] No Canvas tab, using API token for background sync");
        return syncFromBackground(canvasBaseUrl, canvasApiToken);
    }

    return { error: "No Canvas tab active and no Canvas API token configured" };
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------
async function validateToken(token) {
    try {
        const client = new NotionClient(token);
        const user = await client.validateToken();
        return { success: true, botName: user.name || "Notion Integration" };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ---------------------------------------------------------------------------
// Database setup — create the assignments database under a parent page
// ---------------------------------------------------------------------------
async function setupDatabase(parentPageId) {
    const { notionToken } = await browserAPI.storage.local.get("notionToken");
    if (!notionToken) {
        return { error: "No Notion token" };
    }

    try {
        const client = new NotionClient(notionToken);
        const db = await client.createDatabase(parentPageId);

        await browserAPI.storage.local.set({
            databaseId: db.id,
            parentPageId: parentPageId,
        });

        return { success: true, databaseId: db.id };
    } catch (err) {
        return { error: err.message };
    }
}

// ---------------------------------------------------------------------------
// List accessible pages for the page picker
// ---------------------------------------------------------------------------
async function getAccessiblePages() {
    const { notionToken } = await browserAPI.storage.local.get("notionToken");
    if (!notionToken) {
        return { error: "No Notion token" };
    }

    try {
        const client = new NotionClient(notionToken);
        const result = await client.searchPages();
        const pages = result.results.map((p) => ({
            id: p.id,
            title: getPageTitle(p),
            icon: p.icon?.emoji || null,
        }));
        return { success: true, pages };
    } catch (err) {
        return { error: err.message };
    }
}

function getPageTitle(page) {
    if (page.properties?.title?.title?.[0]?.plain_text) {
        return page.properties.title.title[0].plain_text;
    }
    for (const key of Object.keys(page.properties || {})) {
        const prop = page.properties[key];
        if (prop.type === "title" && prop.title?.[0]?.plain_text) {
            return prop.title[0].plain_text;
        }
    }
    return "Untitled";
}

// ---------------------------------------------------------------------------
// Diff/Cache helpers
// ---------------------------------------------------------------------------
function buildFingerprint(assignment) {
    return {
        name: assignment.name,
        due_at: assignment.due_at || null,
        points_possible: assignment.points_possible || 0,
        status: assignment.submission?.status || "unsubmitted",
        html_url: assignment.html_url || null,
    };
}

function fingerprintChanged(fresh, cached) {
    return (
        fresh.name !== cached.name ||
        fresh.due_at !== cached.due_at ||
        fresh.points_possible !== cached.points_possible ||
        fresh.status !== cached.status ||
        fresh.html_url !== cached.html_url
    );
}

function diffAssignments(syncData, cache) {
    const toCreate = [];
    const toUpdate = [];
    const unchanged = [];

    for (const course of syncData.courses) {
        for (const assignment of course.assignments) {
            const canvasId = `${course.canvas_course_id}:${assignment.canvas_assignment_id}`;
            const fingerprint = buildFingerprint(assignment);
            const cached = cache[canvasId];

            if (!cached) {
                toCreate.push({ course, assignment, canvasId });
            } else if (fingerprintChanged(fingerprint, cached)) {
                toUpdate.push({ course, assignment, canvasId });
            } else {
                unchanged.push(canvasId);
            }
        }
    }

    return { toCreate, toUpdate, unchanged };
}

function buildSyncCache(syncData) {
    const cache = {};
    for (const course of syncData.courses) {
        for (const assignment of course.assignments) {
            const canvasId = `${course.canvas_course_id}:${assignment.canvas_assignment_id}`;
            cache[canvasId] = buildFingerprint(assignment);
        }
    }
    return cache;
}

// ---------------------------------------------------------------------------
// Notion sync — diff-based upsert from Canvas data
// ---------------------------------------------------------------------------
async function handleNotionSync(syncData) {
    const now = Date.now();
    if (now - lastSyncTime < SYNC_DEBOUNCE_MS) {
        return { skipped: true, reason: "debounced" };
    }

    const { notionToken, databaseId, syncCache } = await browserAPI.storage.local.get([
        "notionToken",
        "databaseId",
        "syncCache",
    ]);

    if (!notionToken || !databaseId) {
        return { error: "Not configured — connect Notion and set up a database first" };
    }

    const client = new NotionClient(notionToken);

    try {
        // Step 1: Diff against cache
        const { toCreate, toUpdate, unchanged } = diffAssignments(
            syncData,
            syncCache || {}
        );

        console.log(
            `[CanvasNotion] Diff: ${toCreate.length} new, ${toUpdate.length} changed, ${unchanged.length} unchanged`
        );

        // Fast path: nothing changed
        if (toCreate.length === 0 && toUpdate.length === 0) {
            const newCache = buildSyncCache(syncData);
            lastSyncTime = now;
            await browserAPI.storage.local.set({
                syncCache: newCache,
                lastSync: new Date().toISOString(),
                lastSyncResult: {
                    created: 0,
                    updated: 0,
                    skipped: unchanged.length,
                    courses: syncData.courses.length,
                },
            });
            console.log(
                `[CanvasNotion] Nothing changed. ${unchanged.length} assignments up to date.`
            );
            return {
                created: 0,
                updated: 0,
                skipped: unchanged.length,
                courses: syncData.courses.length,
            };
        }

        // Step 2: Query Notion pages for page IDs (needed for updates and dedup on creates)
        console.log("[CanvasNotion] Querying existing pages...");
        const existingPages = await client.queryAllPages(databaseId);

        const canvasIdToPageId = new Map();
        for (const page of existingPages) {
            const canvasIdProp = page.properties["Canvas ID"];
            if (canvasIdProp?.rich_text?.[0]?.plain_text) {
                canvasIdToPageId.set(
                    canvasIdProp.rich_text[0].plain_text,
                    page.id
                );
            }
        }

        console.log(
            `[CanvasNotion] Found ${canvasIdToPageId.size} existing entries in Notion`
        );

        // Step 3: Push only changed assignments
        let created = 0;
        let updated = 0;
        let failed = 0;
        const syncTimestamp = new Date().toISOString();

        console.log(
            `[CanvasNotion] Processing ${toCreate.length} creates and ${toUpdate.length} updates...`
        );

        for (const item of toCreate) {
            try {
                const properties = buildNotionProperties(
                    item.course,
                    item.assignment,
                    item.canvasId,
                    syncTimestamp
                );
                const existingPageId = canvasIdToPageId.get(item.canvasId);
                if (existingPageId) {
                    await client.updatePage(existingPageId, properties);
                    updated++;
                } else {
                    await client.createPage(databaseId, properties);
                    created++;
                }
            } catch (err) {
                console.error(
                    `[CanvasNotion] Failed to create assignment "${item.assignment.name}":`,
                    err.message
                );
                failed++;
            }
        }

        for (const item of toUpdate) {
            try {
                const properties = buildNotionProperties(
                    item.course,
                    item.assignment,
                    item.canvasId,
                    syncTimestamp
                );
                const existingPageId = canvasIdToPageId.get(item.canvasId);
                if (existingPageId) {
                    await client.updatePage(existingPageId, properties);
                    updated++;
                } else {
                    await client.createPage(databaseId, properties);
                    created++;
                }
            } catch (err) {
                console.error(
                    `[CanvasNotion] Failed to update assignment "${item.assignment.name}":`,
                    err.message
                );
                failed++;
            }
        }

        // Step 4: Save cache and results
        const newCache = buildSyncCache(syncData);
        lastSyncTime = now;
        await browserAPI.storage.local.set({
            syncCache: newCache,
            lastSync: new Date().toISOString(),
            lastSyncResult: {
                created,
                updated,
                skipped: unchanged.length,
                courses: syncData.courses.length,
            },
        });

        console.log(
            `[CanvasNotion] Sync complete: ${created} created, ${updated} updated, ${failed} failed, ${unchanged.length} unchanged across ${syncData.courses.length} courses`
        );

        return {
            created,
            updated,
            skipped: unchanged.length,
            courses: syncData.courses.length,
        };
    } catch (err) {
        console.error("[CanvasNotion] Sync error:", err);
        return { error: err.message };
    }
}

// ---------------------------------------------------------------------------
// Build Notion properties object for an assignment
// ---------------------------------------------------------------------------
function buildNotionProperties(course, assignment, canvasId, syncTimestamp) {
    const statusMap = {
        unsubmitted: "Unsubmitted",
        submitted: "Submitted",
        graded: "Graded",
        late: "Late",
        missing: "Missing",
    };

    const props = {
        "Assignment Name": {
            title: [{ type: "text", text: { content: assignment.name } }],
        },
        Course: {
            select: { name: course.name },
        },
        "Course Code": {
            rich_text: [
                { type: "text", text: { content: course.course_code || "" } },
            ],
        },
        Points: {
            number: assignment.points_possible || 0,
        },
        Status: {
            select: {
                name: statusMap[assignment.submission?.status] || "Unsubmitted",
            },
        },
        "Canvas ID": {
            rich_text: [{ type: "text", text: { content: canvasId } }],
        },
        "Last Synced": {
            date: { start: syncTimestamp },
        },
    };

    if (assignment.due_at) {
        props["Due Date"] = { date: { start: assignment.due_at } };
    }

    if (assignment.html_url) {
        props["Canvas URL"] = { url: assignment.html_url };
    }

    return props;
}

// ---------------------------------------------------------------------------
// Canvas API token-based background sync (fallback when no Canvas tab open)
// ---------------------------------------------------------------------------
function parseLinkHeaderNext(header) {
    if (!header) return null;
    const parts = header.split(",");
    for (const part of parts) {
        const match = part.match(/<([^>]+)>;\s*rel="next"/);
        if (match) return match[1];
    }
    return null;
}

async function canvasFetchFromBackground(baseUrl, token, path) {
    let allResults = [];
    let url = path.startsWith("http") ? path : `${baseUrl}${path}`;
    const seen = new Set();
    const MAX_PAGES = 20;
    let page = 0;

    while (url) {
        if (seen.has(url) || page >= MAX_PAGES) break;
        seen.add(url);
        page++;

        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
            throw new Error(`Canvas API ${response.status} for ${url}`);
        }

        const data = await response.json();
        if (!Array.isArray(data)) break;
        allResults = allResults.concat(data);

        const linkHeader = response.headers.get("Link");
        url = parseLinkHeaderNext(linkHeader);
    }

    return allResults;
}

function mapSubmissionBackground(sub) {
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

async function syncFromBackground(baseUrl, token) {
    let { selectedCourseIds, discoveredCourses } = await browserAPI.storage.local.get([
        "selectedCourseIds",
        "discoveredCourses",
    ]);

    if (!selectedCourseIds || selectedCourseIds.length === 0) {
        return { error: "No courses selected" };
    }

    // Discover courses if not already done
    if (!discoveredCourses || discoveredCourses.length === 0) {
        console.log("[CanvasNotion] Background: discovering courses...");
        const courses = await canvasFetchFromBackground(
            baseUrl,
            token,
            "/api/v1/courses?enrollment_state=active&per_page=100"
        );
        discoveredCourses = courses
            .filter((c) => c.id && c.name)
            .map((c) => ({
                id: String(c.id),
                name: c.name,
                course_code: c.course_code || "",
            }));
        await browserAPI.storage.local.set({
            discoveredCourses,
            coursesDiscovered: true,
        });
    }

    const selectedSet = new Set(selectedCourseIds);
    const syncData = {
        institution_domain: new URL(baseUrl).hostname,
        canvas_user_id: null,
        courses: [],
    };

    console.log(
        `[CanvasNotion] Background: fetching assignments for ${selectedCourseIds.length} courses...`
    );

    for (const course of discoveredCourses) {
        if (!selectedSet.has(course.id)) continue;

        let assignments = [];
        try {
            assignments = await canvasFetchFromBackground(
                baseUrl,
                token,
                `/api/v1/courses/${course.id}/assignments?include[]=submission&per_page=100`
            );
        } catch (err) {
            console.warn(
                `[CanvasNotion] Background: skipping ${course.name}: ${err.message}`
            );
            continue;
        }

        if (!Array.isArray(assignments)) continue;

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
                submission: mapSubmissionBackground(a.submission),
            })),
        });
    }

    const totalAssignments = syncData.courses.reduce(
        (n, c) => n + c.assignments.length,
        0
    );
    console.log(
        `[CanvasNotion] Background: ${syncData.courses.length} courses, ${totalAssignments} assignments`
    );

    return handleNotionSync(syncData);
}

async function attemptBackgroundSync() {
    const { canvasApiToken, canvasBaseUrl } = await browserAPI.storage.local.get([
        "canvasApiToken",
        "canvasBaseUrl",
    ]);

    if (!canvasApiToken || !canvasBaseUrl) {
        console.log(
            "[CanvasNotion] Periodic sync skipped — no Canvas tab and no API token configured"
        );
        return;
    }

    console.log("[CanvasNotion] No Canvas tab open, using API token for background sync");
    lastSyncTime = 0;

    try {
        const result = await syncFromBackground(canvasBaseUrl, canvasApiToken);
        console.log("[CanvasNotion] Background sync result:", JSON.stringify(result));
    } catch (err) {
        console.error("[CanvasNotion] Background sync error:", err);
    }
}
