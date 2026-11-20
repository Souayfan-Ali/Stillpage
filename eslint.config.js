import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.cache/**', '.output/**', '.wxt/**', 'coverage/**', 'node_modules/**', 'spikes/**'] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
);
