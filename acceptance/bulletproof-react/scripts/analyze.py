#!/usr/bin/env python3
"""Checks for the bulletproof-react acceptance run.

Subcommands (each prints a JSON report and exits 0; run.sh decides PASS/FAIL
from the report's "verdict" field):

  ground-truth <tests_dir>             C: EXPECTATIONS.md items T1-T9 + E + F
  noise <tests_dir>                    D: events by package, test/vendored code
  compare-seq <dirA> <dirB> <label>    G/I: normalized sequence-diagram diff
  browser <interactions_dir> <report>  browser interaction checks (B1-B5)
"""
import collections
import glob
import json
import os
import re
import sys

API = 'https://api.bulletproofapp.com'
TRACEPARENT = re.compile(r'^00-([0-9a-f]{32})-([0-9a-f]{16})-01$')


def load_dir(d):
    maps = {}
    for f in sorted(glob.glob(os.path.join(d, '**', '*.appmap.json'), recursive=True)):
        m = json.load(open(f))
        maps[m['metadata']['name']] = (f, m)
    return maps


def calls(m):
    return [e for e in m['events'] if e['event'] == 'call' and 'method_id' in e]


def http_pairs(m):
    rets = {e['parent_id']: e for e in m['events'] if e['event'] == 'return'}
    out = []
    for e in m['events']:
        if e['event'] == 'call' and 'http_client_request' in e:
            r = rets.get(e['id'], {})
            out.append((e, r.get('http_client_response', {}).get('status_code')))
    return out


def quote(e):
    keep = {k: e[k] for k in ('id', 'thread_id', 'defined_class', 'method_id', 'path', 'lineno',
                              'http_client_request') if k in e}
    if e.get('parameters'):
        keep['parameters'] = [{'name': p.get('name'), 'value': p.get('value', '')[:120]}
                              for p in e['parameters']]
    return keep


# ---------------------------------------------------------------- C ----
def fn(path, method, lineno=None, param=None, label=None):
    return {'kind': 'function', 'path': path, 'method_id': method, 'lineno': lineno,
            'param': param, 'label': label}


def http(method, url_re, status=200):
    return {'kind': 'http', 'method': method, 'url': url_re, 'status': status}


def no_fn(path, method):
    return {'kind': 'absent', 'path': path, 'method_id': method}


