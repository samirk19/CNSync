const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// Simple rate limiter: ~3 requests per second
class RateLimiter {
    constructor(maxPerSecond = 3) {
        this.interval = 1000 / maxPerSecond;
        this.lastCall = 0;
    }
    async wait() {
        const now = Date.now();
        const elapsed = now - this.lastCall;
        if (elapsed < this.interval) {
            await new Promise((r) => setTimeout(r, this.interval - elapsed));
        }
        this.lastCall = Date.now();
    }
}

export class NotionClient {
    constructor(accessToken) {
        this.token = accessToken;
        this.headers = {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "Notion-Version": NOTION_VERSION,
        };
        this.rateLimiter = new RateLimiter(3);
    }

    async request(method, path, body = null, retries = 2) {
        await this.rateLimiter.wait();

        const opts = { method, headers: this.headers };
        if (body) opts.body = JSON.stringify(body);

        const resp = await fetch(`${NOTION_API}${path}`, opts);

        // Retry on rate limit or transient errors
        if ((resp.status === 429 || resp.status >= 500) && retries > 0) {
            const retryAfter = parseInt(resp.headers.get("Retry-After") || "1", 10);
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
            return this.request(method, path, body, retries - 1);
        }

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(
                `Notion API ${resp.status}: ${err.message || resp.statusText}`
            );
        }
        return resp.json();
    }

    // Search for accessible pages (for parent page picker)
    async searchPages() {
        return this.request("POST", "/search", {
            filter: { value: "page", property: "object" },
            sort: { direction: "descending", timestamp: "last_edited_time" },
        });
    }

    // Create the assignments database under a parent page
    async createDatabase(parentPageId) {
        return this.request("POST", "/databases", {
            parent: { type: "page_id", page_id: parentPageId },
            title: [{ type: "text", text: { content: "Canvas Assignments" } }],
            properties: {
                "Name": { title: {} },
                Course: {
                    select: { options: [] },
                },
                "Due Date": { date: {} },
                Status: {
                    select: {
                        options: [
                            { name: "Not started", color: "gray" },
                            { name: "In progress", color: "blue" },
                            { name: "Submitted", color: "green" },
                        ],
                    },
                },
                Type: {
                    select: { options: [
                        { name: "Homework", color: "blue" },
                        { name: "Quiz", color: "pink" },
                        { name: "Project", color: "purple" },
                        { name: "Exam Practice", color: "orange" },
                        { name: "Exam", color: "yellow" },
                        { name: "Essay", color: "brown"},
                        { name: "Lab", color: "green" },
                        { name: "Notes", color: "gray" },
                        { name: "Task", color: "red" },
                        { name: "Lab Report", color: "green" },
                        { name: "Survey", color: "default" },
                        { name: "Speech", color: "brown" },
                        { name: "Discussion Post", color: "yellow" },
                        { name: "Extra Credit", color: "red" },
                    ] },
                }
            },
        });
    }

    // Query all pages in the database to build Canvas ID -> Page ID map
    async queryAllPages(databaseId) {
        const pages = [];
        let cursor = undefined;
        do {
            const body = { page_size: 100 };
            if (cursor) body.start_cursor = cursor;
            const result = await this.request(
                "POST",
                `/databases/${databaseId}/query`,
                body
            );
            pages.push(...result.results);
            cursor = result.has_more ? result.next_cursor : undefined;
        } while (cursor);
        return pages;
    }

    // Create a page (assignment entry)
    async createPage(databaseId, properties) {
        return this.request("POST", "/pages", {
            parent: { type: "database_id", database_id: databaseId },
            properties,
        });
    }

    // Update a page
    async updatePage(pageId, properties) {
        return this.request("PATCH", `/pages/${pageId}`, { properties });
    }

    // Validate token by fetching the bot user
    async validateToken() {
        return this.request("GET", "/users/me");
    }
}
