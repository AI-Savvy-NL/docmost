# Visible WikiSavvy releases

From a clean, committed checkout:

```sh
node scripts/build-wikisavvy-release.mjs
```

The helper archives the exact Git revision and builds a local Linux/AMD64 image.
It does not commit, push, publish or deploy. Build logs are followed by JSON naming
the image and retained temporary source directory for verification.

Settings shows, for example, **WikiSavvy 2026.11.17-7b93b5ba**, with **Base v0.97.0**
separately. The UTC build date and full revision are baked into the image and
returned by the running server; the first eight revision characters are displayed.
They change with deployed commits, not uncommitted edits or the current wall clock.

Both Dockerfiles accept `WIKISAVVY_BUILD_REVISION` and `WIKISAVVY_BUILD_DATE`
build arguments. CI supplies these to both its registry and archive builds.
Builds without valid metadata keep the honest base-version display rather than
claiming a release identity. Upstream version lookup failure does not hide the
running version.

The inherited release workflow still names upstream publishing destinations.
Do not dispatch it or push a release tag as a substitute for an approved WikiSavvy
release procedure. Configuring fork-owned publication is separate work.