F_AUTH = 'src/lib/auth.tsx'
ME = http('GET', re.escape(API + '/auth/me') + '$')
EXPECT = {
    'T1 should login new user and call onSuccess cb which should navigate the user to the app': [
        fn('src/app/provider.tsx', 'AppProvider', 17, label='component'),
        fn(F_AUTH, 'getUser', 13),
        fn('src/features/auth/components/login-form.tsx', 'LoginForm', 12, param='onSuccess', label='component'),
        fn('src/components/ui/form/form.tsx', 'Form', 182),
        fn('src/features/auth/components/login-form.tsx', 'onSubmit', 22, label='event-handler'),
        fn(F_AUTH, 'loginWithEmailAndPassword', 29, param='@'),
        ME,
        http('POST', re.escape(API + '/auth/login') + '$'),
    ],
    'T2 should register new user and call onSuccess cb which should navigate the user to the app': [
        fn(F_AUTH, 'getUser', 13),
        fn('src/features/auth/components/register-form.tsx', 'RegisterForm', 17, label='component'),
        fn('src/components/ui/form/form.tsx', 'Form', 182),
        fn('src/features/auth/components/register-form.tsx', 'onSubmit', 30, label='event-handler'),
        fn(F_AUTH, 'registerWithEmailAndPassword', 56, param='teamName'),
        ME,
        http('POST', re.escape(API + '/auth/register') + '$'),
    ],
}
T3_FNS = [
    fn('src/app/routes/app/discussions/discussion.tsx', 'DiscussionRoute', 38, label='component'),
    fn('src/features/discussions/api/get-discussion.ts', 'useDiscussion', 27, param='discussionId', label='hook'),
    fn('src/features/discussions/api/get-discussion.ts', 'getDiscussionQueryOptions', 15),
    fn('src/features/discussions/api/get-discussion.ts', 'getDiscussion', 7, param='discussionId'),
    fn('src/components/layouts/content-layout.tsx', 'ContentLayout', 10),
    fn('src/features/discussions/components/discussion-view.tsx', 'DiscussionView', 8),
    fn('src/features/discussions/components/update-discussion.tsx', 'UpdateDiscussion', 18),
    fn('src/lib/authorization.tsx', 'Authorization', 63),
    fn('src/lib/authorization.tsx', 'useAuthorization', 28, label='hook'),
    fn('src/lib/authorization.tsx', 'checkAccess', 35),
    fn('src/features/comments/components/comments.tsx', 'Comments', 8),
    fn('src/features/comments/components/create-comment.tsx', 'CreateComment', 16),
    fn('src/features/comments/components/comments-list.tsx', 'CommentsList', 19),
    fn('src/features/comments/api/get-comments.ts', 'useInfiniteComments', 43, label='hook'),
    fn('src/features/comments/api/get-comments.ts', 'getInfiniteCommentsQueryOptions', 22),
    fn('src/features/comments/api/get-comments.ts', 'getComments', 7, param='"page":1'),
    fn('src/components/ui/md-preview/md-preview.tsx', 'MDPreview', 10),
    fn('src/utils/format.ts', 'formatDate', 3),
]
DISC_ONE = http('GET', re.escape(API) + r'/discussions/[A-Za-z0-9_-]+$')
COMMENTS = http('GET', re.escape(API) + r'/comments\?discussionId=[A-Za-z0-9_-]+&page=1$')
T3_HTTP = [ME, DISC_ONE, COMMENTS]
EXPECT['T3 should render discussion'] = T3_FNS + T3_HTTP
EXPECT['T4 should update discussion'] = T3_FNS + T3_HTTP + [
    fn('src/components/ui/form/form-drawer.tsx', 'FormDrawer', 24),
    fn('src/components/ui/form/form-drawer.tsx', 'onOpenChange', 42, param='true'),
    fn('src/features/discussions/components/update-discussion.tsx', 'onSubmit', 57),
    fn('src/features/discussions/api/update-discussion.ts', 'updateDiscussion', 17, param='title'),
    http('PATCH', re.escape(API) + r'/discussions/[A-Za-z0-9_-]+$'),
    dict(DISC_ONE, count=2),
]
EXPECT['T5 should create and delete a comment on the discussion'] = T3_FNS + T3_HTTP + [
    fn('src/features/comments/components/create-comment.tsx', 'onSubmit', 53),
    fn('src/features/comments/api/create-comment.ts', 'createComment', 17, param='Hello World'),
    fn('src/features/comments/components/delete-comment.tsx', 'DeleteComment', 14),
    fn('src/components/ui/dialog/confirmation-dialog/confirmation-dialog.tsx', 'ConfirmationDialog', 27),
    fn('src/features/comments/components/delete-comment.tsx', 'onClick', 48, label='event-handler'),
    fn('src/features/comments/api/delete-comment.ts', 'deleteComment', 8, param='commentId'),
    http('POST', re.escape(API + '/comments') + '$'),
    http('DELETE', re.escape(API) + r'/comments/[A-Za-z0-9_-]+$'),
    dict(COMMENTS, count=3),
]
DISCS = http('GET', re.escape(API + '/discussions?page=1') + '$')
EXPECT['T6 should create, render and delete discussions'] = [
    fn('src/app/routes/app/discussions/discussions.tsx', 'DiscussionsRoute', 25),
    fn('src/features/discussions/components/discussions-list.tsx', 'DiscussionsList', 19),
    fn('src/features/discussions/api/get-discussions.ts', 'useDiscussions', 34, label='hook'),
    fn('src/features/discussions/api/get-discussions.ts', 'getDiscussionsQueryOptions', 20),
    fn('src/features/discussions/api/get-discussions.ts', 'getDiscussions', 7),
    fn('src/features/discussions/components/create-discussion.tsx', 'CreateDiscussion', 13),
    fn('src/features/discussions/components/create-discussion.tsx', 'onSubmit', 49),
    fn('src/features/discussions/api/create-discussion.ts', 'createDiscussion', 17, param='title'),
    fn('src/components/ui/table/table.tsx', 'Table', 138),
    fn('src/features/discussions/components/delete-discussion.tsx', 'DeleteDiscussion', 14),
    fn('src/features/discussions/components/delete-discussion.tsx', 'onClick', 43),
    fn('src/features/discussions/api/delete-discussion.ts', 'deleteDiscussion', 8, param='discussionId'),
    ME,
    dict(DISCS, count=3),
    http('POST', re.escape(API + '/discussions') + '$'),
    http('DELETE', re.escape(API) + r'/discussions/[A-Za-z0-9_-]+$'),
]
EXPECT['T7a should view protected resource if user role is matching'] = [
    fn('src/lib/authorization.tsx', 'Authorization', 63),
    fn('src/lib/authorization.tsx', 'useAuthorization', 28, label='hook'),
    fn('src/lib/authorization.tsx', 'checkAccess', 35, param='ADMIN'),
    ME,
]
EXPECT['T7b should not view protected resource if user role does not match and show fallback message instead'] = [
    fn('src/lib/authorization.tsx', 'Authorization', 63),
    fn('src/lib/authorization.tsx', 'useAuthorization', 28, label='hook'),
    fn('src/lib/authorization.tsx', 'checkAccess', 35, param='ADMIN'),
    ME,
]
EXPECT['T7c should view protected resource if policy check passes'] = [
    fn('src/lib/authorization.tsx', 'Authorization', 63),
    fn('src/lib/authorization.tsx', 'useAuthorization', 28),
    no_fn('src/lib/authorization.tsx', 'checkAccess'),
    ME,
]
EXPECT['T8a should toggle the state'] = [
    fn('src/hooks/use-disclosure.ts', 'useDisclosure', 3, label='hook'),
    dict(fn('src/hooks/use-disclosure.ts', 'toggle', 8), count=2),
]
EXPECT['T8b should open the state'] = [
    fn('src/hooks/use-disclosure.ts', 'useDisclosure', 3),
    fn('src/hooks/use-disclosure.ts', 'open', 6),
]
EXPECT['T8c should close the state'] = [
    fn('src/hooks/use-disclosure.ts', 'useDisclosure', 3),
    fn('src/hooks/use-disclosure.ts', 'close', 7),
]
EXPECT['T9 should add proper page title and meta description'] = [
    fn('src/components/seo/head.tsx', 'Head', 10, param='Hello World', label='component'),
]


