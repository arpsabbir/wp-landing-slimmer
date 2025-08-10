# wp-landing-slimmer
WordPress/Elementor landing page into a single self-contained HTML with automated CSS pruning and an optional visual diff guard.
How to run it (npx)
Put these two files (package.json, cli.mjs) in a public GitHub repo, e.g. yourname/wp-landing-slimmer.

From any machine:

From a local HTML you saved from “View Source”:
npx -y github:yourname/wp-landing-slimmer -- --in ./index.html --base https://primelab.store --out slim.html --no-visual

From a live page:
npx -y github:yourname/wp-landing-slimmer -- --url https://primelab.store/your-landing --out slim.html --no-visual
Tip: --no-visual avoids downloading Chromium (fast/light).
Turn the guard back on by removing --no-visual. If you see a failure, widen the safelist:
--safelist "my-prefix-,exact-keep,other-prefix-"

(Optional) Publish to npm so you can do:
npm publish --access public
# then:
npx -y wp-landing-slimmer -- --in ./index.html --base https://primelab.store --out slim.html

Hitting your size target
Add --safelist if something gets pruned aggressively (prefix with - to keep families, e.g. elementor-).

Keep Google Fonts as external (default if you haven’t provided font files) — or swap to local @font-face if you have them.

If you want me to auto-subset Google Fonts (add &text= dynamically) or recompress images during the run, I can extend this CLI with optional flags:

--subset-fonts (build a character set from visible text and rewrite Google Fonts URLs with &text=)

--optimize-images (use sharp to make local WebP/AVIF copies and rewrite src)

