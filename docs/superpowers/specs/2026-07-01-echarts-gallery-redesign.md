# ECharts Gallery Redesign

## Goal

Replace the application's chart presentation with a consistent ECharts-based system that keeps axis meaning visible, makes multi-plot pages easy to scan, and lets users inspect any plot at full size without leaving the current page.

## Scope

- Use ECharts for every interactive chart in the React frontend.
- Preserve existing analysis calculations and backend behavior.
- Redesign chart presentation and interaction across all routes that display plots.
- Do not modify the Python template backend.

## Chart foundation

All chart types share one reusable ECharts wrapper and common visual defaults:

- explicit x-axis and y-axis names on every chart;
- units included in axis names when the underlying data provides them;
- consistent typography, grid spacing, tooltip styling, series colors, and dark-mode behavior;
- automatic resize when the chart container or application window changes;
- chart-type-specific options layered over the common defaults.

Line, scatter, heatmap, spectrum, simulation, comparison, validation, correlation, system-identification, filter, overview, and stacked-signal charts use this foundation. Axis names must remain visible in both preview and maximized states.

## Multi-chart gallery

A route that presents multiple plots uses a responsive gallery of equal square chart tiles.

Each tile contains:

- the chart title;
- a square ECharts preview;
- no buttons or toolbox overlaid on the preview chart;
- a hover state with a small lift, stronger border or shadow, pointer cursor, and subtle expand affordance.

Clicking anywhere on a tile opens that chart in the maximized view. Keyboard users can focus the tile and open it with Enter or Space.

Routes with only one chart may retain a normal large chart instead of forcing it into a square tile.

## Maximized chart

The maximized chart appears in a modal overlay covering the application content region while leaving the sidebar visible and usable as a stable visual anchor.

The overlay:

- dims the page content behind it;
- presents the selected chart in a large responsive panel;
- preserves the selected chart title and all axis labels;
- has a clear x-icon in the panel chrome to close it;
- closes with Escape or by clicking the dimmed backdrop;
- traps focus while open and restores focus to the originating tile when closed.

The close control belongs to the modal panel chrome, not to the chart canvas.

## ECharts toolbox and zoom

Only the maximized chart shows the native ECharts toolbox. The toolbox includes:

- native rectangular data zoom;
- restore;
- save-as-image when supported by the desktop webview.

The preview charts show no toolbox or overlaid chart buttons. Zoom state is local to the maximized view and does not leave a preview in a confusing cropped state after the modal closes.

## Component structure

- `EChartsChart`: owns ECharts initialization, updates, theme application, resize, cleanup, and toolbox configuration.
- Shared chart option helpers: provide common axes, grids, tooltips, labels, palettes, and expanded-state options.
- `ChartTile`: provides the square preview, title, hover/focus behavior, and open action.
- `ChartGallery`: lays out multiple equal tiles responsively.
- `ExpandedChartOverlay`: renders the selected chart above the content area and owns close, focus, and keyboard behavior.

Existing route components remain responsible for translating analysis results into chart series and meaningful axis labels.

## Error and empty states

- A chart without usable data shows its existing empty-state message inside the tile or chart region.
- Invalid or missing axis units fall back to a meaningful quantity name without inventing a unit.
- ECharts instances are disposed on unmount to avoid stale canvases and event handlers.

## Verification

Automated checks cover:

- common options always produce x-axis and y-axis names;
- a multi-chart route renders square, focusable tiles;
- clicking or keyboard-activating a tile opens the overlay;
- x-icon, Escape, and backdrop close the overlay;
- previews omit the toolbox;
- maximized charts enable ECharts box zoom and restore;
- existing frontend tests, TypeScript build, and lint remain passing.

Manual browser verification covers representative light and dark themes, a multi-chart page, a single-chart page, hover behavior, modal sizing with the sidebar visible, native box zoom, restore, and window resizing.
