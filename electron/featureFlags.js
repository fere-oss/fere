/**
 * Feature flags for Team and Org tier features.
 *
 * Core features (service map, Sentinel, Docker, database, API tester) are always
 * enabled and require no flag. Team/Org features read from environment variables
 * set by the cloud distribution layer — they default to false so the open-source
 * build is identical to the free tier.
 */

function isTeamMode() {
  return process.env.FERE_TEAM_MODE === "true";
}

function isOrgMode() {
  return process.env.FERE_ORG_MODE === "true";
}

module.exports = { isTeamMode, isOrgMode };
