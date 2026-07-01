# Icon-first UI Design

## Goal

Reduce visible interface text and make familiar actions icon-only without making the analyzer harder to learn or use with assistive technology.

## Design

- Convert familiar action buttons—browse, add, remove, save, load, export, download, generate, run, and identify—to compact icon buttons.
- Keep text for ambiguous choices, form labels, data labels, headings, and destructive confirmations where an icon alone would be unclear.
- Give every icon-only control an `aria-label` and hover tooltip.
- Centralize the accessible icon-button pattern in one shared component.
- Preserve all backend behavior and data flows.

## Verification

- Component tests verify accessible names and tooltip content.
- Existing frontend tests, lint, and production build must pass.

