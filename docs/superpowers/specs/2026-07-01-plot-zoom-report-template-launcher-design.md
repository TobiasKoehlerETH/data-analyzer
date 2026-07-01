# Plot Zoom, Local Report Template, and Launcher Design

## Scope

Add discoverable, reversible zoom controls to every axis-based plot, use a
sanitized local HTML template for generated reports, and provide a Windows
launcher.

## Plot Zoom

`UPlotChart` will own zoom behavior so every chart built on the shared uPlot
wrapper receives the same interaction without route-specific duplication.

Each plot will show a compact control group in its top-right corner:

- Zoom in (`+`) around the current viewport center.
- Zoom out (`-`) around the current viewport center.
- Back to restore the immediately previous X and Y ranges.
- Reset to restore the complete ranges derived from the plot's current data.

Mouse-wheel input will zoom around the cursor position on both axes. Dragging
across the plot will select a rectangular X/Y region and zoom to it. Every plot
will maintain an independent bounded zoom-history stack. Programmatic changes
made by Back or Reset will not create new history entries.

The canvas correlation heatmap is not an axis plot and remains unchanged.

## Report Template

The repository-root `template.html` is local-only source material and will be
added to `.gitignore`. It will be overwritten in place with a sanitized,
logo-free template:

- Remove all logos, branding, company names, personal names, links, and
  source-specific report content.
- Preserve the useful page layout, typography, print styling, tables, and
  figure styling.
- Replace visible content with generic report language and Jinja placeholders
  such as report title, generation timestamp, metadata, statistics, plots,
  correlation results, and models.
- Remove image references that are not generated report figures.

The report generator will load `template.html` when it exists locally. If it is
missing, unreadable, or invalid, generation will fall back to the existing
built-in generic template so clean clones remain functional.

## Windows Launcher

Create `launch.bat` at the repository root. It will:

1. Resolve paths relative to its own location.
2. Start the Tauri development application from `frontend`.
3. Keep startup errors visible instead of silently closing.

The launcher will not install dependencies or mutate the repository.

## Error Handling

Zoom actions with empty or degenerate ranges will be ignored safely. Zoom
history will be cleared when a chart is recreated for materially different
options or data.

If the local report template cannot be loaded or rendered, the generator will
use the built-in fallback rather than failing report generation.

The launcher will return the underlying command's exit code and pause on an
error so the failure can be read.

## Testing

Implementation will follow red-green-refactor:

- Unit-test zoom range calculations, history behavior, Back, and Reset.
- Test local-template selection and built-in fallback.
- Test that the sanitized template contains required placeholders and no
  prohibited branding, logo, or external image references.
- Run frontend tests, frontend production build, backend tests, and report
  generation smoke checks.
- Launch the application and verify the native window appears.

