import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// appmap-trace over real directory layouts: an edge function's request
// maps traced on their own (no frontend map) are interactions in their
// own lane, and a frontend map whose HTTP went through XMLHttpRequest
// (recorded like fetch) is traced too.

const bin = fileURLToPath(new URL('../bin/appmap-trace.mjs', import.meta.url));

function requestMap(extraGet) {
  const events = [
    { id: 1, event: 'call', thread_id: 1, http_server_request: { request_method: 'DELETE', path_info: '/restful-tasks/2' }, message: [] },
    { id: 2, event: 'call', thread_id: 1, defined_class: 'index', method_id: 'deleteTask', path: 'index.ts', lineno: 38, static: true },
  ];
  let id = 2;
  if (extraGet) {
    events.push({ id: ++id, event: 'call', thread_id: 1, http_client_request: { request_method: 'GET', url: 'http://127.0.0.1:54321/rest/v1/tasks' }, message: [{ name: 'select', class: 'String', value: '*' }, { name: 'id', class: 'String', value: 'eq.2' }] });
    events.push({ id: ++id, event: 'return', thread_id: 1, parent_id: id - 1, http_client_response: { status_code: 200 } });
  }
  const del = ++id;
  events.push({ id: del, event: 'call', thread_id: 1, http_client_request: { request_method: 'DELETE', url: 'http://127.0.0.1:54321/rest/v1/tasks' }, message: [{ name: 'id', class: 'String', value: 'eq.2' }] });
  events.push({ id: ++id, event: 'return', thread_id: 1, parent_id: del, http_client_response: { status_code: 204 } });
  events.push({ id: ++id, event: 'return', thread_id: 1, parent_id: 2, return_value: { class: 'Response', value: '{}' } });
  events.push({ id: ++id, event: 'return', thread_id: 1, parent_id: 1, http_server_response: { status_code: 200 } });
  return { version: '1.12', metadata: { name: 'DELETE /restful-tasks/2', app: 'restful-tasks', parent_span_id: '1'.repeat(16) }, classMap: [], events };
}

