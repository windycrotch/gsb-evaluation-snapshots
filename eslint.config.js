import js from '@eslint/js';
import { importX } from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Layers, lowest first: core knows nothing of the rest, the store knows nothing of the editor and the player. */
const layer = (from, ...banned) => ({
  target: `./src/${from}`,
  from: banned.map((b) => `./src/${b}`),
});

export default tseslint.config(
  { ignores: ['dist', 'dist-cli', 'node_modules', 'docs', 'tests/fixtures', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  importX.flatConfigs.typescript,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: './tsconfig.json' })],
    },
    plugins: { 'import-x': importX, 'react-hooks': reactHooks },
    rules: {
      // the classic two; the React Compiler rules of the plugin do not apply: the compiler is not used
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // async handlers in JSX attributes are fine: React ignores what they return
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'import-x/no-cycle': 'error',
      'import-x/no-restricted-paths': [
        'error',
        { zones: [layer('core', 'store', 'editor', 'render', 'player'), layer('store', 'editor', 'player')] },
      ],
    },
  },
  {
    // Spine files are untyped JSON and bytes: reading them is dynamic by nature.
    files: ['src/core/export/spineBinary.ts', 'src/core/export/scale.ts', 'src/core/import/{spineBinary,spineJson,legacy}.ts', 'tests/**'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
    },
  },
  {
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/await-thenable': 'off',
      'no-dupe-else-if': 'off', // the fuzz steps draw random numbers in their conditions
    },
  },
  { files: ['*.js'], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
