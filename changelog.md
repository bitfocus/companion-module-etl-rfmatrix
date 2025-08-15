# Changelog

All notable changes to this project will be documented in this file.
This project follows [Semantic Versioning](https://semver.org/) and the style of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.4] - 2025-08-15

### Changed

- Ran Prettier correctly this time

## [1.1.3] - 2025-08-15

### Changed

- Fixed builderrors

## [1.1.2] - 2025-08-15

### Changed

- Moved `@companion-module/base` to `dependencies` in `package.json`.
- Removed `peerDependencies` and removed `@companion-module/base` from `devDependencies`.
- Ran Prettier to align formatting with Companion conventions.

### Fixed

- Confirmed `manifest.json` `id` is `etl-rfmatrix` to match the module name.
- Ensured manifest runtime entrypoint and package `main` both target the built file in `dist/`.
- Verified `package` script builds into `dist/` successfully.

### Notes

- Supersedes the rejected 1.1.1 submission that had dependency layout and formatting issues.

## [1.1.1] - 2025-08-15

### Rejected

- Not published on the Hub. See 1.1.2 for the corrected changes.

## [1.1.0]

### Added

- Initial public release of the Bitfocus Companion module for ETL Systems Victor RF Matrix.
