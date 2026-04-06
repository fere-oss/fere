Drop custom PNG step icons in this folder to override the Sentinel chat step icons.

Expected filenames:
- `folder.png`
- `terminal.png`
- `search.png`
- `docker-box.png`
- `file.png`

Notes:
- Square PNGs work best.
- The UI renders them at about 12x12 CSS pixels, so provide crisp small icons or higher-resolution assets with transparent backgrounds.
- If a file is missing or fails to load, Sentinel falls back to the built-in SVG icon for that step type.
