# Verification Evidence — Phase 3.1

The following commands were run in the workspace and produced the recorded evidence:

```sh
C:\Users\perro\Documents\GitHub\lamiss-youtube-transcript-poc>npm run build

> lamiss-youtube-transcript-poc@0.1.0 build
> tsc -p tsconfig.json && node scripts/build.js

Lamiss POC build helper: copied static extension files into compiled/.
```

```sh
C:\Users\perro\Documents\GitHub\lamiss-youtube-transcript-poc>npm test

> lamiss-youtube-transcript-poc@0.1.0 test
> npm run build && node test/youtubeUrl.test.js


> lamiss-youtube-transcript-poc@0.1.0 build
> tsc -p tsconfig.json && node scripts/build.js

Lamiss POC build helper: copied static extension files into compiled/.
youtubeUrl tests passed: 6
```

This confirms that the repo currently builds successfully and that the existing `youtubeUrl` test suite remains passing with the recorded result:

```text
youtubeUrl tests passed: 6
```
