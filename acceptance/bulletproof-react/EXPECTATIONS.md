# Expectations: bulletproof-react (apps/react-vite) under the React recorder

Written from the app source **before any recording was made**. Not to be
edited after the first recording; if something here turns out wrong, that
goes in RESULTS.md.

Target: `alan2207/bulletproof-react` @ `9506629ed003a561c6627735480cce4994244bb4`,
app `apps/react-vite`. All paths below are relative to `apps/react-vite/`.

Recorder config used (plugin options, the documented appmap.yml equivalent):
`include: ['src'], exclude: ['src/testing']` (src/testing is the app's MSW
mock backend + test utils = test-support code).

## Ground facts about the app that shape every expectation

- **HTTP goes through axios, not `fetch`.** `src/lib/api-client.ts:17`
  (`Axios.create({ baseURL: env.API_URL })`); axios is 1.6.8 in
  `yarn.lock`, whose adapters are `xhr` then `http` (no fetch adapter in
  1.6.x). In jsdom and in Chromium it uses `XMLHttpRequest`. A correct
  recording of this app must still contain the outbound HTTP calls
  (`http_client_request` / `http_client_response`), because that is what
  the app does; how the recorder hooks them is its problem.
- Under Vitest, `API_URL` = `https://api.bulletproofapp.com` (the value in
  `.env.example`, passed as env var `VITE_APP_API_URL`); MSW
  (`src/testing/mocks/server.ts`) answers in-process. No request leaves
  the machine.
- In the browser runs, `API_URL` = `http://localhost:8080/api`, answered
  by the app's own mock server (`mock-server.ts`, express + the same MSW
  handlers).
- SQL: none. This is a browser app. The "db" is `@mswjs/data` inside the
  mock backend (`src/testing/mocks/db.ts`), which is excluded test-support
  code. Expected SQL events: **zero** in every recording.
- Every `http_client_request` must carry a `traceparent` header of the form
  `00-<metadata.trace_id>-<16 hex>-01` (recorder README / docs/design/02).
- Naming: the recorder names a function `defined_class` = module basename,
  `method_id` = function name, `path` = file path. Components get label
  `component`, `use*` get `hook`, inline JSX `on*` arrows and nested
  closures get `event-handler`.

Handler line numbers (MSW, `src/testing/mocks/handlers/`):
`auth.ts:30` POST /auth/register, `auth.ts:112` POST /auth/login,
`auth.ts:152` GET /auth/me, `comments.ts:14` GET /comments,
`comments.ts:75` POST /comments, `comments.ts:98` DELETE /comments/:id,
`discussions.ts:19` GET /discussions, `discussions.ts:81` GET
/discussions/:id, `discussions.ts:133` POST /discussions,
`discussions.ts:158` PATCH /discussions/:id, `discussions.ts:193` DELETE
/discussions/:id.

## Vitest tests (the app's own suite)

### T1. `src/features/auth/components/__tests__/login-form.test.tsx` — "should login new user and call onSuccess cb ..."
- Functions:
  - `AppProvider` (`src/app/provider.tsx:17`) [component] — via `renderApp`.
  - `getUser` (`src/lib/auth.tsx:13`) — AuthLoader's `userFn` (`auth.tsx:63`), called on mount.
  - `LoginForm` (`src/features/auth/components/login-form.tsx:12`) [component], props contain `onSuccess`.
  - `Form` (`src/components/ui/form/form.tsx:182`) [component].
  - inline `onSubmit` arrow (`login-form.tsx:22`) [event-handler], called once with `{email, password}` after the click.
  - `loginWithEmailAndPassword` (`src/lib/auth.tsx:29`), called once, arg contains the user's email.
- HTTP (in this order):
  1. `GET https://api.bulletproofapp.com/auth/me` → 200 (`auth.ts:152`; no cookie, `requireAuth` returns `{user:null}` without throwing, handler returns `{data:null}` 200).
  2. `POST https://api.bulletproofapp.com/auth/login` → 200 (`auth.ts:112`), after the `onSubmit` call.
- Exceptions: none. Status: succeeded.

### T2. `src/features/auth/components/__tests__/register-form.test.tsx` — "should register new user ..."
- Functions: `AppProvider`, `getUser` (`auth.tsx:13`), `RegisterForm` (`register-form.tsx:17`) [component], `Form` (`form.tsx:182`), inline `onSubmit` (`register-form.tsx:30`) [event-handler] called once, `registerWithEmailAndPassword` (`auth.tsx:56`) called once with firstName/lastName/email/password/teamName.
- HTTP: `GET .../auth/me` → 200, then `POST https://api.bulletproofapp.com/auth/register` → 200 (`auth.ts:30`).
- Exceptions: none.

