import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openPostgres } from '../src/connection';
import * as utils from '../src/utils';
import { Client } from 'pg';

vi.mock('pg', () => {
  const mockClient = {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
  };
  return {
    Client: vi.fn(() => mockClient),
  };
});

vi.mock('../src/utils', () => ({
  readSql: vi.fn(),
}));

describe('openPostgres', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = new Client();
    vi.clearAllMocks();
  });

  it('should connect, initialize schema, and return a client', async () => {
    const schemaSql = 'CREATE TABLE documents;';
    const hybridSql = 'CREATE FUNCTION hybrid_search;';
    vi.spyOn(utils, 'readSql').mockImplementation((name: string) => {
      if (name === 'schema') return schemaSql;
      if (name === 'hybridSearch') return hybridSql;
      return undefined;
    });

    mockClient.query.mockResolvedValue(true);

    const client = await openPostgres('test-connection-string');

    expect(Client).toHaveBeenCalledWith({ connectionString: 'test-connection-string' });
    expect(mockClient.connect).toHaveBeenCalledOnce();
    expect(mockClient.query).toHaveBeenCalledWith(schemaSql);
    expect(mockClient.query).toHaveBeenCalledWith(hybridSql);
    expect(client).toBe(mockClient);
  });

  it('should close the connection and re-throw if schema initialization fails', async () => {
    const error = new Error('Schema initialization failed');
    vi.spyOn(utils, 'readSql').mockReturnValue('CREATE TABLE documents;');
    mockClient.query.mockRejectedValue(error);

    await expect(openPostgres('test-connection-string')).rejects.toThrow(error);

    expect(mockClient.connect).toHaveBeenCalledOnce();
    expect(mockClient.end).toHaveBeenCalledOnce();
  });

  it('should not throw if SQL scripts are not found', async () => {
    vi.spyOn(utils, 'readSql').mockReturnValue(undefined);
    
    await openPostgres('test-connection-string');

    expect(mockClient.connect).toHaveBeenCalledOnce();
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.end).not.toHaveBeenCalled();
  });
});
