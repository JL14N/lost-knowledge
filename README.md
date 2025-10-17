# Lost Knowledge

A small Three.js demo rendering a spiral stair/tower scene with first-person controls.

Contents:
- `index.html` — main page
- `main.js` — app script (Three.js scene, controls, helix constraints)
- `assets/` — models and textures

Notes:
- The project is intended to be served via a static HTTP server (e.g., `npx http-server` or `python -m http.server`).
- Requires a modern browser that supports ES modules.

Development
-----------
Open the folder and run a static server. Example:

```bash
# from project root
npx http-server -c-1 .  # or
python -m http.server 8000
```

License: MIT
