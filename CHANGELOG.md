# Changelog

This is the list of changes to Vuedio between each release. For full details,
see the commit logs. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- Restart playback from the first step after stopping.
- Apply tempo changes to subsequently scheduled steps.
- Run at most one playback scheduler when play is toggled repeatedly.
