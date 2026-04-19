# Azure Pipelines Log Viewer

A small browser app for reading Azure Pipelines log ZIP files.

Drop in a downloaded log archive and browse stages, jobs, and tasks on the left while reading formatted logs on the right.

Give it a try: https://chrisblankde.github.io/BuildLogViewer/

## Why this exists

Azure DevOps logs are often easier to inspect with a focused viewer. This tool is static, lightweight, and runs entirely in the browser.

## What it can do

- Upload log ZIP files by drag-and-drop or file picker
- Show pipeline structure (stage/job/task) in a collapsible tree
- Highlight errors, warnings, timestamps, and success messages
- Collapse/expand grouped blocks (`##[group]` / `##[endgroup]`)
- Search inside the active log with next/previous match navigation
- Toggle timestamp visibility and line wrapping
- Show simple task status indicators (error/warning/success)

## Privacy

All parsing happens client-side. No backend. No uploads.

## Quick start

### Run locally

From the repository root, open `index.html` in your browser.

If your browser blocks local file behavior, run a tiny static server:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

### Use on GitHub Pages

Serve the repository root with GitHub Pages.

Typical URL:

`https://<your-user-or-org>.github.io/BuildLogViewer/`

## Getting Azure Pipelines logs

From Azure DevOps UI:

1. Open a pipeline run
2. Open the `...` (More actions) menu
3. Click **Download logs**

Use that ZIP file directly in this viewer.

## Development notes

- No build step required
- No framework dependency
- Quick syntax check:

```bash
node --check app.js
```

## Known limitations

- Very large ZIPs/logs can be slow in the browser
- `.txt` logs are expected
- Structured JSON logs are shown as plain text

## Contributing

Issues and PRs are welcome.
