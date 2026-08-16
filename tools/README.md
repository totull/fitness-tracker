# Tracker verification tools

Checks that must pass **before** claiming a change is shipped. The failure that
motivated these: ~360 lines of Garmin integration were written, verified with
`node --check` and grep, and reported as done — while never being committed.
GitHub Pages served the previous commit the whole time.

Syntax checks and grep only prove "the text I wrote is in the file I wrote it
to." They cannot detect that the file is not the one being served.

## 1. Asset references resolve against tracked files

`Tracker.html` referenced `./garmin-importer.js` while that file was untracked,
so even a correct push would have 404'd. Working-tree checks pass here; only a
git-tracked check catches it.

```powershell
$tracked = git ls-files
$t = Get-Content Tracker.html -Raw
[regex]::Matches($t,'(?:src|href)="(?!https?:|//|#|data:|mailto:)([^"]+)"') |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique |
  ForEach-Object { $c = ($_ -replace '^\./','') -replace '[?#].*$','';
    if ($tracked -contains $c) { "OK      $_" } else { "MISSING $_" } }
```

## 2. Behavioural smoke test

Runs headless Chrome against a local file **or a live URL**. Covers page load,
Garmin card rendering, sync failure paths, and weight-input focus retention.

```powershell
npm install playwright-core --prefix $env:TEMP
$env:NODE_PATH = "$env:TEMP\node_modules"

node tools\smoke-tracker.js Tracker.html                        # local
node tools\smoke-tracker.js https://totull.github.io/fitness-tracker/Tracker.html  # deployed
```

Exit code 0 = all passed, 1 = at least one failure.

### Confirm the test still has teeth

A test that has never failed proves nothing. Run it against the previous commit
and confirm the bug assertions fail:

```powershell
git show HEAD:Tracker.html > "$env:TEMP\Tracker.prev.html"
node tools\smoke-tracker.js "$env:TEMP\Tracker.prev.html"
```

## 3. Deployment is the last step, not an assumption

`git status` must be clean and pushed, then the smoke test must pass against the
**live URL** — not the working tree. Pages can lag ~1 minute after a push.