function write(dir, name, appmap) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.appmap.json`), JSON.stringify(appmap));
}

describe('appmap-trace CLI', () => {
  it('traces standalone backend request maps as interactions and diffs them', () => {
    const root = mkdtempSync(join(tmpdir(), 'appmap-trace-'));
    write(join(root, 'before'), 'del', requestMap(false));
    write(join(root, 'after'), 'del', requestMap(true));
    const out = join(root, 'out');
    const stdout = execFileSync(process.execPath, [bin, join(root, 'after'), '--baseline', join(root, 'before'), '--out', out], { encoding: 'utf8' });
    expect(stdout).toContain('traced 1 interaction(s)');
    const md = readFileSync(join(out, 'DELETE_restful-tasks_2.md'), 'utf8');
    expect(md).toContain('New call restful-tasks→network: GET /rest/v1/tasks?select=*&id=eq.2');
    // One inserted call: not "1 added, 3 changed" (the request, the handler
    // and deleteTask only contain the change).
    expect(md).toContain('> Behavior changed — 1 added. New call');
    expect(md).not.toContain('undefined');
  });

  it('traces a frontend map whose requests came from XMLHttpRequest', () => {
    const root = mkdtempSync(join(tmpdir(), 'appmap-trace-xhr-'));
    write(root, 'comments', {
      version: '1.12',
      metadata: { name: 'should render discussion', app: 'bulletproof-react' },
      classMap: [],
      events: [
        { id: 1, event: 'call', thread_id: 1, defined_class: 'get-comments', method_id: 'getComments', path: 'src/get-comments.ts', static: true },
        { id: 2, event: 'call', thread_id: 1, http_client_request: { request_method: 'GET', url: 'https://api.example.test/comments' }, message: [{ name: 'discussionId', class: 'String', value: 'd1' }, { name: 'page', class: 'String', value: '1' }] },
        { id: 3, event: 'return', thread_id: 1, parent_id: 2, http_client_response: { status_code: 200 } },
        { id: 4, event: 'return', thread_id: 1, parent_id: 1 },
      ],
    });
    const stdout = execFileSync(process.execPath, [bin, root, '--format', 'ascii'], { encoding: 'utf8' });
    expect(stdout).toContain('GET /comments?discussionId=d1&page=1');
    expect(stdout).toContain('traced 1 interaction(s)');
  });

  // acceptance/supabase-edge-functions-app H: every direct request to one
  // edge function is named "POST /<function>". The baseline was keyed by
  // name alone, so all of them were diffed against the last baseline map
  // (R3, which makes no outbound call): R1 and R2 showed both of their calls
  // as added, not the one query that changed.
  it('pairs same-named interactions with their baselines by occurrence', () => {
    const root = mkdtempSync(join(tmpdir(), 'appmap-trace-same-'));
    const fn = (select, calls, seq, status = 200) => ({
      version: '1.12',
      metadata: { name: 'POST /select-from-table-with-auth-rls', app: 'fn', parent_span_id: `${seq}`.padStart(16, '0') },
      classMap: [],
      events: [
        { id: 1, event: 'call', thread_id: 1, http_server_request: { request_method: 'POST', path_info: '/select-from-table-with-auth-rls' }, message: [] },
        { id: 2, event: 'call', thread_id: 1, defined_class: 'index', method_id: 'handler', path: 'index.ts', lineno: 10, static: true },
        ...(calls
          ? [
              { id: 3, event: 'call', thread_id: 1, http_client_request: { request_method: 'GET', url: 'http://127.0.0.1:54321/auth/v1/user' }, message: [] },
              { id: 4, event: 'return', thread_id: 1, parent_id: 3, http_client_response: { status_code: 200 } },
              { id: 5, event: 'call', thread_id: 1, http_client_request: { request_method: 'GET', url: 'http://127.0.0.1:54321/rest/v1/users' }, message: [{ name: 'select', class: 'String', value: select }] },
              { id: 6, event: 'return', thread_id: 1, parent_id: 5, http_client_response: { status_code: 200 } },
            ]
          : []),
        { id: 7, event: 'return', thread_id: 1, parent_id: 2 },
        { id: 8, event: 'return', thread_id: 1, parent_id: 1, http_server_response: { status_code: status } },
      ],
    });
    // file names as the recorder writes them: <name>_<span>_<seq>
    write(join(root, 'before'), 'POST_fn_0000000100000001_001', fn('*', true, 1));
    write(join(root, 'before'), 'POST_fn_0000000200000002_002', fn('*', true, 2));
    write(join(root, 'before'), 'POST_fn_0000000300000003_003', fn('*', false, 3, 400));
    write(join(root, 'after'), 'POST_fn_0000000100000007_001', fn('id', true, 7));
    write(join(root, 'after'), 'POST_fn_0000000200000008_002', fn('id', true, 8));
    write(join(root, 'after'), 'POST_fn_0000000300000009_003', fn('*', false, 9, 400));
    const out = join(root, 'out');
    execFileSync(process.execPath, [bin, join(root, 'after'), '--baseline', join(root, 'before'), '--out', out, '--format', 'ascii'], { encoding: 'utf8' });
    const r1 = readFileSync(join(out, 'POST_select-from-table-with-auth-rls.txt'), 'utf8');
    const r2 = readFileSync(join(out, 'POST_select-from-table-with-auth-rls__2.txt'), 'utf8');
    const r3 = readFileSync(join(out, 'POST_select-from-table-with-auth-rls__3.txt'), 'utf8');
    for (const t of [r1, r2]) {
      expect(t).toContain('1 added, 1 removed');
      expect(t).toContain('+ → network: GET /rest/v1/users?select=id');
      expect(t).toContain('- → network: GET /rest/v1/users?select=*');
      expect(t).not.toContain('+ → network: GET /auth/v1/user');
    }
    expect(r3).toContain('No behavior change');
  });
});