### T3. `src/app/routes/app/discussions/__tests__/discussion.test.tsx` — "should render discussion"
- Functions: `DiscussionRoute` (`src/app/routes/app/discussions/discussion.tsx:38`) [component];
  `useDiscussion` (`src/features/discussions/api/get-discussion.ts:27`) [hook] with `{discussionId}`;
  `getDiscussionQueryOptions` (`get-discussion.ts:15`); `getDiscussion` (`get-discussion.ts:7`) with `{discussionId: <id>}`;
  `ContentLayout` (`src/components/layouts/content-layout.tsx:10`); `DiscussionView` (`src/features/discussions/components/discussion-view.tsx:8`);
  `UpdateDiscussion` (`update-discussion.tsx:18`); `Authorization` (`src/lib/authorization.tsx:63`) + `useAuthorization` (`authorization.tsx:28`) [hook] + `checkAccess` (`authorization.tsx:35`, useCallback) returning true (user is ADMIN — `createUser()` defaults, team creator);
  `Comments` (`src/features/comments/components/comments.tsx:8`); `CreateComment` (`create-comment.tsx:16`); `CommentsList` (`comments-list.tsx:19`);
  `useInfiniteComments` (`src/features/comments/api/get-comments.ts:43`) [hook]; `getInfiniteCommentsQueryOptions` (`get-comments.ts:22`); `getComments` (`get-comments.ts:7`) with `{discussionId, page: 1}`;
  `MDPreview` (`src/components/ui/md-preview/md-preview.tsx:10`); `formatDate` (`src/utils/format.ts:3`).
- HTTP: `GET .../auth/me` → 200; `GET https://api.bulletproofapp.com/discussions/<id>` → 200 (`discussions.ts:81`); `GET https://api.bulletproofapp.com/comments?discussionId=<id>&page=1` → 200 (`comments.ts:14`).
- Exceptions: none.

### T4. same file — "should update discussion"
- Everything in T3, plus: `FormDrawer` (`src/components/ui/form/form-drawer.tsx:24`) and its inline `onOpenChange` (`form-drawer.tsx:42`) [event-handler] called with `true`;
  inline `onSubmit` (`update-discussion.tsx:57`) [event-handler]; `updateDiscussion` (`src/features/discussions/api/update-discussion.ts:17`) with `{data:{title, body}, discussionId}`.
- HTTP additionally: `PATCH https://api.bulletproofapp.com/discussions/<id>` → 200 (`discussions.ts:158`), then a second `GET .../discussions/<id>` → 200 (the `refetchQueries` in `update-discussion.ts:40`).
- Exceptions: none.

### T5. same file — "should create and delete a comment on the discussion"
- Everything in T3, plus: inline `onSubmit` (`create-comment.tsx:53`); `createComment` (`src/features/comments/api/create-comment.ts:17`) with `{data:{body:'Hello World', discussionId}}`;
  `DeleteComment` (`delete-comment.tsx:14`); `ConfirmationDialog` (`src/components/ui/dialog/confirmation-dialog/confirmation-dialog.tsx:27`);
  inline `onClick` (`delete-comment.tsx:48`) [event-handler]; `deleteComment` (`src/features/comments/api/delete-comment.ts:8`) with `{commentId}`.
- HTTP additionally, in order: `POST https://api.bulletproofapp.com/comments` → 200 (`comments.ts:75`); `GET .../comments?discussionId=<id>&page=1` → 200 (invalidate, `create-comment.ts:40`);
  `DELETE https://api.bulletproofapp.com/comments/<commentId>` → 200 (`comments.ts:98`); `GET .../comments?...` → 200 (invalidate, `delete-comment.ts:28`).
- Exceptions: none.

### T6. `src/app/routes/app/discussions/__tests__/discussions.test.tsx` — "should create, render and delete discussions"
- Functions: `DiscussionsRoute` (`discussions.tsx:25`); `DiscussionsList` (`src/features/discussions/components/discussions-list.tsx:19`);
  `useDiscussions` (`get-discussions.ts:34`) [hook]; `getDiscussionsQueryOptions` (`get-discussions.ts:20`); `getDiscussions` (`get-discussions.ts:7`) with page 1;
  `CreateDiscussion` (`create-discussion.tsx:13`); inline `onSubmit` (`create-discussion.tsx:49`); `createDiscussion` (`src/features/discussions/api/create-discussion.ts:17`) with `{data:{title, body}}`;
  `Table` (`src/components/ui/table/table.tsx:138`); `DeleteDiscussion` (`delete-discussion.tsx:14`); inline `onClick` (`delete-discussion.tsx:43`); `deleteDiscussion` (`src/features/discussions/api/delete-discussion.ts:8`) with `{discussionId}`.
