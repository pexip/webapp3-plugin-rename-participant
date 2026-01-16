# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/) and this
project adheres to [Semantic Versioning](http://semver.org/).

## [1.2.0]

### Added

- Internationalization (i18n) support with i18next
- Translation files for English (en), Dutch (nl), and German (de)
- Dynamic language switching via plugin.events.languageSelect
- Development server configuration with Vite proxy support

### Changed

- All UI labels and form text now use translation keys
- Form validation to check for both undefined and empty string values
- Updated dependencies to latest versions

### Fixed

- Updated ESLint configuration to remove 'utils' from ignored paths

## [1.1.2]

### Fixed

- Added type guard to handle both `activity.activity` and `activity.type` properties for API compatibility.

## [1.1.1] 2025-08-15

### Fixed

- Fixed unexpected error message when dialog was closed and input field was empty

## [1.1.0] 2025-08-14

### Added

- Icon for the rename button in the participant list.

### Changed

- Updated dependencies to the latest versions.
- Subscribe to event `participantsActivities` instead of `participants`.
- Use the participant `uuid` instead of `identity` for renaming participants.
- Rename `displayname` to `display name` in the rename participant form.

## [1.0.0] - 2025-05-21

### Added

- Button in the participant list to rename participants.
