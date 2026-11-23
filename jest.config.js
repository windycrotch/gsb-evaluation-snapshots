module.exports = {
  testEnvironment: 'node',
  setupFiles: [
    '<rootDir>/tests/helpers/setup.js'
  ],
  testMatch: [
    '<rootDir>/tests/**/*.test.(js|jsx)'
  ],
  clearMocks: true
};
