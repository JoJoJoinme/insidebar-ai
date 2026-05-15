import { describe, expect, it } from 'vitest';
import {
  formatContentWithSource,
  formatExtractedContentWithSource,
  shouldIncludeSourceUrl
} from '../modules/source-formatter.js';

describe('source-formatter module', () => {
  it('includes public HTTP and HTTPS source URLs', () => {
    expect(shouldIncludeSourceUrl('https://example.com/article')).toBe(true);
    expect(formatContentWithSource('hello', 'https://example.com/article', 'end'))
      .toBe('hello\n\nSource: https://example.com/article');
  });

  it('does not include localhost or loopback source URLs', () => {
    expect(shouldIncludeSourceUrl('http://localhost:3000/page')).toBe(false);
    expect(shouldIncludeSourceUrl('http://127.0.0.1:8080/page')).toBe(false);
    expect(formatContentWithSource('hello', 'http://127.0.0.1:8080/page', 'end')).toBe('hello');
  });

  it('does not include private network source URLs', () => {
    expect(shouldIncludeSourceUrl('http://192.168.1.10/page')).toBe(false);
    expect(shouldIncludeSourceUrl('http://10.0.0.5/page')).toBe(false);
    expect(shouldIncludeSourceUrl('http://172.16.0.2/page')).toBe(false);
    expect(formatContentWithSource('hello', 'http://192.168.1.10/page', 'beginning')).toBe('hello');
  });

  it('respects explicit none placement', () => {
    expect(formatContentWithSource('hello', 'https://example.com/page', 'none')).toBe('hello');
  });

  it('formats extracted content without local source URLs', () => {
    expect(formatExtractedContentWithSource({
      title: 'Local',
      content: 'body',
      url: 'http://127.0.0.1:8080/page'
    }, 'end')).toBe('[Local]\n\nbody');
  });
});