def labels_of(m):
    out = {}

    def walk(nodes, pkg):
        for n in nodes:
            if n['type'] == 'function':
                out[(n['location'].rsplit(':', 1)[0], n['name'])] = n.get('labels', [])
            else:
                walk(n.get('children', []), pkg)
    walk(m['classMap'], '')
    return out


def check_item(m, item):
    if item['kind'] in ('function', 'absent'):
        hits = [e for e in calls(m) if e['path'] == item['path'] and e['method_id'] == item['method_id']]
        if item['kind'] == 'absent':
            return ('found' if not hits else 'wrong',
                    'not called (correct)' if not hits else quote(hits[0]))
        want = item.get('count', 1)
        if not hits:
            return ('missing', None)
        problems = []
        if item.get('lineno') and hits[0].get('lineno') != item['lineno']:
            problems.append(f"lineno {hits[0].get('lineno')} != {item['lineno']}")
        if item.get('param'):
            if not any(item['param'] in (p.get('value') or '') for e in hits for p in e.get('parameters', [])):
                problems.append(f"no call has a parameter containing {item['param']!r}")
        if item.get('label'):
            labels = labels_of(m).get((item['path'], item['method_id']), [])
            if item['label'] not in labels:
                problems.append(f"labels {labels} lack {item['label']!r}")
        if len(hits) < want:
            problems.append(f'called {len(hits)}x, expected >= {want}x')
        return ('wrong' if problems else 'found', {'event': quote(hits[0]), 'calls': len(hits),
                                                    'problems': problems})
    # http
    pairs = [(e, s) for e, s in http_pairs(m)
             if e['http_client_request']['request_method'] == item['method']
             and re.search(item['url'], e['http_client_request']['url'])]
    want = item.get('count', 1)
    if not pairs:
        return ('missing', None)
    problems = []
    if len(pairs) < want:
        problems.append(f'{len(pairs)}x, expected >= {want}x')
    for e, status in pairs:
        if status != item['status']:
            problems.append(f'status {status}')
        tp = (e['http_client_request'].get('headers') or {}).get('traceparent')
        mt = TRACEPARENT.match(tp or '')
        if not mt or mt.group(1) != m['metadata'].get('trace_id'):
            problems.append(f'traceparent {tp!r} does not carry trace_id')
    return ('wrong' if problems else 'found', {'event': quote(pairs[0][0]), 'problems': problems})


