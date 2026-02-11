import { addRowToTestDB } from "./notion.js";

const btn = document.getElementById("send-btn");
const statusEl = document.getElementById("status");

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  showStatus("Sending to Notion...", "loading");

  try {
    const sampleRow = {
      name: "Sample Assignment",
      date: new Date().toISOString().split("T")[0], // today's date YYYY-MM-DD
    };

    await addRowToTestDB(sampleRow);
    showStatus("Row added to TestDB!", "success");
  } catch (err) {
    showStatus(err.message, "error");
  } finally {
    btn.disabled = false;
  }
});
