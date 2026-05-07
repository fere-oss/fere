/**
 * GitHub Gist Publisher Service
 * Creates and updates secret GitHub Gists to host shared graph snapshots.
 */

const https = require("https");

const GITHUB_API_HOST = "api.github.com";
const GIST_FILENAME = "index.html";

/**
 * Make a GitHub API request.
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {string} token - GitHub personal access token
 * @param {object|null} body - Request body
 * @returns {Promise<object>} Parsed JSON response
 */
function githubRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: GITHUB_API_HOST,
      path,
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Fere-App/1.0",
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const message = parsed.message || `HTTP ${res.statusCode}`;
            reject(new Error(`GitHub API error: ${message}`));
          }
        } catch {
          reject(new Error(`GitHub API parse error (status ${res.statusCode})`));
        }
      });
    });

    req.on("error", (err) => reject(new Error(`Network error: ${err.message}`)));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Request timed out after 30 seconds"));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Create a new secret GitHub Gist with the HTML content.
 * @param {string} htmlContent - The full HTML string to publish
 * @param {string} token - GitHub personal access token (gist scope required)
 * @returns {Promise<{ gistId: string, rawUrl: string, htmlUrl: string }>}
 */
async function createGist(htmlContent, token) {
  const body = {
    description: "Fere — Service Map Snapshot",
    public: false,
    files: {
      [GIST_FILENAME]: { content: htmlContent },
    },
  };

  const gist = await githubRequest("POST", "/gists", token, body);

  const rawUrl = gist.files?.[GIST_FILENAME]?.raw_url;
  if (!rawUrl) throw new Error("GitHub did not return a raw URL for the file");

  return {
    gistId: gist.id,
    rawUrl,
    htmlUrl: gist.html_url,
  };
}

/**
 * Update an existing GitHub Gist with new HTML content.
 * @param {string} gistId - The Gist ID to update
 * @param {string} htmlContent - New HTML content
 * @param {string} token - GitHub personal access token
 * @returns {Promise<{ gistId: string, rawUrl: string, htmlUrl: string }>}
 */
async function updateGist(gistId, htmlContent, token) {
  const body = {
    description: "Fere — Service Map Snapshot (updated)",
    files: {
      [GIST_FILENAME]: { content: htmlContent },
    },
  };

  const gist = await githubRequest("PATCH", `/gists/${gistId}`, token, body);

  // GitHub rotates raw_url on each update — use the fresh one
  const rawUrl = gist.files?.[GIST_FILENAME]?.raw_url;
  if (!rawUrl) throw new Error("GitHub did not return a raw URL for the file");

  return {
    gistId: gist.id,
    rawUrl,
    htmlUrl: gist.html_url,
  };
}

/**
 * Build the htmlpreview.github.io viewer URL from a raw Gist URL.
 * @param {string} rawUrl
 * @returns {string}
 */
function buildPreviewUrl(rawUrl) {
  return `https://htmlpreview.github.io/?${rawUrl}`;
}

module.exports = { createGist, updateGist, buildPreviewUrl };
