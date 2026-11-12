# Vendored upstream — Chatwoot Community Edition

This directory is **upstream Chatwoot source**, vendored so our integration
lives in the same repository and can be reviewed as a diff against a known
release. **Do not edit files here.** All Cortoba changes belong in
`../chatwoot-cortoba/` (the overlay) so an upstream bump stays a clean replay.

## Exact provenance

| Field | Value |
| --- | --- |
| Project | https://github.com/chatwoot/chatwoot |
| Release tag | `v4.19.1` |
| Commit | `caab07a8f00032d5205b5a5d7e2eb0ba2f3d2d82` |
| Commit date | 2026-10-24 10:07:40 +0530 |
| License | MIT (see `LICENSE`) |
| Edition | Community (the `enterprise/` tree is present but its licence-gated features stay disabled) |

## How this tree was produced

```bash
git clone --depth 1 --branch v4.19.1 https://github.com/chatwoot/chatwoot.git /tmp/cw
# copy without history; .git is never vendored
tar -C /tmp/cw --exclude=.git -cf - . | tar -C chatwoot -xf -
```

## What is NOT committed

Heavy, non-code assets are excluded from git to keep the repository pushable.
They are **not needed** to build or run: the official image ships them, and the
full tree can be restored byte-for-byte from the commit above.

| Excluded | Why |
| --- | --- |
| `spec/` | 42 MB of upstream test fixtures (sample.mp4/pdf/ogg) — upstream's suite, not ours |
| `public/videos/` | 35 MB of onboarding MP4s served by the hosted product |
| `vendor/db/*.onnx` | 66 MB sentiment-analysis model, downloaded at boot by the image |
| `.github/screenshots/` | README images |
| `public/packs/`, `tmp/`, `log/`, `storage/`, `node_modules/` | build/runtime output |

To restore the complete tree including those assets:

```bash
git clone --depth 1 --branch v4.19.1 https://github.com/chatwoot/chatwoot.git /tmp/cw
rsync -a --exclude=.git /tmp/cw/ chatwoot/
```

## Runtime

We do **not** build Chatwoot from this tree. The container runs the official
published image (`chatwoot/chatwoot:v4.19.1`) pinned to the same release, and
this tree is the reference for the overlay's diff. See
`../chatwoot-cortoba/README.md`.
