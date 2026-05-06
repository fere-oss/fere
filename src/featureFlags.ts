/**
 * Feature flags for Team and Org tier features.
 *
 * Core features are always enabled. Team/Org flags default to false so the
 * open-source build is identical to the free tier.
 */

export function isTeamMode(): boolean {
  return process.env.REACT_APP_FERE_TEAM_MODE === "true";
}

export function isOrgMode(): boolean {
  return process.env.REACT_APP_FERE_ORG_MODE === "true";
}
