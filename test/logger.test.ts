import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../src/logger';

describe('createLogger', () => {
  const consoleSpies = {
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log debug messages when level is debug', () => {
    const logger = createLogger('debug');
    logger.debug('test message');
    expect(consoleSpies.debug).toHaveBeenCalledWith('test message');
  });

  it('should log info messages when level is info', () => {
    const logger = createLogger('info');
    logger.info('test message');
    expect(consoleSpies.info).toHaveBeenCalledWith('test message');
  });

  it('should log warn messages when level is warn', () => {
    const logger = createLogger('warn');
    logger.warn('test message');
    expect(consoleSpies.warn).toHaveBeenCalledWith('test message');
  });

  it('should log error messages when level is error', () => {
    const logger = createLogger('error');
    logger.error('test message');
    expect(consoleSpies.error).toHaveBeenCalledWith('test message');
  });

  it('should not log any messages when level is silent', () => {
    const logger = createLogger('silent');
    logger.debug('test');
    logger.info('test');
    logger.warn('test');
    logger.error('test');
    expect(consoleSpies.debug).not.toHaveBeenCalled();
    expect(consoleSpies.info).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.error).not.toHaveBeenCalled();
  });

  it('should default to info level if no level is provided', () => {
    const logger = createLogger();
    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(consoleSpies.debug).not.toHaveBeenCalled();
    expect(consoleSpies.info).toHaveBeenCalledWith('info');
    expect(consoleSpies.warn).toHaveBeenCalledWith('warn');
    expect(consoleSpies.error).toHaveBeenCalledWith('error');
  });

  it('should only log messages at or above the specified log level', () => {
    const logger = createLogger('warn');
    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(consoleSpies.debug).not.toHaveBeenCalled();
    expect(consoleSpies.info).not.toHaveBeenCalled();
    expect(consoleSpies.warn).toHaveBeenCalledWith('warn');
    expect(consoleSpies.error).toHaveBeenCalledWith('error');
  });
});
