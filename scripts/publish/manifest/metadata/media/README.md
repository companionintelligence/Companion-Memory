# Store listing media

These files are bundled into the Companion Memory store listing by
`scripts/publish/publish.sh` (everything under `manifest/` is copied into the
publish bundle) and referenced from `metadata/description.md` and
`config.json`.

> **Note:** publishing is **tag-triggered** (`.github/workflows/publish.yml`
> runs on pushed tags). A missing asset here will not affect the live listing
> until the next release tag is cut — but the binaries below must be added
> before then so the listing renders correctly.

## Required assets

| File                                | Used by                          | Spec |
| ----------------------------------- | -------------------------------- | ---- |
| `companion-memory-demo.mp4`         | "Watch the demo" + `demo_video`  | 1080p (or 720p) H.264 MP4, ≤ ~30 MB, ~60–120s product walkthrough |
| `companion-memory-demo-poster.png`  | video poster frame               | 16:9 PNG/JPG matching the demo's opening frame |
| `companion-memory-ftue.gif`         | "See it in action — your first run" | Animated GIF of the 7-step onboarding (welcome → focus areas → connect accounts → food/movie/activity preferences → done), ≤ ~8 MB, looping |

## Notes

- The screenshots in the listing currently reuse the GitHub-hosted assets that
  also appear in the repo `README.md`. If the CI-Portal store does not serve
  bundle-relative media (`./media/...`) over a public URL, upload the video,
  poster, and GIF to a CDN / GitHub release and swap the relative paths in
  `metadata/description.md` and `config.json` for the absolute URLs.
- Keep file names stable — they are referenced by path in two places.