def ground_truth(tests_dir):
    maps = load_dir(tests_dir)
    rep = {'tests': {}, 'totals': collections.Counter()}
    for key, items in EXPECT.items():
        name = key.split(' ', 1)[1]
        entry = {'recording': None, 'items': []}
        if name not in maps:
            entry['recording'] = 'MISSING RECORDING'
            rep['totals']['missing'] += len(items)
            rep['tests'][key] = entry
            continue
        f, m = maps[name]
        entry['recording'] = os.path.basename(f)
        entry['test_status'] = m['metadata'].get('test_status')
        exc = [e for e in m['events'] if e.get('exceptions')]
        entry['exceptions_in_recording'] = len(exc)
        for item in items:
            status, evidence = check_item(m, item)
            what = (f"{item['method']} {item['url']}" if item['kind'] == 'http'
                    else f"{item['path']}:{item.get('lineno') or ''} {item['method_id']}"
                    + (' (must NOT be called)' if item['kind'] == 'absent' else ''))
            entry['items'].append({'expect': what, 'status': status, 'evidence': evidence})
            rep['totals'][status] += 1
        if exc:
            entry['items'].append({'expect': 'no exceptions', 'status': 'wrong',
                                   'evidence': [quote(e) for e in exc[:3]]})
            rep['totals']['wrong'] += 1
        rep['tests'][key] = entry
    # E and F (extra tests, same directory)
    e_name = 'E: Authorization without a user throws in useAuthorization'
    f_name = 'F: deliberately failing copy of the Head title test'
    rep['E'] = {'recording': None}
    if e_name in maps:
        m = maps[e_name][1]
        cm = {e['id']: e for e in calls(m)}
        thrown = [e for e in m['events'] if e['event'] == 'return' and e.get('exceptions')
                  and cm.get(e['parent_id'], {}).get('method_id') == 'useAuthorization'
                  and e['exceptions'][0].get('class') == 'Error'
                  and e['exceptions'][0].get('message') == 'User does not exist!']
        other = [{'method_id': cm.get(e['parent_id'], {}).get('method_id'), 'exceptions': e['exceptions']}
                 for e in m['events'] if e['event'] == 'return' and e.get('exceptions')
                 and not (cm.get(e['parent_id'], {}).get('method_id') in ('useAuthorization', 'Authorization')
                          and e['exceptions'][0].get('message') == 'User does not exist!')]
        rep['E'] = {'recording': os.path.basename(maps[e_name][0]),
                    'useAuthorization_throws_recorded': len(thrown),
                    'example': thrown[0] if thrown else None,
                    'other_exception_returns': other,
                    'object_id_on_exceptions': all('object_id' in x for e in thrown for x in e['exceptions'])}
    rep['F'] = {'recording': None}
    if f_name in maps:
        m = maps[f_name][1]
        rep['F'] = {'recording': os.path.basename(maps[f_name][0]),
                    'test_status': m['metadata'].get('test_status'),
                    'test_failure': m['metadata'].get('test_failure'),
                    'has_Head_call': any(e['method_id'] == 'Head' for e in calls(m))}
    t = rep['totals']
    rep['verdict'] = {
        'C': 'PASS' if t['missing'] == 0 and t['wrong'] == 0 else 'FAIL',
        'E': 'PASS' if rep['E'].get('useAuthorization_throws_recorded') else 'FAIL',
        'F': 'PASS' if rep['F'].get('test_status') == 'failed' and rep['F'].get('has_Head_call') else 'FAIL',
    }
    rep['totals'] = dict(t)
    return rep


