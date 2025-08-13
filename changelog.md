# Changelog
All notable changes to this project will be documented in this file.

## [1.1.0] - 2025-08-13
### Added
- Initial public release for ETL Systems Victor RF Matrix.
- Routing using short switch command `s`.
- Alias polling using `T?` with automatic dropdown labels.
- Live status polling using `?` and quick health using `Q`.
- Variables per output for current source, health flags, and alias names.
- Basic configuration: Host and Port, Test Connect action.
- Compatibility confirmed with Companion 4.1.x.

### Notes
- Entry point for development: `../dist/main.js`.
- Packaged builds will rewrite entry point to `../main.js`.
