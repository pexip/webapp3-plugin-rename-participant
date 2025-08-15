# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/) and this
project adheres to [Semantic Versioning](http://semver.org/).

## [1.1.1] 2025-08-15

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
