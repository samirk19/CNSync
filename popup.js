const browserAPI = typeof browser !== "undefined" ? browser : chrome;

let selectedPageId = null;

// ---------------------------------------------------------------------------
// Initialization — determine which state to show
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
    const { notionToken, databaseId, lastSync, lastSyncResult, botName, selectedCourseIds, canvasApiToken, canvasBaseUrl } =
        await browserAPI.storage.local.get([
            "notionToken",
            "databaseId",
            "lastSync",
            "lastSyncResult",
            "botName",
            "selectedCourseIds",
            "canvasApiToken",
            "canvasBaseUrl",
        ]);

    if (!notionToken) {
        showSection("section-auth");
    } else if (!databaseId) {
        showSection("section-setup");
        loadPages();
    } else {
        showSection("section-main");
        showMainScreen(botName, lastSync, lastSyncResult);
        renderCourses();
        renderAccounts();
        renderCanvasTokenUI(canvasApiToken, canvasBaseUrl);
    }
});

function showSection(id) {
    document.getElementById("section-auth").classList.add("hidden");
    document.getElementById("section-setup").classList.add("hidden");
    document.getElementById("section-main").classList.add("hidden");
    document.getElementById(id).classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// State 1: Token input
// ---------------------------------------------------------------------------
document.getElementById("btn-connect").addEventListener("click", async () => {
    const btn = document.getElementById("btn-connect");
    const input = document.getElementById("input-token");
    const errorEl = document.getElementById("auth-error");
    const token = input.value.trim();

    if (!token) {
        showError(errorEl, "Please enter a token");
        return;
    }

    btn.textContent = "Connecting...";
    btn.disabled = true;
    errorEl.classList.add("hidden");

    const result = await browserAPI.runtime.sendMessage({
        type: "VALIDATE_TOKEN",
        token,
    });

    if (result.success) {
        await browserAPI.storage.local.set({
            notionToken: token,
            botName: result.botName,
        });
        showSection("section-setup");
        loadPages();
    } else {
        showError(errorEl, `Invalid token: ${result.error}`);
    }

    btn.textContent = "Connect";
    btn.disabled = false;
});

document.getElementById("link-integrations").addEventListener("click", (e) => {
    e.preventDefault();
    browserAPI.tabs.create({ url: "https://www.notion.so/my-integrations" });
});

// ---------------------------------------------------------------------------
// State 2: Page picker & database creation
// ---------------------------------------------------------------------------
let allPages = []; // Store all pages for filtering

async function loadPages() {
    const list = document.getElementById("page-list");
    const errorEl = document.getElementById("setup-error");
    const searchInput = document.getElementById("page-search");
    list.innerHTML = '<div style="padding:8px;color:#888;font-size:12px;">Loading pages...</div>';
    errorEl.classList.add("hidden");
    selectedPageId = null;
    document.getElementById("btn-create-db").disabled = true;

    const result = await browserAPI.runtime.sendMessage({ type: "GET_PAGES" });

    if (result.error) {
        list.innerHTML = "";
        showError(errorEl, result.error);
        return;
    }

    list.innerHTML = "";
    if (!result.pages || result.pages.length === 0) {
        list.innerHTML =
            '<div style="padding:8px;color:#888;font-size:12px;">No pages found. Make sure you\'ve shared a page with your integration.</div>';
        return;
    }

    allPages = result.pages;
    renderPages(allPages);

    // Set up search listener
    searchInput.value = "";
    searchInput.oninput = (e) => {
        const query = e.target.value.toLowerCase().trim();
        if (!query) {
            renderPages(allPages);
        } else {
            const filtered = allPages.filter((page) =>
                page.title.toLowerCase().includes(query)
            );
            renderPages(filtered);
        }
    };
}

function renderPages(pages) {
    const list = document.getElementById("page-list");
    list.innerHTML = "";

    if (pages.length === 0) {
        list.innerHTML =
            '<div style="padding:8px;color:#888;font-size:12px;">No matching pages found.</div>';
        return;
    }

    for (const page of pages) {
        const item = document.createElement("div");
        item.className = "page-item";
        item.dataset.pageId = page.id;
        item.innerHTML = `
            <span class="page-icon">${page.icon || "📄"}</span>
            <span class="page-title">${escapeHtml(page.title)}</span>
        `;
        item.addEventListener("click", () => {
            list.querySelectorAll(".page-item").forEach((el) =>
                el.classList.remove("selected")
            );
            item.classList.add("selected");
            selectedPageId = page.id;
            document.getElementById("btn-create-db").disabled = false;
        });
        list.appendChild(item);
    }
}

document.getElementById("btn-refresh-pages").addEventListener("click", loadPages);

document.getElementById("btn-create-db").addEventListener("click", async () => {
    if (!selectedPageId) return;

    const btn = document.getElementById("btn-create-db");
    const errorEl = document.getElementById("setup-error");
    btn.textContent = "Creating...";
    btn.disabled = true;
    errorEl.classList.add("hidden");

    const result = await browserAPI.runtime.sendMessage({
        type: "SETUP_DATABASE",
        parentPageId: selectedPageId,
    });

    if (result.success) {
        const { botName } = await browserAPI.storage.local.get("botName");
        showSection("section-main");
        showMainScreen(botName, null, null);
    } else {
        showError(errorEl, result.error);
        btn.textContent = "Create Database";
        btn.disabled = false;
    }
});

// ---------------------------------------------------------------------------
// State 3: Main screen — sync controls, courses, accounts
// ---------------------------------------------------------------------------
function showMainScreen(botName, lastSync, lastSyncResult) {
    document.getElementById("display-integration").textContent =
        botName || "Notion Integration";
    document.getElementById("display-sync").textContent = lastSync
        ? `Last sync: ${new Date(lastSync).toLocaleString()}`
        : "Not synced yet";

    if (lastSyncResult) {
        document.getElementById("display-result").textContent =
            formatSyncResult(lastSyncResult);
    }
}

function formatSyncResult(r) {
    const parts = [];
    if (r.created) parts.push(`${r.created} created`);
    if (r.updated) parts.push(`${r.updated} updated`);
    if (r.skipped) parts.push(`${r.skipped} unchanged`);
    if (parts.length === 0) parts.push("0 changes");
    return `${parts.join(", ")} across ${r.courses || 0} courses`;
}

// Sync Now button
document.getElementById("btn-sync").addEventListener("click", async () => {
    const btn = document.getElementById("btn-sync");
    btn.textContent = "Syncing...";
    btn.disabled = true;

    const result = await browserAPI.runtime.sendMessage({ type: "MANUAL_SYNC" });

    if (result?.error) {
        btn.textContent = `Error: ${result.error}`;
    } else if (result?.skipped) {
        btn.textContent = "Recently synced";
    } else {
        btn.textContent = "Synced!";
        const { lastSync, lastSyncResult } = await browserAPI.storage.local.get([
            "lastSync",
            "lastSyncResult",
        ]);
        document.getElementById("display-sync").textContent = `Last sync: ${new Date(
            lastSync
        ).toLocaleString()}`;
        if (lastSyncResult) {
            document.getElementById("display-result").textContent =
                formatSyncResult(lastSyncResult);
        }
        // Refresh course list after sync
        await renderCourses();
    }

    setTimeout(async () => {
        // Restore button state based on current selection
        const { selectedCourseIds } = await browserAPI.storage.local.get("selectedCourseIds");
        const count = (selectedCourseIds || []).length;
        updateSyncButton(count);
    }, 2000);
});

// Force Sync button (clears cache)
document.getElementById("btn-force-sync").addEventListener("click", async () => {
    const btn = document.getElementById("btn-force-sync");
    const syncBtn = document.getElementById("btn-sync");

    btn.textContent = "Clearing cache...";
    btn.disabled = true;
    syncBtn.disabled = true;

    // Clear the sync cache
    await browserAPI.storage.local.remove("syncCache");

    btn.textContent = "Syncing...";
    const result = await browserAPI.runtime.sendMessage({ type: "MANUAL_SYNC" });

    if (result?.error) {
        btn.textContent = `Error: ${result.error}`;
    } else {
        btn.textContent = "Force synced!";
        const { lastSync, lastSyncResult } = await browserAPI.storage.local.get([
            "lastSync",
            "lastSyncResult",
        ]);
        document.getElementById("display-sync").textContent = `Last sync: ${new Date(
            lastSync
        ).toLocaleString()}`;
        if (lastSyncResult) {
            document.getElementById("display-result").textContent =
                formatSyncResult(lastSyncResult);
        }
        await renderCourses();
    }

    setTimeout(async () => {
        const { selectedCourseIds } = await browserAPI.storage.local.get("selectedCourseIds");
        const count = (selectedCourseIds || []).length;
        updateSyncButton(count);
        btn.textContent = "Force Full Sync (Clear Cache)";
        btn.disabled = count === 0;
    }, 2000);
});

// Change Database — go back to page picker
document.getElementById("btn-change-db").addEventListener("click", async () => {
    await browserAPI.storage.local.remove(["databaseId", "parentPageId", "syncCache"]);
    showSection("section-setup");
    loadPages();
});

// Disconnect — clear everything
document.getElementById("btn-disconnect").addEventListener("click", async () => {
    await browserAPI.storage.local.clear();
    showSection("section-auth");
});

// ---------------------------------------------------------------------------
// Course selection UI (opt-in — nothing syncs until user selects courses)
// ---------------------------------------------------------------------------
async function renderCourses() {
    const { discoveredCourses, selectedCourseIds } =
        await browserAPI.storage.local.get(["discoveredCourses", "selectedCourseIds"]);
    const courses = discoveredCourses || [];
    const selected = new Set(selectedCourseIds || []);
    const section = document.getElementById("courses-section");
    const list = document.getElementById("courses-list");
    const noCoursesMsg = document.getElementById("no-courses-msg");
    const prompt = document.getElementById("courses-prompt");

    if (courses.length === 0) {
        section.classList.add("hidden");
        noCoursesMsg.classList.remove("hidden");
        updateSyncButton(0);
        return;
    }

    section.classList.remove("hidden");
    noCoursesMsg.classList.add("hidden");

    // Show prompt only if no courses selected yet
    if (selected.size === 0) {
        prompt.classList.remove("hidden");
    } else {
        prompt.classList.add("hidden");
    }

    list.innerHTML = "";

    for (const course of courses) {
        const item = document.createElement("div");
        item.className = "course-item";
        const isSelected = selected.has(course.id);
        item.innerHTML = `
            <div class="course-info">
                <div class="course-name">${escapeHtml(course.name)}</div>
                <div class="course-code">${escapeHtml(course.course_code)}</div>
            </div>
            <label class="toggle">
                <input type="checkbox" data-course-id="${escapeHtml(course.id)}" ${isSelected ? "checked" : ""}>
                <span class="slider"></span>
            </label>
        `;
        list.appendChild(item);
    }

    updateSyncButton(selected.size);

    // Toggle handler — opt-in: checked = selected for sync
    list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener("change", async () => {
            const { selectedCourseIds } =
                await browserAPI.storage.local.get("selectedCourseIds");
            const selected = new Set(selectedCourseIds || []);
            if (cb.checked) {
                selected.add(cb.dataset.courseId);
            } else {
                selected.delete(cb.dataset.courseId);
            }
            await browserAPI.storage.local.set({
                selectedCourseIds: [...selected],
            });
            updateSyncButton(selected.size);

            // Hide prompt once at least one course is selected
            const prompt = document.getElementById("courses-prompt");
            if (selected.size > 0) {
                prompt.classList.add("hidden");
            } else {
                prompt.classList.remove("hidden");
            }
        });
    });
}

