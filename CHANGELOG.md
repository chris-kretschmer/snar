# Changelog

## [Unreleased]

### Added
- The click chart can be operated with the keyboard (arrow keys, Home/End, Esc) and announces the selected value to screen readers.
- Shared chart maths for server and browser in `public/chart-shared.js` (new file), so the server render and the client redraw cannot drift apart.

### Changed
- Link detail page reworked: KPI card, click chart with a rounded Y axis (including 0) and a dashed, still running last period, distribution lists with a "Weitere" dialog, paginated latest clicks.
- Card headings renamed: Link-Details, Klickverlauf, Besuchende, Quelle.
- The back link keeps the previous list position, and the sidebar highlight stays after paging.
- The copy button on the detail page is now a visible bordered button. The "Link löschen" card is simplified (slug shown in the text, real heading).
- CSS cleanup: one set of breakpoints (520/760/1040/1200/1480 px), colours as variables, classes instead of inline styles, shorter comments.
- Accessibility: custom dropdowns use real `option` roles, the hidden native controls are `aria-hidden`, and the confirmation dialog has a title and an `h2` heading. Also `autocomplete="off"` on non-login fields, `translate="no"` on slugs and URLs, and a non-breaking space before "Uhr".

### Fixed
- Deleting a user failed with a 500 error if they had changed a target URL before (reference in the change log).
- Malformed session cookies now lead to a redirect instead of a 500 error.
- The custom date range is limited to the years 2000 to 2100.
- Daylight saving time changes no longer produce a duplicated hour or duplicated axis labels.
- The expiry date keeps the browser time zone after a failed save, and the chosen visibility is kept as well.
- Link tables no longer get equal-width columns.
- The copy button no longer stays on "Kopiert" after a fast double click.
- The focus line on form fields is one continuous band instead of two lines at fractional zoom levels.

## [1.0.0] - 2026-08-18

### Added
- Initial public release.

[Unreleased]: https://github.com/chris-kretschmer/snar/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/chris-kretschmer/snar/releases/tag/v1.0.0
