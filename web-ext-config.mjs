// Files web-ext leaves out of `run`, `lint`, `build` and `sign` packages.
export default {
  ignoreFiles: [
    "README.md",
    "CHANGELOG.md",
    "amo-metadata.json",
    "package.json",
    "package-lock.json",
    "web-ext-config.mjs",
    "dist",
    "docs",
    "node_modules",
    "scripts",
    "tests",
  ],
};
