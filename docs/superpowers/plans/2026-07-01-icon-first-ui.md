# Icon-first UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace familiar text-heavy actions with accessible, tooltip-backed icon buttons.

**Architecture:** Add one shared `IconButton` wrapper around the existing button and tooltip primitives. Adopt it across route-level actions while retaining text where icons would be ambiguous.

**Tech Stack:** React 19, TypeScript, shadcn/Radix UI, Lucide icons, Vitest.

## Global Constraints

- Modify frontend presentation only.
- Every icon-only action must expose an accessible name and tooltip.
- Preserve existing action behavior.

---

### Task 1: Accessible icon action primitive

**Files:**
- Create: `frontend/src/components/shared/IconButton.tsx`
- Test: `frontend/src/components/shared/IconButton.test.tsx`

**Interfaces:**
- Produces: `IconButton({ label, ...buttonProps })`

- [ ] Write a test that renders an icon action and asserts its accessible name.
- [ ] Run the focused test and confirm it fails because the component is absent.
- [ ] Implement the wrapper with `Tooltip`, `TooltipTrigger`, and `TooltipContent`.
- [ ] Run the focused test and confirm it passes.

### Task 2: Icon-first route actions

**Files:**
- Modify: `frontend/src/routes/Load.tsx`
- Modify: `frontend/src/routes/Compare.tsx`
- Modify: `frontend/src/routes/Filter.tsx`
- Modify: `frontend/src/routes/Models.tsx`
- Modify: `frontend/src/routes/Report.tsx`
- Modify: `frontend/src/routes/Simulation.tsx`
- Modify: `frontend/src/routes/SysId.tsx`
- Modify: `frontend/src/components/shared/NoDataset.tsx`
- Modify: `frontend/src/routes/Plot.tsx`

**Interfaces:**
- Consumes: `IconButton`

- [ ] Replace familiar action text with Lucide icons and concise accessible labels.
- [ ] Keep explanatory copy only where it conveys state, data, or an ambiguous choice.
- [ ] Run tests, lint, and build.