# ---------------------------------------------------------------- D ----
def noise(tests_dir):
    maps = load_dir(tests_dir)
    by_pkg = collections.Counter()
    test_code = collections.Counter()
    excluded = collections.Counter()
    vendored = collections.Counter()
    fake_react_calls = 0
    for name, (f, m) in maps.items():
        cm = {e['id']: e for e in calls(m)}
        for e in calls(m):
            p = e['path']
            by_pkg[os.path.dirname(p)] += 1
            if '__tests__/' in p or re.search(r'\.test\.[jt]sx?$', p) or p.startswith('appmap-extra/'):
                test_code[f"{p}:{e.get('lineno')} {e['method_id']}"] += 1
            if p.startswith('src/testing/'):
                excluded[f"{p} {e['method_id']}"] += 1
            if 'node_modules' in p:
                vendored[f"{p} {e['method_id']}"] += 1
        for e in m['events']:
            if e['event'] == 'return' and e.get('exceptions'):
                msg = e['exceptions'][0].get('message', '')
                if msg.startswith("Cannot destructure property") and 'of \'undefined\'' in msg:
                    fake_react_calls += 1
    total = sum(by_pkg.values())
    app_test_code = {k: v for k, v in test_code.items() if not k.startswith('appmap-extra/')}
    return {
        'recordings': len(maps),
        'call_events_total': total,
        'call_events_by_package': dict(by_pkg.most_common()),
        'test_code_calls': dict(test_code),
        'excluded_src_testing_calls': dict(excluded),
        'node_modules_calls': dict(vendored),
        'react_dev_fake_calls_recorded_as_TypeError': fake_react_calls,
        'verdict': {'D': 'PASS' if not app_test_code and not excluded and not vendored else 'FAIL'},
    }


# ---------------------------------------------------------------- G/I --
def norm_seq(node):
    if isinstance(node, dict):
        return {k: norm_seq(v) for k, v in sorted(node.items())
                if k not in ('elapsed', 'eventIds')}
    if isinstance(node, list):
        return [norm_seq(v) for v in node]
    return node


def flat_calls(actions, depth=0, out=None):
    out = [] if out is None else out
    for a in actions or []:
        out.append(('  ' * depth) + f"{a.get('callee', '')}::{a.get('name', a.get('route', ''))}"
                   + (' !exc' if (a.get('stableProperties') or {}).get('raises_exception') else ''))
        flat_calls(a.get('children'), depth + 1, out)
    return out


def first_diff(a, b):
    import difflib
    d = list(difflib.unified_diff(a, b, lineterm='', n=0))
    return [x for x in d if not x.startswith(('---', '+++', '@@'))][:8]


def compare_seq(dir_a, dir_b, label):
    def load(d):
        out = {}
        for f in glob.glob(os.path.join(d, '*.sequence.json')):
            out[os.path.basename(f)] = json.load(open(f))
        return out
    a, b = load(dir_a), load(dir_b)
    rep = {'label': label, 'a': dir_a, 'b': dir_b, 'only_in_a': sorted(set(a) - set(b)),
           'only_in_b': sorted(set(b) - set(a)), 'same': [], 'different': {}}
    for k in sorted(set(a) & set(b)):
        if norm_seq(a[k]) == norm_seq(b[k]):
            rep['same'].append(k)
        else:
            fa, fb = flat_calls(a[k].get('rootActions')), flat_calls(b[k].get('rootActions'))
            rep['different'][k] = {'calls_a': len(fa), 'calls_b': len(fb),
                                   'same_call_tree': fa == fb, 'first_lines_of_diff': first_diff(fa, fb)}
    rep['verdict'] = 'PASS' if not rep['different'] and not rep['only_in_a'] and not rep['only_in_b'] else 'FAIL'
    return rep


