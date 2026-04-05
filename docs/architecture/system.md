# System Architecture

Use this document as the canonical product brief for Codex. Before asking multiple agents to build in parallel, write down the smallest useful version of the system here.

## Product Goal

- Project name: `__PROJECT_NAME__`
- Product goal: `__PROJECT_GOAL__`
- Target users:
- Success metric:
- Current MVP boundary:

## Modules

- UI: pages, flows, dashboards, and user-facing interaction
- Engine: domain logic, orchestration, workflows, and state transitions
- Data: storage, schemas, integrations, and data movement
- Content: prompts, presets, templates, and authored assets
- Verification: tests, smoke checks, observability, and review criteria

## Key Types And Interfaces

List the important entities and contracts here before implementation starts. Good examples:

- core domain types
- request and response shapes
- planner inputs and outputs
- persistence records
- event payloads
- integration boundaries

## Constraints

- stack: `__STACK__`
- non-goals:
- performance expectations:
- security or compliance notes:
- deployment assumptions:

## Open Questions

- What still needs a product or architecture decision?
- What should stay out of scope for the first milestone?
- What needs a manual verification step even after automation exists?
