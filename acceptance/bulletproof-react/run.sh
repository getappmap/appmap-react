#!/usr/bin/env bash
# Acceptance run: AppMap React recorder on alan2207/bulletproof-react
# (apps/react-vite), from a clean clone at a pinned SHA to every check A-J
# plus the real-browser interaction checks.
#
# usage: acceptance/bulletproof-react/run.sh [WORK_DIR]
#   env: CHROME=<chromium binary>   (default /opt/pw-browsers/chromium-1194/...)
#        APPMAP_CLI_VERSION=<ver>   (default 3.204.0, latest at time of writing)
#        VALIDATE_VERSION=<ver>     (default 2.5.1)
# Exits non-zero if any check FAILs. Evidence lands in WORK_DIR/out.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RECORDER_REPO=$(cd "$HERE/../.." && pwd)
WORK=${1:-${WORK:-$(mktemp -d)}}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
OUT=$WORK/out
APP_REPO=https://github.com/alan2207/bulletproof-react.git
APP_SHA=9506629ed003a561c6627735480cce4994244bb4
CHROME=${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}
APPMAP_CLI_VERSION=${APPMAP_CLI_VERSION:-3.204.0}
VALIDATE_VERSION=${VALIDATE_VERSION:-2.5.1}
PY="python3 $HERE/scripts/analyze.py"
export APPMAP_TELEMETRY_DISABLED=1
# Vitest runs: the API base URL from the app's own .env.example; MSW answers
# in-process, nothing leaves the machine.
TEST_ENV=(VITE_APP_API_URL=https://api.bulletproofapp.com VITE_APP_ENABLE_API_MOCKING=true)
# Browser runs: the app's own mock server on localhost:8080.
BROWSER_ENV=(VITE_APP_API_URL=http://localhost:8080/api VITE_APP_ENABLE_API_MOCKING=false
  VITE_APP_MOCK_API_PORT=8080 VITE_APP_APP_URL=http://localhost:3000)

rm -rf "$OUT" && mkdir -p "$OUT"
declare -A VERDICT
log() { printf '\n=== %s\n' "$*" | tee -a "$OUT/run.log"; }
verdict() { VERDICT[$1]=$2; echo "$1: $2" | tee -a "$OUT/run.log"; }
now() { date +%s.%N; }
PIDS=()
# shellcheck disable=SC2329 # invoked by the EXIT trap below
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -- -"$p" 2>/dev/null; done; }
trap cleanup EXIT

# ------------------------------------------------------------------ A --
log "A. setup: clone app at $APP_SHA, install, add recorder"
setup_ok=1
if [ ! -d "$WORK/bulletproof-react/.git" ]; then
  git clone -q "$APP_REPO" "$WORK/bulletproof-react" || setup_ok=0
fi
git -C "$WORK/bulletproof-react" checkout -q --force "$APP_SHA" || setup_ok=0
git -C "$WORK/bulletproof-react" clean -qfdx apps/react-vite -e node_modules
APP=$WORK/bulletproof-react/apps/react-vite
echo "app HEAD: $(git -C "$WORK/bulletproof-react" rev-parse HEAD)" | tee -a "$OUT/run.log"
# Environment workaround (not an app change): yarn.lock pins one tarball on
# registry.npmmirror.com, which this sandbox's egress policy blocks. Same
# tarball, same integrity hash, from the default registry.
sed -i 's#https://registry.npmmirror.com/#https://registry.yarnpkg.com/#' "$APP/yarn.lock"
( cd "$APP" && yarn install --frozen-lockfile --ignore-scripts --network-concurrency 8 >"$OUT/yarn-install.log" 2>&1 ) || setup_ok=0
# Install the recorder as a dev dependency straight from this checkout. Its
# entry points are the built dist/ (README: build first when installing from
# a checkout).
( cd "$RECORDER_REPO" && npm run build --workspace recorder >"$OUT/recorder-build.log" 2>&1 ) || setup_ok=0
( cd "$APP" && yarn add -D "file:$RECORDER_REPO/recorder" --ignore-scripts >"$OUT/yarn-add-recorder.log" 2>&1 ) || setup_ok=0
# Config files only; the extra test dir is copied in just for its own run so
# the app's default test glob never picks it up.
cp "$HERE"/app-config/*.ts "$APP/"
mkdir -p "$WORK/tools"
( cd "$WORK/tools" && [ -f package.json ] || npm init -y >/dev/null )
( cd "$WORK/tools" && npm install --no-audit --no-fund "@appland/appmap@$APPMAP_CLI_VERSION" "@appland/appmap-validate@$VALIDATE_VERSION" >"$OUT/tools-install.log" 2>&1 ) || setup_ok=0
APPMAP="$WORK/tools/node_modules/.bin/appmap"
VALIDATOR_DIR="$WORK/tools/node_modules/@appland/appmap-validate"
echo "appmap CLI $($APPMAP --version 2>/dev/null), validator $VALIDATE_VERSION" | tee -a "$OUT/run.log"
git -C "$WORK/bulletproof-react" status --short -- apps/react-vite > "$OUT/app-tree-changes.txt"
# Probe: the documented way to load the plugin (package entry point).
( cd "$APP" && env "${TEST_ENV[@]}" npx vitest run --config vite.config.appmap-pkgimport.ts src/hooks >"$OUT/a-pkgimport.log" 2>&1 )
pkgimport_rc=$?
grep -o 'ERR_[A-Z_]*' "$OUT/a-pkgimport.log" | head -1 | sed 's/^/documented package import: /' | tee -a "$OUT/run.log"
if [ $setup_ok = 1 ] && [ $pkgimport_rc = 0 ]; then verdict A PASS; else verdict A FAIL; fi

run_suite() { # $1 = config ("" for the app's own), $2 = dest dir, $3 = timing label
  rm -rf "$APP/tmp/appmap/tests"
  local cfg=() t0 t1
  [ -n "$1" ] && cfg=(--config "$1")
  t0=$(now)
  ( cd "$APP" && env "${TEST_ENV[@]}" npx vitest run "${cfg[@]}" >"$OUT/$3.log" 2>&1 )
  local rc=$?
  t1=$(now)
  echo "$3 $(echo "$t1 - $t0" | bc) rc=$rc" >> "$OUT/timings.txt"
  if [ -n "$2" ]; then rm -rf "$2"; mkdir -p "$2"; cp -r "$APP/tmp/appmap/tests/." "$2/" 2>/dev/null; fi
  grep -E '^ +(Tests|Test Files) ' "$OUT/$3.log" | sed "s/^/$3: /" | tee -a "$OUT/run.log"
}
seq_json() { # $1 = appmap dir, $2 = output dir
  rm -rf "$2"; mkdir -p "$2"
  ( cd "$1" && "$APPMAP" sequence-diagram --format json --output-dir "$2" ./*.appmap.json >"$2.log" 2>&1 )
}

# ------------------------------------------------------------ J (base) -
log "J. suite without the recorder (x2)"
run_suite "" "" plain-1
run_suite "" "" plain-2

# ------------------------------------------------------- record run 1/2 -
log "Recorded suite, run 1 and run 2"
run_suite vite.config.appmap.ts "$OUT/run1" recorded-1
run_suite vite.config.appmap.ts "$OUT/run2" recorded-2
log "Extra tests (E exception, F failing, recorder side-effect repro)"
rm -rf "$APP/tmp/appmap/tests"
cp -r "$HERE/app-config/appmap-extra" "$APP/"
( cd "$APP" && env "${TEST_ENV[@]}" npx vitest run --config vite.config.appmap-extra.ts >"$OUT/extra.log" 2>&1 )
rm -rf "$APP/appmap-extra"
mkdir -p "$OUT/extra" && cp -r "$APP/tmp/appmap/tests/." "$OUT/extra/"
grep -E '✓|×' "$OUT/extra.log" | tee -a "$OUT/run.log"

# ------------------------------------------------------------ browser --
start_bg() { # $1 = name, rest = command (run in app dir, own process group)
  local name=$1; shift
  # setsid may fork, so let the new session leader write its own pid.
  # shellcheck disable=SC2016 # $$/$0/$@ expand in the inner shell
  ( cd "$APP" && setsid bash -c 'echo $$ > "$0"; exec env "$@"' "$OUT/$name.pid" "$@" >"$OUT/$name.log" 2>&1 & )
  for _ in $(seq 1 50); do [ -s "$OUT/$name.pid" ] && break; sleep 0.1; done
  PIDS+=("$(cat "$OUT/$name.pid")")
}
wait_url() { for _ in $(seq 1 60); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done; return 1; }
stop_bg() { local p; p=$(cat "$OUT/$1.pid"); kill -- -"$p" 2>/dev/null; sleep 1; kill -9 -- -"$p" 2>/dev/null; }
wait_port_free() { for _ in $(seq 1 30); do curl -s -o /dev/null "$1" || return 0; sleep 1; done; echo "port still busy: $1" | tee -a "$OUT/run.log"; }
browser_pass() { # $1 = label, $2 = vite config
  rm -f "$APP/mocked-db.json"; rm -rf "$APP/tmp/appmap/interactions"
  wait_port_free http://localhost:3000/; wait_port_free http://localhost:8080/api/healthcheck
  start_bg "mock-$1" "${BROWSER_ENV[@]}" npx vite-node mock-server.ts
  start_bg "vite-$1" "${BROWSER_ENV[@]}" npx vite --config "$2" --port 3000 --strictPort
  # shellcheck disable=SC2015 # report if either server did not start
  wait_url http://localhost:8080/api/healthcheck && wait_url http://localhost:3000/ || echo "servers did not start" | tee -a "$OUT/run.log"
  curl -s http://localhost:3000/ | grep -o '<script type="module">import "[^"]*appmap[^"]*"' | sed "s/^/$1 served: /" | tee -a "$OUT/run.log"
  ( cd "$APP" && APP_DIR="$APP" APP_URL=http://localhost:3000 CHROME="$CHROME" OUT="$OUT/browser-$1.json" \
      COLLECTOR_DIR="$APP/tmp/appmap/interactions" timeout 300 node "$HERE/scripts/browser-drive.mjs" >"$OUT/browser-$1.stdout" 2>&1 )
  mkdir -p "$OUT/interactions-$1"; cp -r "$APP/tmp/appmap/interactions/." "$OUT/interactions-$1/" 2>/dev/null
  stop_bg "vite-$1"; stop_bg "mock-$1"
  wait_port_free http://localhost:3000/; wait_port_free http://localhost:8080/api/healthcheck
  $PY browser "$OUT/interactions-$1" "$OUT/browser-$1.json" > "$OUT/browser-$1-check.json"
  python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print(sys.argv[2], 'maps per step:', {k: len(v.get('newMaps', [])) for k, v in r['steps'].items()}, 'verdict', r['verdict'])" "$OUT/browser-$1-check.json" "$1" | tee -a "$OUT/run.log"
}
log "Browser pass 1: zero-touch plugin exactly as documented"
browser_pass zerotouch vite.config.appmap.ts
BR1=$(python3 -c "import json; print(json.load(open('$OUT/browser-zerotouch-check.json'))['verdict'])")
log "Browser pass 2: same, plus a config-only workaround for bug 2"
browser_pass workaround vite.config.appmap-browserfix.ts
BR2=$(python3 -c "import json; print(json.load(open('$OUT/browser-workaround-check.json'))['verdict'])")
verdict BROWSER "$([ "$BR1" = PASS ] && [ "$BR2" = PASS ] && echo PASS || echo FAIL) (zero-touch: $BR1, with workaround: $BR2)"

# ------------------------------------------------------------------ B --
log "B. official validator on every recording (declared version + each spec version)"
node "$HERE/scripts/validate-all.cjs" "$VALIDATOR_DIR" "$OUT/run1" "$OUT/extra" "$OUT/interactions-workaround" > "$OUT/b-validate.json"
python3 - "$OUT/b-validate.json" <<'EOF' | tee -a "$OUT/run.log"
import json, sys, collections
r = json.load(open(sys.argv[1]))
print('summary', json.dumps(r['summary']))
reasons = collections.Counter(f['declaredResult'][:160] for f in r['files'] if f['declaredResult'] != 'valid')
for k, v in reasons.items(): print(f'  {v}x {k}')
EOF
B_ALL=$(python3 -c "import json; r=json.load(open('$OUT/b-validate.json'))['summary']; print('PASS' if r['files'] and r['declaredValid']==r['files'] else 'FAIL')")
verdict B "$B_ALL"
log "B (diagnostic only, not a verdict): recorder options set as well as they can be"
# frameworks[].version via registerAppMapHooks options + APPMAP_EVENT_VALUESIZE=99
# (99, because the recorder appends an ellipsis after cutting at the cap).
rm -rf "$APP/tmp/appmap/tests"
( cd "$APP" && env APPMAP_EVENT_VALUESIZE=99 "${TEST_ENV[@]}" npx vitest run --config vite.config.appmap-bestconfig.ts >"$OUT/bestconfig.log" 2>&1 )
rm -rf "$OUT/bestconfig" && mkdir -p "$OUT/bestconfig" && cp "$APP"/tmp/appmap/tests/*.json "$OUT/bestconfig/"
rm -rf "$APP/tmp/appmap/tests"; cp -r "$HERE/app-config/appmap-extra" "$APP/"
( cd "$APP" && env APPMAP_EVENT_VALUESIZE=99 "${TEST_ENV[@]}" npx vitest run --config vite.config.appmap-bestconfig.ts appmap-extra/exception.test.tsx >>"$OUT/bestconfig.log" 2>&1 )
rm -rf "$APP/appmap-extra"; cp "$APP"/tmp/appmap/tests/*.json "$OUT/bestconfig/"
node "$HERE/scripts/validate-all.cjs" "$VALIDATOR_DIR" "$OUT/bestconfig" > "$OUT/b-validate-bestconfig.json"
python3 - "$OUT/b-validate-bestconfig.json" <<'EOF' | tee -a "$OUT/run.log"
import json, sys, collections
r = json.load(open(sys.argv[1]))
print('bestconfig summary', json.dumps(r['summary']['perVersionAllValid']), 'of', r['summary']['files'])
for k, v in collections.Counter(f['declaredResult'][:220] for f in r['files'] if f['declaredResult'] != 'valid').items():
    print(f'  {v}x {k}')
EOF

# ---------------------------------------------------------- C, E, F ----
log "C/E/F. ground truth from EXPECTATIONS.md"
mkdir -p "$OUT/cef" && cp "$OUT"/run1/*.json "$OUT"/extra/*.json "$OUT/cef/"
$PY ground-truth "$OUT/cef" > "$OUT/c-ground-truth.json"
python3 - "$OUT/c-ground-truth.json" <<'EOF' | tee -a "$OUT/run.log"
import json, sys
r = json.load(open(sys.argv[1]))
print('totals', r['totals'])
for k, t in r['tests'].items():
    bad = [f"{i['status']}: {i['expect']}" for i in t['items'] if i['status'] != 'found']
    print(f"  {k[:60]:60} {len(t['items'])-len(bad)}/{len(t['items'])} found" + ('' if not bad else '  | ' + '; '.join(bad)[:400]))
print('E', json.dumps({k: v for k, v in r['E'].items() if k != 'other_exception_returns'})[:300])
print('F', r['F'])
EOF
for c in C E F; do verdict $c "$(python3 -c "import json; print(json.load(open('$OUT/c-ground-truth.json'))['verdict']['$c'])")"; done

# ------------------------------------------------------------------ D --
log "D. noise"
$PY noise "$OUT/run1" > "$OUT/d-noise.json"
python3 -c "import json; r=json.load(open('$OUT/d-noise.json')); print(json.dumps({k: r[k] for k in ('call_events_total','test_code_calls','excluded_src_testing_calls','node_modules_calls','react_dev_fake_calls_recorded_as_TypeError')}, indent=1))" | tee -a "$OUT/run.log"
verdict D "$(python3 -c "import json; print(json.load(open('$OUT/d-noise.json'))['verdict']['D'])")"

# ------------------------------------------------------------------ G --
log "G. stability: sequence diagrams of run 1 vs run 2"
seq_json "$OUT/run1" "$OUT/seq-run1"
seq_json "$OUT/run2" "$OUT/seq-run2"
$PY compare-seq "$OUT/seq-run1" "$OUT/seq-run2" G > "$OUT/g-stability.json"
python3 -c "import json; r=json.load(open('$OUT/g-stability.json')); print('same', len(r['same']), 'different', len(r['different']), 'only_in_a', r['only_in_a'], 'only_in_b', r['only_in_b']); [print('  ', k, json.dumps(v)[:400]) for k, v in r['different'].items()]" | tee -a "$OUT/run.log"
verdict G "$(python3 -c "import json; print(json.load(open('$OUT/g-stability.json'))['verdict'])")"

# ------------------------------------------------------------------ I --
log "I. concurrency: each test alone vs. inside the parallel suite (run 1)"
rm -rf "$OUT/iso"; mkdir -p "$OUT/iso"
python3 - "$OUT/run1" > "$OUT/iso-tests.tsv" <<'EOF'
import glob, json, sys, os
for f in sorted(glob.glob(os.path.join(sys.argv[1], '*.appmap.json'))):
    m = json.load(open(f))
    print(m['metadata']['source_location'] + '\t' + m['metadata']['name'])
EOF
while IFS=$'\t' read -r file name; do
  rm -rf "$APP/tmp/appmap/tests"
  pattern=$(python3 -c "import re,sys; print('^' + re.escape(sys.argv[1]) + '$')" "$name")
  ( cd "$APP" && env "${TEST_ENV[@]}" npx vitest run --config vite.config.appmap.ts "$file" -t "$pattern" >>"$OUT/iso.log" 2>&1 )
  cp "$APP"/tmp/appmap/tests/*.appmap.json "$OUT/iso/" 2>/dev/null
done < "$OUT/iso-tests.tsv"
seq_json "$OUT/iso" "$OUT/seq-iso"
$PY compare-seq "$OUT/seq-run1" "$OUT/seq-iso" I > "$OUT/i-isolation.json"
python3 - "$OUT/i-isolation.json" "$OUT/g-stability.json" "$OUT/run1" <<'EOF' | tee -a "$OUT/run.log"
import json, sys, glob, os
i, g = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
unstable = set(g['different'])
print('isolated vs parallel: same', len(i['same']), 'different', len(i['different']), 'missing isolated', i['only_in_a'])
for k, v in i['different'].items():
    tag = 'ALSO UNSTABLE IN G' if k in unstable else 'LEAK SUSPECT (stable in G)'
    print(f'  {k}: {tag} {json.dumps(v)[:300]}')
# every recording's events must come only from its own test file's code or app code
bad = []
for f in glob.glob(os.path.join(sys.argv[3], '*.appmap.json')):
    m = json.load(open(f)); src = m['metadata']['source_location']
    for e in m['events']:
        p = e.get('path', '')
        if ('__tests__/' in p or '.test.' in p) and p != src:
            bad.append((os.path.basename(f), p, e.get('method_id')))
print('test-file functions recorded in another test file\'s map:', bad[:5] or 'none')
EOF
I_ISO=$(python3 - "$OUT/i-isolation.json" "$OUT/g-stability.json" <<'EOF'
import json, sys
i, g = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
leaks = [k for k in i['different'] if k not in g['different']]
print('PASS' if not leaks and not i['only_in_a'] else 'FAIL')
EOF
)
I_BR=$(python3 -c "import json; s=json.load(open('$OUT/browser-workaround-check.json'))['steps'].get('B5 two clicks 20ms apart', {}); print('FAIL' if s.get('two_interactions_merged_into_one_map', True) else 'PASS')")
verdict I "$([ "$I_ISO" = PASS ] && [ "$I_BR" = PASS ] && echo PASS || echo FAIL) (vitest isolation: $I_ISO, browser two clicks: $I_BR)"

# ------------------------------------------------------------------ H --
log "H. change detection: getComments drops the page query param"
git -C "$WORK/bulletproof-react" checkout -q -B acceptance-h-change
git -C "$WORK/bulletproof-react" apply "$HERE/app-config/h-change.patch"
git -C "$WORK/bulletproof-react" diff --stat -- apps/react-vite/src | tee -a "$OUT/run.log"
run_suite vite.config.appmap.ts "$OUT/run-h" recorded-h
git -C "$WORK/bulletproof-react" checkout -q -- apps/react-vite/src
git -C "$WORK/bulletproof-react" checkout -q --detach "$APP_SHA"
# (1) the repo's own tracing agent
node "$RECORDER_REPO/linker/bin/appmap-trace.mjs" "$OUT/run-h" --baseline "$OUT/run1" > "$OUT/h-appmap-trace.txt" 2>&1
echo "appmap-trace --baseline: $(tail -1 "$OUT/h-appmap-trace.txt")" | tee -a "$OUT/run.log"
# (2) official: sequence diagrams + sequence-diagram-diff per test
seq_json "$OUT/run-h" "$OUT/seq-run-h"
$PY compare-seq "$OUT/seq-run1" "$OUT/seq-run-h" H > "$OUT/h-seq-compare.json"
mkdir -p "$OUT/h-diff"
for f in "$OUT"/seq-run1/*.sequence.json; do
  b=$(basename "$f")
  [ -f "$OUT/seq-run-h/$b" ] || continue
  "$APPMAP" sequence-diagram-diff "$f" "$OUT/seq-run-h/$b" --format text --output-dir "$OUT/h-diff" > "$OUT/h-diff/${b%.sequence.json}.stdout" 2>&1
done
python3 - "$OUT/h-seq-compare.json" "$OUT/h-diff" <<'EOF' | tee -a "$OUT/run.log"
import json, sys, glob, os
r = json.load(open(sys.argv[1]))
print('official sequence diagrams (reported, not required), before vs after: same', len(r['same']), 'different', sorted(r['different']))
EOF
# The change is query-only (page=1 dropped). By the AppMap spec the query
# is in the event's `message`, which the official sequence diagram does not
# render, so the official diff above cannot show it: it is reported, not
# required. The change must show in appmap-trace, which reads `message`:
# in exactly the three comment-loading tests, each GET /comments that had
# page=1 is now without it, and nothing else may be marked changed in any
# test (random ids may not be normalized here, only in G and I).
H_OK=$(python3 - "$OUT/h-appmap-trace.txt" "$OUT/h-trace-check.json" <<'EOF'
import json, re, sys
text = open(sys.argv[1]).read()
expected = {'should render discussion', 'should update discussion',
            'should create and delete a comment on the discussion'}
# appmap-trace prints, per interaction: its name at column 0, an indented
# caption, the ASCII tree, then a ```mermaid block; a final "traced N" line.
blocks, name, in_mermaid = {}, None, False
for line in text.split('\n'):
    if line.startswith('```'):
        in_mermaid = not in_mermaid
        continue
    if in_mermaid:
        continue
    if re.match(r'^[A-Za-z]', line) and not line.startswith('traced '):
        name = line.strip()
        blocks[name] = []
    elif name is not None:
        blocks[name].append(line)
marks = {n: [re.sub(r'^[\s│├└─]*', '', l).split('  [')[0].strip()
             for l in lines if re.match(r'^[\s│├└─]*[+-] ', l)]
         for n, lines in blocks.items()}
old = re.compile(r'^- → network: GET /comments\?discussionId=[^&\s]+&page=1$')
new = re.compile(r'^\+ → network: GET /comments\?discussionId=[^&\s]+$')
report = {'interactions': len(blocks), 'shows_change': {}, 'other_marks': {}}
for n, m in marks.items():
    change = [x for x in m if old.match(x) or new.match(x)]
    other = [x for x in m if x not in change]
    if n in expected:
        n_old = sum(1 for x in change if old.match(x))
        report['shows_change'][n] = n_old > 0 and n_old == len(change) - n_old
    else:
        other += change
    if other:
        report['other_marks'][n] = other
report['missing_expected'] = sorted(expected - set(blocks))
ok = not report['missing_expected'] and all(report['shows_change'].get(n) for n in expected) and not report['other_marks']
report['verdict'] = 'PASS' if ok else 'FAIL'
json.dump(report, open(sys.argv[2], 'w'), indent=2)
print(report['verdict'])
EOF
)
python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print('appmap-trace: change shown in', r['shows_change'], '| missing', r['missing_expected'], '| other changed steps:', {k: v[:3] for k, v in r['other_marks'].items()})" "$OUT/h-trace-check.json" | tee -a "$OUT/run.log"
verdict H "$H_OK"

# ------------------------------------------------------------------ J --
log "J. overhead"
cat "$OUT/timings.txt" | tee -a "$OUT/run.log"
python3 - "$OUT/timings.txt" <<'EOF' | tee -a "$OUT/run.log"
import sys, statistics
t = {}
for line in open(sys.argv[1]):
    label, secs, _ = line.split()
    t.setdefault(label.rsplit('-', 1)[0], []).append(float(secs))
p, r = statistics.median(t['plain']), statistics.median(t['recorded'])
print(f'median plain {p:.1f}s, recorded {r:.1f}s, overhead {100*(r-p)/p:.0f}%')
EOF
verdict J "MEASURED"

# ----------------------------------------------------------- summary --
log "Summary"
: > "$OUT/summary.txt"
failed=0
for k in A B C D E F G H I J BROWSER; do
  echo "$k ${VERDICT[$k]:-NOT RUN}" | tee -a "$OUT/summary.txt"
  case "${VERDICT[$k]:-NOT RUN}" in PASS*|MEASURED) ;; *) failed=1 ;; esac
done
exit $failed
