# Build Log Viewer

A browser app for reading Azure Pipelines and GitHub Actions log ZIP files.

Drop in a downloaded log archive and browse jobs and tasks on the left while reading formatted logs on the right.

Give it a try: https://chrisblankde.github.io/BuildLogViewer/

## What it can do

- Upload log ZIP files by drag-and-drop or file picker
- Supports Azure Pipelines and GitHub Actions log archives
- Show pipeline structure (stage/job/task) in a collapsible tree
- Highlight errors, warnings, timestamps, and success messages
- Collapse/expand grouped blocks (`##[group]` / `##[endgroup]`)
- Search inside the active log with next/previous match navigation
- Toggle timestamp visibility and line wrapping
- Show simple task status indicators (error/warning/success)

## Privacy

All parsing happens client-side. No backend. No uploads.

## Known limitations

- Very large ZIPs/logs can be slow in the browser
- `.txt` logs are expected
- Structured JSON logs are shown as plain text
- GitHub Actions ZIPs downloaded via the GitHub UI are supported; API-only artifacts may vary

## Contributing

Issues and PRs are welcome.
