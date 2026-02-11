import CONFIG from "./config.js";

/**
 * Add a page (row) to the Notion database.
 *
 * For TestDB the schema is:
 *   - Name  (title property)
 *   - Date  (date property)
 */
export async function addRowToTestDB({ name, date }) {
  const { NOTION_API_KEY, TESTDB_ID } = CONFIG;

  if (!NOTION_API_KEY || !TESTDB_ID) {
    throw new Error(
      "Missing NOTION_API_KEY or TESTDB_ID. Open config.js and fill them in."
    );
  }

  const body = {
    parent: { database_id: TESTDB_ID },
    properties: {
      Name: {
        title: [{ text: { content: name } }],
      },
      Date: {
        date: { start: date },
      },
    },
  };

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `Notion API error: ${res.status}`);
  }

  return res.json();
}
