// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installInteractionRecorder } from '../src/interactionRecording';

// Overlapping interactions (docs/design/04): the browser has no async
// context, so two interactions fired close together cannot be told
// apart. They must not be merged *silently* under the first one's name.

describe('interaction recorder: overlapping interactions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('marks a window that absorbed a second interaction as ambiguous and names both', async () => {
    const shipped: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        shipped.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }),
    );
    document.body.innerHTML = '<a id="users">Users</a><a id="dashboard">Dashboard</a>';
    const uninstall = installInteractionRecorder({ app: 'test', idleMs: 20 });
    try {
      document.getElementById('users')!.click();
      await new Promise((r) => setTimeout(r, 5));
      document.getElementById('dashboard')!.click();
      await vi.waitFor(() => expect(shipped).toHaveLength(1), { timeout: 2000 });
    } finally {
      uninstall();
    }

    const { metadata } = shipped[0];
    expect(metadata.ambiguous).toBe(true);
    expect(metadata.interactions).toEqual(['click a "Users"', 'click a "Dashboard"']);
    expect(metadata.name).toBe('click a "Users" + click a "Dashboard"');
  });

  it('leaves a single-interaction window unmarked', async () => {
    const shipped: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        shipped.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }),
    );
    document.body.innerHTML = '<button>Save</button>';
    const uninstall = installInteractionRecorder({ app: 'test', idleMs: 20 });
    try {
      document.querySelector('button')!.click();
      await vi.waitFor(() => expect(shipped).toHaveLength(1), { timeout: 2000 });
    } finally {
      uninstall();
    }
    expect(shipped[0].metadata.name).toBe('click button "Save"');
    expect(shipped[0].metadata.ambiguous).toBeUndefined();
    expect(shipped[0].metadata.interactions).toBeUndefined();
  });

  it('treats the submit a click causes as the same interaction', async () => {
    const shipped: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        shipped.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }),
    );
    document.body.innerHTML = '<form><button type="submit">Find Owner</button></form>';
    const submits: Event[] = [];
    document.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      submits.push(e);
    });
    const uninstall = installInteractionRecorder({ app: 'test', idleMs: 20 });
    try {
      document.querySelector('button')!.click();
      await vi.waitFor(() => expect(shipped).toHaveLength(1), { timeout: 2000 });
    } finally {
      uninstall();
    }
    expect(submits).toHaveLength(1);
    expect(shipped[0].metadata.name).toBe('click button "Find Owner"');
    expect(shipped[0].metadata.ambiguous).toBeUndefined();
  });
});

describe('interaction recorder: the page load', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A request the page makes while loading, before any click (e.g.
  // bulletproof-react's GET /auth/me), had no window: it was neither
  // recorded nor stamped.
  it('recordPageLoad records the initial load in its own window, stamped', async () => {
    const shipped: any[] = [];
    const sent: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/__appmap/interactions')) shipped.push(JSON.parse(String(init!.body)));
        else sent.push(new Request(input, init));
        return new Response('{}', { status: 200 });
      }),
    );
    const uninstall = installInteractionRecorder({ app: 'test', idleMs: 20, recordPageLoad: true });
    try {
      await fetch('http://localhost:3000/api/auth/me'); // the app, loading (same origin as the page)
      await vi.waitFor(() => expect(shipped).toHaveLength(1), { timeout: 2000 });
    } finally {
      uninstall();
    }
    expect(shipped[0].metadata.name).toBe('load /');
    const call = shipped[0].events.find((e: any) => e.http_client_request);
    expect(call.http_client_request.url).toBe('http://localhost:3000/api/auth/me');
    expect(sent[0].headers.get('traceparent')).toBe(call.http_client_request.headers.traceparent);
  });

  it('is off by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const uninstall = installInteractionRecorder({ app: 'test', idleMs: 20 });
    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });
});
