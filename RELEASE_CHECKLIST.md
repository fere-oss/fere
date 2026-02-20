# Release Checklist

Use this checklist before publishing a new version of Fere.

## Pre-Release

### Code Quality
- [ ] All tests pass: `npm run test:node`
- [ ] TypeScript compiles cleanly: `npx tsc --noEmit`
- [ ] No lint errors
- [ ] Integration tests pass: `sh test/start-all.sh`

### Version
- [ ] Bump `version` in `package.json`
- [ ] Update `PRIVACY.md` "Last updated" date if data practices changed
- [ ] Update `SECURITY.md` supported versions table

### Security Review
- [ ] No secrets, API keys, or credentials in committed code (check `.env` files are in `.gitignore`)
- [ ] PostHog API key is appropriate for the release environment
- [ ] CSP headers are set to production mode (no `unsafe-eval`)
- [ ] Request history redaction covers all sensitive header/body patterns
- [ ] Network policy defaults are appropriate for the target audience
- [ ] Electron sandbox, context isolation, and node integration settings are correct
- [ ] No new `shell.openExternal` calls without URL validation
- [ ] Dependencies audited: `npm audit`

### Privacy Review
- [ ] No new data collection without updating `PRIVACY.md`
- [ ] Analytics events are documented in `PRIVACY.md`
- [ ] No PII (emails, names, IPs) in analytics payloads
- [ ] Local file storage paths documented

### Legal
- [ ] `LICENSE` file is present and correct
- [ ] `SECURITY.md` contact information is current
- [ ] Third-party license compliance checked (run `npx license-checker --summary`)

## Build

- [ ] Clean install: `rm -rf node_modules && npm install`
- [ ] Production React build succeeds: `npm run build`
- [ ] macOS DMG builds successfully: `npm run electron:build:mac`
- [ ] App launches from the built DMG without errors
- [ ] Code signing is configured (for distribution outside the Mac App Store)
- [ ] Notarization is configured (required for macOS Gatekeeper)

## Smoke Test the Built App

- [ ] App launches and shows the service graph
- [ ] Process/port monitoring works (services appear)
- [ ] Docker tab works when Docker Desktop is running
- [ ] API tester can send a request and display a response
- [ ] Request history saves, loads, and clears
- [ ] Network policy toggle works (local vs. public)
- [ ] Container log streaming works
- [ ] Database tab connects and queries a container DB
- [ ] Alert notifications fire on service crash/recovery
- [ ] Settings persist across app restart

## Distribution

- [ ] Remove `"private": true` from `package.json` when ready for npm/public distribution
- [ ] Tag the release in git: `git tag -a v0.x.x -m "Release v0.x.x"`
- [ ] Create GitHub release with changelog and attach DMG artifact
- [ ] Verify download link works and DMG installs correctly