- HTTP in order: `GET .../auth/me` → 200; `GET https://api.bulletproofapp.com/discussions?page=1` → 200 (`discussions.ts:19`);
  `POST https://api.bulletproofapp.com/discussions` → 200 (`discussions.ts:133`); `GET .../discussions?page=1` → 200 (invalidate, `create-discussion.ts:38`);
  `DELETE https://api.bulletproofapp.com/discussions/<id>` → 200 (`discussions.ts:193`); `GET .../discussions?page=1` → 200 (invalidate, `delete-discussion.ts:29`).
- Exceptions: none (the test silences `console.error`, `discussions.test.tsx:15-17`, but no app function is expected to throw).

### T7. `src/lib/__tests__/authorization.test.tsx` — "should view protected resource if user role is matching" / "... does not match ..."
- Functions: `Authorization` (`authorization.tsx:63`); `useAuthorization` (`authorization.tsx:28`) [hook]; `checkAccess` (`authorization.tsx:35`) called with `{allowedRoles:['ADMIN']}` returning `true` (ADMIN user) / `false` (USER user).
- HTTP: `GET .../auth/me` → 200.
- The two policyCheck tests: `Authorization` + `useAuthorization`, **no** `checkAccess` call (`authorization.tsx:73` only calls it when `allowedRoles` is set).

### T8. `src/hooks/__tests__/use-disclosure.test.ts` — "should toggle the state" (and siblings)
- Functions: `useDisclosure` (`src/hooks/use-disclosure.ts:3`) [hook]; `toggle` (`use-disclosure.ts:8`, useCallback) called exactly 2× in "should toggle the state"; `open` (`use-disclosure.ts:6`) 1× in "should open the state"; `close` (`use-disclosure.ts:7`) 1× in "should close the state".
- HTTP: none. Exceptions: none.

### T9. `src/components/seo/__tests__/head.test.tsx`
- Functions: `Head` (`src/components/seo/head.tsx:10`) [component], props `{title:'Hello World', description:'This is a description'}`. HTTP: none.

## Exception check (E) — extra test file kept outside the app tree
Renders `<Authorization allowedRoles={['ADMIN']}>` inside `AppProvider` with
no logged-in user. `useAuthorization` must throw `Error('User does not exist!')`
(`src/lib/authorization.tsx:31-33`). The recording must contain the
`return` event of `useAuthorization` with
`exceptions: [{class: 'Error', message: 'User does not exist!'}]`, preceded
by `GET .../auth/me` → 200.

## Failing test (F) — extra test file kept outside the app tree
A copy of T9 whose assertion expects the wrong title. The recording must
still be written, with `metadata.test_status: "failed"`, and still contain
the `Head` call.

## Noise (D)
- Nothing from `node_modules` (react, react-query, axios, radix, msw).
- Nothing from `src/testing/**` (excluded): no `authenticate`, `requireAuth`, `hash`, MSW handler closures, `initializeDb`.
- Nothing defined in test files: e.g. `TestDialog` (`src/components/ui/dialog/__tests__/dialog.test.tsx:20`) and `TestDrawer` (`drawer.test.tsx:19`) are test code and should not be recorded.
- Storybook files (`*.stories.tsx`) are not loaded by tests; they must not appear.

## Browser interaction recording (real Chromium, dev server + plugin `app` option)
Backend: `mock-server.ts` on `localhost:8080`, `VITE_APP_API_URL=http://localhost:8080/api`.
One AppMap per interaction must land in `tmp/appmap/interactions/`.

- **B1 register**: on `/auth/register`, fill the form and click "Register".
  Map named after the click on the Register button. Contains inline `onSubmit`
  (`register-form.tsx:30`), `registerWithEmailAndPassword` (`auth.tsx:56`),
  `POST http://localhost:8080/api/auth/register` → 200 with a `traceparent`
  header that was also actually sent on the wire, and the `onSuccess`
  arrow (`src/app/routes/auth/register.tsx:24`) that navigates to `/app`.
- **B2 list page**: click the "Discussions" nav link. Contains
  `DiscussionsRoute` (`discussions.tsx:25`), `DiscussionsList`,
  `getDiscussions` (`get-discussions.ts:7`) and
  `GET http://localhost:8080/api/discussions?page=1` → 200 (+ traceparent).
- **B3 open drawer**: click "Create Discussion". Contains `onOpenChange`
  (`form-drawer.tsx:42`) with `true`. No HTTP.
- **B4 create item**: fill title/body, click "Submit". Contains `onSubmit`
  (`create-discussion.tsx:49`), `createDiscussion` (`create-discussion.ts:17`),
  `POST http://localhost:8080/api/discussions` → 200 then
  `GET http://localhost:8080/api/discussions?page=1` → 200.
- **B5 concurrency**: two clicks fired ~20 ms apart. Per doc 04 the second
  is absorbed into the first window; each resulting map must contain only
  the work of the clicks it names, and no map may contain work from an
  interaction before or after it.
