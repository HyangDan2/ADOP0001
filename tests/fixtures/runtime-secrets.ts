/**
 * Dummy credentials for the Phase 5C.1 correction tests.
 *
 * Every value is assembled from parts at runtime, so a static secret scanner does
 * not read the fixture as a committed credential (GitHub secret scanning flagged an
 * earlier literal). This is also the C-FIX-006 requirement that test secrets stay
 * out of the source as literals.
 */

export const DUMMY_OPENAI_KEY = ['sk', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');
export const DUMMY_GITHUB_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
export const DUMMY_JWT = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
].join('.');
export const DUMMY_BASE64_MEDIA = `data:image/png;base64,${'iVBORw0KGgo'.repeat(10)}`;
export const DUMMY_PASSWORD = ['hunter', '22'].join('');
