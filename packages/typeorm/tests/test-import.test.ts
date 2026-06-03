import { describe, expect, test } from 'vitest';
import { PrimaryColumn, Column, Entity, Index, DataSource } from 'typeorm';

describe('typeorm imports', () => {
  test('PrimaryColumn is a function', () => {
    expect(typeof PrimaryColumn).toBe('function');
  });
  test('Column is a function', () => {
    expect(typeof Column).toBe('function');
  });
  test('Entity is a function', () => {
    expect(typeof Entity).toBe('function');
  });
  test('Index is a function', () => {
    expect(typeof Index).toBe('function');
  });
  test('DataSource is a function', () => {
    expect(typeof DataSource).toBe('function');
  });
});
