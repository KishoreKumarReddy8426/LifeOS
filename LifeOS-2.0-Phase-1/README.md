# LifeOS 2.0 — Phase 1 Preview

This folder contains the isolated LifeOS 2.0 Phase 1 dashboard preview.

- **Preview:** https://kishorekumarreddy8426.github.io/LifeOS/LifeOS-2.0-Phase-1/
- **Original dashboard:** https://kishorekumarreddy8426.github.io/LifeOS/
- **Review / source changes:** [Pull request #2](https://github.com/KishoreKumarReddy8426/LifeOS/pull/2)

The preview reads the repository's existing `sheet_data.json` from the parent directory. It does not duplicate or modify the source data. Its goal and theme preferences use separate browser-local storage keys (`lifeos2.*`) so they do not overwrite preferences from the original dashboard.

The original root `index.html` is unchanged. The LifeOS 2.0 feature branch and pull request remain available for review; this preview folder is a separate copy for convenient viewing.

If GitHub Pages is configured to publish the `main` branch, this folder is served as a subpath alongside the original dashboard. Pages publishing can take a few minutes to update after a commit.
