# Changelog

All notable changes to this project will be documented in this file.
This project follows [Semantic Versioning](https://semver.org/) and the style of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0-beta.1] - 2025-08-22

### Added

- XY panel presets similar to Videohub:
  - **Destinations**: select an output (destination) with a single button.
  - **Sources (Loose)**: route a single input directly to the selected destination.
  - **Sources (Paired)**: route paired inputs (i and i+1) to paired destinations (o and o+1).
- Visual feedback styles:
  - Selected destination button highlights **yellow**.
  - Routed source button highlights **green**.
  - Routed paired source highlights **green** when both members are routed correctly.
- Placeholders for inputs and outputs when the matrix is offline (`I001`, `O001`, etc), so buttons are never blank.

### Changed

- Feedback evaluation is now triggered live on selection, routing, and status polls.
- Destination and source highlights update immediately without reopening the presets.

### Notes

- This is a **prerelease (beta)** intended for field testing.
- Final `v1.2.0` will be released after production validation.

## [1.1.5] - 2025-08-20

### Added

- Inputs and Outputs count can be set manually in config.
- Matrix size is also autodetected from alias or status dumps when possible, overriding the manual size.

### Changed

- Module now automatically updates status to OK (green) after successful alias or status polls.
- Immediate alias and status polls are triggered at boot so connection state is known right away.
- Empty or unparsable replies are flagged as Unknown/Warning.
- Poll errors now mark the instance as ConnectionFailure.

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
