module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  // Pin aws-jwt-verify to root node_modules so jest.mock() intercepts it even when
  // lambda/chat.js requires it (which would otherwise resolve lambda/node_modules first).
  moduleNameMapper: {
    '^aws-jwt-verify$': '<rootDir>/node_modules/aws-jwt-verify',
  },
};