function updateSyncButton(selectedCount) {
    const btn = document.getElementById("btn-sync");
    const forceBtn = document.getElementById("btn-force-sync");
    if (selectedCount > 0) {
        btn.disabled = false;
        btn.textContent = "Sync Now";
        forceBtn.disabled = false;
    } else {
        btn.disabled = true;
        btn.textContent = "Select courses to sync";
        forceBtn.disabled = true;
    }
}

// ---------------------------------------------------------------------------
// Canvas accounts management — same pattern as StudyLink
// ---------------------------------------------------------------------------
async function renderAccounts() {
    const stored = await browserAPI.storage.local.get("knownAccounts");
    const accounts = stored.knownAccounts || [];
    const section = document.getElementById("accounts-section");
    const list = document.getElementById("accounts-list");

    if (accounts.length === 0) {
        section.classList.add("hidden");
        return;
    }

    section.classList.remove("hidden");
    list.innerHTML = "";

    accounts.forEach((acct, idx) => {
        const item = document.createElement("div");
        item.className = "account-item";

        const shortDomain = acct.domain
            .replace(".instructure.com", "")
            .replace("canvas.", "");
        const statusClass = acct.status === "allowed" ? "allowed" : "denied";
        const statusLabel = acct.status === "allowed" ? "Allowed" : "Denied";
        const toggleLabel = acct.status === "allowed" ? "Deny" : "Allow";
        const toggleClass =
            acct.status === "allowed"
                ? "btn-danger btn-small"
                : "btn-primary btn-small";

        item.innerHTML = `
            <div class="account-info">
                <div class="account-domain">${escapeHtml(shortDomain)}</div>
                <div class="account-id">ID: ${escapeHtml(acct.canvasUserId)}</div>
            </div>
            <span class="account-status-badge ${statusClass}">${statusLabel}</span>
            <div class="account-actions">
                <button class="btn-toggle ${toggleClass}" data-idx="${idx}">${toggleLabel}</button>
                <button class="btn-remove btn-danger btn-small" data-idx="${idx}">Remove</button>
            </div>
        `;
        list.appendChild(item);
    });

    // Toggle allow/deny
    list.querySelectorAll(".btn-toggle").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const idx = parseInt(btn.dataset.idx);
            const stored = await browserAPI.storage.local.get("knownAccounts");
            const accounts = stored.knownAccounts || [];
            if (accounts[idx]) {
                accounts[idx].status =
                    accounts[idx].status === "allowed" ? "denied" : "allowed";
                await browserAPI.storage.local.set({ knownAccounts: accounts });
                renderAccounts();
            }
        });
    });

    // Remove account
    list.querySelectorAll(".btn-remove").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const idx = parseInt(btn.dataset.idx);
            const stored = await browserAPI.storage.local.get("knownAccounts");
            const accounts = stored.knownAccounts || [];
            accounts.splice(idx, 1);
            await browserAPI.storage.local.set({ knownAccounts: accounts });
            renderAccounts();
        });
    });
}

