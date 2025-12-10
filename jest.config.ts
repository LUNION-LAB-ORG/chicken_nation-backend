import type { JestConfigWithTsJest } from 'ts-jest';

const config: JestConfigWithTsJest = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1', // pour les imports absolus comme 'src/database/...'
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
};

export default config;
