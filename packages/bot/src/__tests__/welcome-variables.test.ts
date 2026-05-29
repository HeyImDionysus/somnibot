import { describe, it, expect } from 'vitest';
import { formatDuration, interpolateMessage, type WelcomeVariables } from '../features/welcome/welcome-variables.js';

describe('formatDuration', () => {
  it('returns "less than a minute" for very short durations', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 5_000))).toBe('less than a minute');
  });

  it('returns minutes', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 3 * 60_000))).toBe('3 minutes');
  });

  it('returns singular minute', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 90_000))).toBe('1 minute');
  });

  it('returns hours', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 5 * 3_600_000))).toBe('5 hours');
  });

  it('returns singular hour', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 3_600_000))).toBe('1 hour');
  });

  it('returns days', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 10 * 86_400_000))).toBe('10 days');
  });

  it('returns singular day', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 86_400_000))).toBe('1 day');
  });

  it('returns months', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 90 * 86_400_000))).toBe('3 months');
  });

  it('returns singular month', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 31 * 86_400_000))).toBe('1 month');
  });

  it('returns years', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 400 * 86_400_000))).toBe('1 year');
  });

  it('returns plural years', () => {
    const now = new Date();
    expect(formatDuration(new Date(now.getTime() - 800 * 86_400_000))).toBe('2 years');
  });
});

describe('interpolateMessage', () => {
  const vars: WelcomeVariables = {
    user: '<@123>',
    'user.name': 'Alice',
    'user.tag': 'Alice#0',
    'user.avatar': 'https://cdn.example.com/avatar.png',
    server: 'Test Server',
    'server.icon': 'https://cdn.example.com/icon.png',
    memberCount: '42',
    memberNumber: '#42',
    level: '5',
    duration: '3 days',
  };

  it('replaces known variables', () => {
    expect(interpolateMessage('Welcome {user} to {server}!', vars)).toBe('Welcome <@123> to Test Server!');
  });

  it('replaces dotted variables', () => {
    expect(interpolateMessage('Hi {user.name}, tag: {user.tag}', vars)).toBe('Hi Alice, tag: Alice#0');
  });

  it('leaves unknown variables as-is', () => {
    expect(interpolateMessage('Hello {unknown}!', vars)).toBe('Hello {unknown}!');
  });

  it('handles template with no variables', () => {
    expect(interpolateMessage('No variables here', vars)).toBe('No variables here');
  });

  it('handles multiple occurrences', () => {
    expect(interpolateMessage('{user} {user} {server}', vars)).toBe('<@123> <@123> Test Server');
  });
});
