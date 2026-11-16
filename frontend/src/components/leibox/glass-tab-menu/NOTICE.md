# LeiBox Glass Tab Menu

Source: https://leibox.pantoria.cn/docs/animations/glass-tab-menu

Provider: LeiBox component package, retrieved on 2026-11-16.

Design reference and attribution: solutionb — https://x.com/SolutionB2u/status/2113575003341881728/video/1

The upstream catalog permits redistribution of its supplied source while requiring preservation of notices and design-reference attribution. It assigns no blanket component license. The project license does not replace these source terms.

This adaptation retains the spring integration, sliding glass selection and combined tab-to-action-menu interaction. On the mobile project, container and image pages, one shared glass surface expands upward from the four navigation items into the current page's actual actions, with the adjacent plus rotating into a close control. Project and image actions use a single row of two or three items; container batch actions use the original six-item arrangement. React renders the application's navigation and actions; only the desktop container header uses a separate native Popover. Selection follows the application's accepted page state, uses measured button bounds and retains velocity when redirected. Fixed demonstration dimensions, sample content, embedded font/artwork and the demonstration surface runtime were removed. No external animation runtime is required.

The panel, circular toggle, action tiles and selection lens retain the upstream material declarations and velocity-driven selection opacity/shadow. Geometry and foreground colors are adapted to the application's touch targets, real actions and dark theme.