# ---------------------------------------------------------------- browser
BROWSER_EXPECT = {
    'B1 register': {
        'fns': [('src/features/auth/components/register-form.tsx', 'onSubmit'),
                ('src/lib/auth.tsx', 'registerWithEmailAndPassword'),
                ('src/app/routes/auth/register.tsx', 'onSuccess')],
        'http': [('POST', r'^http://localhost:8080/api/auth/register$')]},
    'B2 list page': {
        'fns': [('src/app/routes/app/discussions/discussions.tsx', 'DiscussionsRoute'),
                ('src/features/discussions/components/discussions-list.tsx', 'DiscussionsList'),
                ('src/features/discussions/api/get-discussions.ts', 'getDiscussions')],
        'http': [('GET', r'^http://localhost:8080/api/discussions\?page=1$')]},
    'B3 open create drawer': {
        'fns': [('src/components/ui/form/form-drawer.tsx', 'onOpenChange')], 'http': []},
    'B4 create item': {
        'fns': [('src/features/discussions/components/create-discussion.tsx', 'onSubmit'),
                ('src/features/discussions/api/create-discussion.ts', 'createDiscussion')],
        'http': [('POST', r'^http://localhost:8080/api/discussions$'),
                 ('GET', r'^http://localhost:8080/api/discussions\?page=1$')]},
}


def browser(inter_dir, report_path):
    r = json.load(open(report_path))
    rep = {'steps': {}, 'wire': r['wire'], 'blockedExternal': r.get('blockedExternal'),
           'console_errors': [c for c in r['console'] if c.startswith('error')][:10]}
    ok = True
    for step in r['steps']:
        name = step['name']
        entry = {'newMaps': step['newMaps']}
        if name in BROWSER_EXPECT:
            if len(step['newMaps']) != 1:
                entry['one_map_per_interaction'] = False
                ok = False
            else:
                entry['one_map_per_interaction'] = True
            items = []
            for fname in step['newMaps'][:1]:
                m = json.load(open(os.path.join(inter_dir, fname)))
                entry['metadata_name'] = m['metadata']['name']
                entry['truncated'] = m['metadata'].get('truncated', False)
                for path, meth in BROWSER_EXPECT[name]['fns']:
                    hit = [e for e in calls(m) if e['path'] == path and e['method_id'] == meth]
                    items.append({'expect': f'{path} {meth}', 'status': 'found' if hit else 'missing',
                                  'evidence': quote(hit[0]) if hit else None})
                for meth, url in BROWSER_EXPECT[name]['http']:
                    hit = [e for e, s in http_pairs(m) if e['http_client_request']['request_method'] == meth
                           and re.search(url, e['http_client_request']['url'])]
                    items.append({'expect': f'{meth} {url}', 'status': 'found' if hit else 'missing',
                                  'evidence': quote(hit[0]) if hit else None})
            entry['items'] = items
            if any(i['status'] != 'found' for i in items):
                ok = False
        else:
            # B5: two clicks ~20 ms apart
            entry['maps'] = []
            for fname in step['newMaps']:
                m = json.load(open(os.path.join(inter_dir, fname)))
                methods = sorted({e['method_id'] for e in calls(m)})
                entry['maps'].append({'file': fname, 'name': m['metadata']['name'],
                                      'has_users_work': 'getUsers' in methods,
                                      'has_dashboard_work': 'DashboardRoute' in methods})
            merged = any(x['has_users_work'] and x['has_dashboard_work'] for x in entry['maps'])
            entry['two_interactions_merged_into_one_map'] = merged
            if merged or len(step['newMaps']) != 2:
                ok = False
        rep['steps'][name] = entry
    rep['wire_traceparent_present'] = sum(1 for w in r['wire'] if w['traceparent'])
    rep['wire_requests'] = len(r['wire'])
    if rep['wire_traceparent_present'] != rep['wire_requests']:
        ok = False
    rep['verdict'] = 'PASS' if ok and r['steps'] else 'FAIL'
    return rep


if __name__ == '__main__':
    cmd, *args = sys.argv[1:]
    out = {'ground-truth': lambda: ground_truth(*args), 'noise': lambda: noise(*args),
           'compare-seq': lambda: compare_seq(*args), 'browser': lambda: browser(*args)}[cmd]()
    json.dump(out, sys.stdout, indent=2, default=str)
    sys.stdout.write('\n')