// ---------------------------------------------------------------------------
// Canvas API token (optional — enables background sync without Canvas tab)
// ---------------------------------------------------------------------------
function renderCanvasTokenUI(token, baseUrl) {
    const section = document.getElementById("canvas-token-section");
    const savedInfo = document.getElementById("canvas-token-saved");
    const form = document.getElementById("canvas-token-form");
    const urlInput = document.getElementById("input-canvas-url");
    const tokenInput = document.getElementById("input-canvas-token");
    const btnClear = document.getElementById("btn-clear-canvas-token");

    if (token && baseUrl) {
        savedInfo.classList.remove("hidden");
        form.classList.add("hidden");
        btnClear.classList.remove("hidden");
        const shortUrl = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
        document.getElementById("canvas-token-domain").textContent = shortUrl;
    } else {
        savedInfo.classList.add("hidden");
        form.classList.remove("hidden");
        btnClear.classList.add("hidden");
        urlInput.value = baseUrl || "";
        tokenInput.value = "";
    }
}

document.getElementById("btn-save-canvas-token").addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-canvas-token");
    const errorEl = document.getElementById("canvas-token-error");
    const urlInput = document.getElementById("input-canvas-url");
    const tokenInput = document.getElementById("input-canvas-token");

    let baseUrl = urlInput.value.trim().replace(/\/+$/, "");
    const token = tokenInput.value.trim();

    if (!baseUrl || !token) {
        showError(errorEl, "Both URL and token are required");
        return;
    }

    // Add https if missing
    if (!baseUrl.startsWith("http")) {
        baseUrl = "https://" + baseUrl;
    }

    btn.textContent = "Validating...";
    btn.disabled = true;
    errorEl.classList.add("hidden");

    try {
        const resp = await fetch(`${baseUrl}/api/v1/users/self`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
            throw new Error(`Canvas returned ${resp.status}`);
        }
        await resp.json(); // Validate JSON response

        await browserAPI.storage.local.set({
            canvasApiToken: token,
            canvasBaseUrl: baseUrl,
        });
        renderCanvasTokenUI(token, baseUrl);
    } catch (err) {
        showError(errorEl, `Invalid: ${err.message}`);
    }

    btn.textContent = "Save";
    btn.disabled = false;
});

document.getElementById("btn-clear-canvas-token").addEventListener("click", async () => {
    await browserAPI.storage.local.remove(["canvasApiToken", "canvasBaseUrl"]);
    renderCanvasTokenUI(null, null);
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
