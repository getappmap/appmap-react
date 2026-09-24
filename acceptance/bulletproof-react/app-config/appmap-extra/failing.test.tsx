// Check F: a copy of src/components/seo/__tests__/head.test.tsx whose
// assertion is deliberately wrong, so the test fails. The recording must
// still be written, marked failed.
import { Head } from '../src/components/seo/head';
import { render, waitFor } from '../src/testing/test-utils';

test('F: deliberately failing copy of the Head title test', async () => {
  render(<Head title="Hello World" description="This is a description" />);
  await waitFor(() => expect(document.title).toEqual('Hello World | Bulletproof React'));
  expect(document.title).toEqual('this is not the title');
});
